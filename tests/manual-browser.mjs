import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const playwright = process.env.PLAYWRIGHT_MODULE ?
    await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'cookie-settle-manual-'));
const output = process.env.TEST_OUTPUT_DIR || join(profile, 'results');
await mkdir(output, { recursive: true });
const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    viewport: { width: 460, height: 700 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const passed = [];
const errors = [];

try {
    // Keep the real HTTPS origin and browser Cookie behavior, but intercept all
    // business traffic. These are isolated test pages, never a logged-in site.
    await context.route('https://pan.baidu.com/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!doctype html><title>Manual Cookie test</title><p>Isolated test page</p>'
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    // This manual-page scenario owns its cleanup scope, independently of bundled presets.
    await worker.evaluate(() => chrome.storage.local.set({ managedPaths: ['/disk/cert'] }));
    const extensionUrl = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
    const business = await context.newPage();
    await business.goto('https://pan.baidu.com/disk/cert/deep/test?irrelevant=1#section');
    const sibling = await context.newPage();
    await sibling.goto('https://pan.baidu.com/disk/certificates/test');
    const panel = await context.newPage();
    panel.on('pageerror', (error) => errors.push(error.message));
    await panel.goto(extensionUrl);
    await panel.locator('#apply-all:not([disabled])').waitFor();

    async function check() {
        await panel.locator('#refresh-status').click();
        await panel.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
        await panel.locator('#apply-all:not([disabled])').waitFor();
    }
    async function pageState(path, expected) {
        await panel.waitForFunction(({ path, expected }) => {
            const row = [...document.querySelectorAll('.live-page')].find((item) => item.dataset.path === path);
            return row?.querySelector('.state')?.classList.contains(expected);
        }, { path, expected });
    }
    async function inventoryHas(value) {
        await panel.waitForFunction((text) =>
            document.getElementById('inventory-list').textContent.includes(text), value);
    }
    const path = '/disk/cert/deep/test';
    await check();
    await pageState(path, 'off');

    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=manual-console-container; path=/disk/cert; secure';
        document.cookie = 'BP_NODE_PROXY_PASS=http://manual.example:8075; path=/disk/cert; secure';
        document.cookie = 'BDUSS=isolated-login-cookie; path=/; secure';
    });
    // No explicit refresh here: verify cookie-change notifications as well.
    await pageState(path, 'present');
    await inventoryHas('manual-console-container');
    await pageState('/disk/certificates/test', 'off');
    assert.ok(!(await panel.locator('#inventory-list').textContent()).includes('isolated-login-cookie'));
    const stored = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.equal(stored.config, undefined);
    assert.ok(stored.managedPaths.includes('/disk/cert'));
    passed.push('document.cookie writes are visible without applying an environment or saving custom config');
    passed.push('Cookie changes automatically refresh while preserving path boundaries and login privacy');

    await business.evaluate(() => {
        document.cookie = 'BP_NODE_PROXY_PASS=; path=/disk/cert; Max-Age=0; secure';
    });
    await pageState(path, 'partial');
    passed.push('Manual deletion updates the page state to missing one Cookie');

    await panel.goto('about:blank');
    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=changed-while-closed; path=/disk/cert; secure';
    });
    await panel.goto(extensionUrl);
    await panel.locator('#apply-all:not([disabled])').waitFor();
    await check();
    await inventoryHas('changed-while-closed');
    passed.push('Reopening reads current browser Cookies rather than earlier extension state');

    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=; path=/disk/cert; Max-Age=0; secure';
        document.cookie = 'BP_NODE_CONTAINER_ID=manual-default-path; secure';
    });
    await pageState(path, 'partial');
    await inventoryHas('manual-default-path');
    assert.ok((await panel.locator('#inventory-list').textContent()).includes('Path：/disk/cert/deep'));
    await pageState('/disk/certificates/test', 'off');
    passed.push('Cookies set without Path on a deeper page appear in the real inventory and page check');

    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=manual-parent-root; Domain=baidu.com; path=/; secure';
    });
    await pageState(path, 'conflict');
    await inventoryHas('manual-parent-root');
    assert.ok((await panel.locator('#inventory-list').textContent()).includes('Domain：.baidu.com'));
    await pageState('/disk/certificates/test', 'partial');
    passed.push('Root and parent-domain manual Cookies are shown and duplicate-name conflicts are detected');

    await panel.locator(`.live-page[data-path="${path}"] > summary`).click();
    await panel.screenshot({ path: join(output, 'manual-page-check.png'), fullPage: true });
    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=; Domain=baidu.com; path=/; Max-Age=0; secure';
        document.cookie = 'BP_NODE_CONTAINER_ID=; path=/disk/cert/deep; Max-Age=0; secure';
    });
    await pageState(path, 'off');
    await worker.evaluate(() => chrome.cookies.set({
        url: 'https://pan.baidu.com/disk/cert/deep/test',
        name: 'BP_NODE_PROXY_PASS', value: 'http-only-test',
        path: '/disk/cert/deep', httpOnly: true, secure: true
    }));
    assert.ok(!(await business.evaluate(() => document.cookie)).includes('http-only-test'));
    await inventoryHas('http-only-test');
    await pageState(path, 'partial');
    assert.ok((await panel.locator('#inventory-list').textContent()).includes('HttpOnly'));
    passed.push('Checks include HttpOnly Cookies even when document.cookie cannot read them');

    await business.goto('https://pan.baidu.com/disk/main');
    await panel.waitForFunction(() =>
        [...document.querySelectorAll('.live-page')].some((row) => row.dataset.path === '/disk/main'));
    await pageState('/disk/main', 'off');
    await business.close();
    await sibling.close();
    await panel.waitForFunction(() => document.querySelectorAll('.live-page').length === 0);
    await inventoryHas('http-only-test');
    passed.push('Page navigation and closure update the list while unopened-path Cookies remain visible');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, pageErrors: errors, screenshots: output }, null, 2));
} finally {
    await context.close();
}
