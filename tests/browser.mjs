import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COOKIE_NAMES } from '../constants.js';
import { DEFAULT_CONFIG } from './default-config.mjs';

const playwright = process.env.PLAYWRIGHT_MODULE ?
    await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) :
    await import('playwright');
const root = process.env.COOKIE_SETTLE_TEST_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'cookie-settle-browser-'));
const output = process.env.TEST_OUTPUT_DIR || join(profile, 'results');
await mkdir(output, { recursive: true });
const groupCount = DEFAULT_CONFIG.groups.length;
const firstPath = DEFAULT_CONFIG.groups[0].paths[0];
const cookieCount = DEFAULT_CONFIG.groups.reduce((sum, group) => sum + group.paths.length * COOKIE_NAMES.length, 0);
const firstGroupCookies = DEFAULT_CONFIG.groups[0].paths.length * COOKIE_NAMES.length;
const errors = [];
const passed = [];
const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 460, height: 700 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});

try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.locator('#apply-all:not([disabled])').waitFor();
    assert.equal(await page.locator('.group').count(), groupCount);
    assert.equal(await page.locator('.group-top .off').count(), groupCount);
    passed.push('MV3 extension loads with all configured default groups');
    assert.deepEqual(
        await page.locator('.group > .group-note').allTextContents(),
        DEFAULT_CONFIG.groups.map((group) => group.note)
    );
    passed.push('Fresh install reads default-config.json including the edited notes');

    async function cookies() {
        return worker.evaluate(() => chrome.cookies.getAll({}));
    }
    async function check() {
        await page.locator('#refresh-status').click();
        await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
        await page.locator('#apply-all:not([disabled])').waitFor();
    }
    async function clickAndWait(selector, text) {
        await page.locator(selector).click();
        await page.locator('#notice').filter({ hasText: text }).waitFor();
        await page.locator('#apply-all:not([disabled])').waitFor();
    }
    async function setCookie(details) {
        return worker.evaluate((data) => chrome.cookies.set(data), details);
    }

    await setCookie({
        url: 'https://pan.baidu.com', name: 'BDUSS', value: 'isolated-test-login',
        path: '/', secure: true, httpOnly: true
    });
    await clickAndWait('#apply-all', `已写入并校验 ${cookieCount} 个`);
    const applied = (await cookies()).filter((item) => COOKIE_NAMES.includes(item.name));
    assert.equal(applied.length, cookieCount);
    assert.ok(applied.every((item) => item.secure && item.session && item.hostOnly));
    assert.equal(await page.locator('.group-top .active').count(), groupCount);
    await page.screenshot({ path: join(output, 'popup.png'), fullPage: true });
    passed.push('Bulk apply sets and verifies all configured real browser Cookies');

    const firstGroup = page.locator('.group').nth(0);
    await firstGroup.getByRole('button', { name: '清理', exact: true }).click();
    await page.locator('#notice').filter({ hasText: `已清理 ${firstGroupCookies} 个` }).waitFor();
    assert.equal((await cookies()).filter((item) => COOKIE_NAMES.includes(item.name)).length, cookieCount - firstGroupCookies);
    assert.equal((await cookies()).find((item) => item.name === 'BDUSS').value, 'isolated-test-login');
    passed.push('Group cleanup preserves other groups and the login Cookie');

    await firstGroup.getByRole('button', { name: '编辑配置' }).click();
    await page.locator('#edit-proxy').fill('http://yq01-sys-rpm-ps10774.yq01.baidu.com:8076');
    await page.locator('#edit-note').fill('Custom note saved in browser storage');
    await page.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    assert.equal((await cookies()).filter((item) => COOKIE_NAMES.includes(item.name)).length, cookieCount - firstGroupCookies);
    await clickAndWait('#apply-all', `已写入并校验 ${cookieCount} 个`);
    assert.equal((await cookies()).find((item) =>
        item.name === COOKIE_NAMES[1] && item.path === firstPath
    ).value.endsWith(':8076'), true);
    passed.push('Editing saves configuration without immediately mutating Cookies');
    await page.reload();
    await page.locator('#apply-all:not([disabled])').waitFor();
    assert.equal(await firstGroup.locator(':scope > .group-note').textContent(), 'Custom note saved in browser storage');
    passed.push('Saved custom configuration takes priority over bundled defaults after reopening');

    await firstGroup.getByRole('button', { name: '编辑配置' }).click();
    await page.locator('#edit-paths').fill(`${firstPath}\n${firstPath}`);
    await page.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
    await page.locator('#edit-error').filter({ hasText: '重复或嵌套' }).waitFor();
    await page.locator('#editor').getByRole('button', { name: '取消', exact: true }).click();
    passed.push('Invalid overlapping paths are rejected in the editor');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    const downloadPath = join(output, 'export.json');
    await download.saveAs(downloadPath);
    const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
    assert.equal(exported.groups[0].proxy.endsWith(':8076'), true);
    assert.ok(!JSON.stringify(exported).includes('isolated-test-login'));
    passed.push('Configuration export is valid JSON and contains no authentication Cookie');

    const imported = structuredClone(exported);
    const existingRoots = new Set(exported.groups.flatMap((group) =>
        group.paths.map((path) => path.split('/')[1])));
    let replacement = '/imported-fixture';
    let suffix = 0;
    while (existingRoots.has(replacement.slice(1))) {
        replacement = `/imported-fixture-${++suffix}`;
    }
    imported.groups[0].paths[0] = replacement;
    await page.locator('#import-file').setInputFiles({
        name: 'config.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(imported))
    });
    await page.locator('#confirm').waitFor({ state: 'visible' });
    await page.locator('#confirm-save').click();
    await page.locator('#confirm').waitFor({ state: 'hidden' });
    await page.locator('#conflicts').filter({ hasText: firstPath }).waitFor();
    await clickAndWait('#clear-all', `已清理 ${cookieCount} 个`);
    assert.equal((await cookies()).filter((item) => COOKIE_NAMES.includes(item.name)).length, 0);
    passed.push('Import preserves historical paths and clear-all removes old-path Cookies');

    await page.locator('#defaults').click();
    await page.locator('#confirm-save').click();
    await page.locator('#confirm').waitFor({ state: 'hidden' });
    await check();
    assert.equal(await page.locator('.group-top .off').count(), groupCount);
    assert.deepEqual(
        await page.locator('.group > .group-note').allTextContents(),
        DEFAULT_CONFIG.groups.map((group) => group.note)
    );
    const restoredConfig = await worker.evaluate(async () => (await chrome.storage.local.get('config')).config);
    assert.deepEqual(restoredConfig, DEFAULT_CONFIG);
    passed.push('Restore defaults loads the same JSON file and restores its notes and values');

    await setCookie({
        url: `https://pan.baidu.com${firstPath}`, name: COOKIE_NAMES[0],
        value: 'domain-variant', domain: '.pan.baidu.com', path: firstPath, secure: true
    });
    await setCookie({
        url: `https://pan.baidu.com${firstPath}`, name: COOKIE_NAMES[0],
        value: 'host-variant', path: firstPath, secure: true
    });
    await check();
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
    assert.equal((await cookies()).filter((item) => COOKIE_NAMES.includes(item.name)).length, 0);
    passed.push('Native Cookies API cleanup handles host-only and domain variants');

    await setCookie({
        url: 'https://pan.baidu.com/', name: COOKIE_NAMES[0],
        value: 'root-conflict', path: '/', secure: true
    });
    await check();
    assert.match(await page.locator('#inventory-list').textContent(), /可用“全部清理”/);
    await clickAndWait('#apply-all', '本次未修改 Cookie');
    assert.equal((await cookies()).filter((item) => COOKIE_NAMES.includes(item.name)).length, 1);
    await clickAndWait('#clear-all', '已清理 1 个');
    assert.equal((await cookies()).some((item) => item.name === COOKIE_NAMES[0]), false);
    passed.push('Root-path conflict blocks apply and can be removed by clear-all without an open business page');

    await context.addCookies([{
        name: COOKIE_NAMES[0], value: 'parent-domain-conflict',
        domain: '.baidu.com', path: firstPath, secure: true
    }]);
    await check();
    await page.locator('#conflicts').filter({ hasText: `.baidu.com${firstPath}` }).waitFor();
    await clickAndWait('#apply-all', '本次未修改 Cookie');
    assert.equal((await cookies()).find((item) => item.domain === '.baidu.com').value, 'parent-domain-conflict');
    await context.clearCookies({ domain: '.baidu.com' });
    passed.push('Parent-domain conflict is detected through scoped extension permissions');

    const invalid = { ...DEFAULT_CONFIG, groups: [] };
    await page.locator('#import-file').setInputFiles({
        name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid))
    });
    await page.locator('#notice').filter({ hasText: '1–12' }).waitFor();
    assert.equal(await page.locator('.group').count(), groupCount);
    passed.push('Invalid imported configuration leaves the saved configuration intact');

    await page.goto(`chrome-extension://${id}/popup.html?view=tab`);
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.locator('#apply-all:not([disabled])').waitFor();
    await page.screenshot({ path: join(output, 'full-page.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 780 });
    assert.equal(await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
    ), true);
    await page.screenshot({ path: join(output, 'narrow.png'), fullPage: true });
    passed.push('Standalone view fits desktop and 360px-wide layouts');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, pageErrors: errors, screenshots: output }, null, 2));
} finally {
    await context.close();
}
