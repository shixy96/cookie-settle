import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

async function setup(t) {
    const app = await launchExtension(t, { config: configFixture() });
    await app.context.route('https://pan.baidu.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Effective Cookie cleanup</title>'
    }));
    app.business = await app.context.newPage();
    await app.business.goto('https://pan.baidu.com/review/main/deep/child');
    return app;
}

async function seed(worker, entries) {
    await worker.evaluate(async (entries) => {
        for (const entry of entries) {
            await chrome.cookies.set({ url: `https://pan.baidu.com${entry.path}`, secure: false, ...entry });
        }
    }, entries);
}

async function clear(page, selector, count) {
    await page.locator(selector).click();
    await page.locator('#notice').filter({ hasText: `已清理 ${count} 个` }).waitFor();
    await page.locator('#clear-all:not([disabled])').waitFor();
}

test('clear-all removes effective ancestors and open-page Cookies while group cleanup stays scoped', async (t) => {
    const { worker, page } = await setup(t);
    const container = 'BP_NODE_CONTAINER_ID';
    const proxy = 'BP_NODE_PROXY_PASS';
    await worker.evaluate(() => chrome.storage.local.set({ managedPaths: ['/archive/old'] }));
    await seed(worker, [
        { name: container, value: 'root-container', path: '/' },
        { name: proxy, value: 'http://root.example', path: '/' },
        { name: container, value: 'ancestor', path: '/review' },
        { name: proxy, value: 'http://domain.example', path: '/review', domain: '.pan.baidu.com' },
        { name: proxy, value: 'http://deep.example', path: '/review/main/deep' },
        { name: container, value: 'exact', path: '/review/main' },
        { name: container, value: 'historical-ancestor', path: '/archive' },
        { name: container, value: 'unrelated', path: '/unrelated' },
        { name: proxy, value: 'sibling', path: '/review/main-sibling' },
        { name: 'BDUSS', value: 'preserve-login', path: '/' }
    ]);
    const seeded = await worker.evaluate(() => chrome.cookies.getAll({}));
    assert.equal(seeded.length, 10, JSON.stringify(seeded.map(({ name, value, path }) => ({ name, value, path }))));
    await page.locator('#refresh-status').click();
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    await clear(page, '.group .clear >> nth=0', 1);
    const afterGroup = await worker.evaluate(() => chrome.cookies.getAll({}));
    assert.equal(afterGroup.length, 9, JSON.stringify(afterGroup.map(({ name, value, path }) => ({ name, value, path }))));
    await clear(page, '#clear-all', 6);
    const remaining = await worker.evaluate(() => chrome.cookies.getAll({}));
    assert.deepEqual(remaining.map((cookie) => cookie.value).sort(), ['preserve-login', 'sibling', 'unrelated']);
    assert.match(await page.locator('#notice').textContent(), /已清理 6 个/);
    const history = await worker.evaluate(async () => (await chrome.storage.local.get('managedPaths')).managedPaths);
    assert.equal(history.includes('/'), false, 'Discovered root paths must not become persisted configuration');
});

test('inventory and apply guidance identify effective Cookies that clear-all can remove', async (t) => {
    const { worker, page } = await setup(t);
    await seed(worker, [
        { name: 'BP_NODE_CONTAINER_ID', value: 'root-container', path: '/' },
        { name: 'BP_NODE_PROXY_PASS', value: 'deep-proxy', path: '/review/main/deep' },
        { name: 'BP_NODE_CONTAINER_ID', value: 'unrelated-container', path: '/unrelated' }
    ]);
    await page.locator('#refresh-status').click();
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    for (const value of ['root-container', 'deep-proxy']) {
        assert.match(await page.locator('.inventory-item').filter({ hasText: value }).textContent(), /可用“全部清理”/);
    }
    assert.match(await page.locator('.inventory-item').filter({ hasText: 'unrelated-container' }).textContent(), /不在清理范围/);
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '本次未修改 Cookie' }).waitFor();
    assert.match(await page.locator('#notice').textContent(), /全部清理/);
});

test('failed effective cleanup restores previously expired Cookies and their attributes', async (t) => {
    const { worker, page } = await setup(t);
    await seed(worker, [
        { name: 'BP_NODE_CONTAINER_ID', value: 'root', path: '/', httpOnly: true, secure: true,
            sameSite: 'strict', expirationDate: 2000000000 },
        { name: 'BP_NODE_PROXY_PASS', value: 'http://ancestor.example', path: '/review',
            domain: '.pan.baidu.com', httpOnly: true, secure: false },
        { name: 'BDUSS', value: 'preserve-login', path: '/' }
    ]);
    const before = await worker.evaluate(() => chrome.cookies.getAll({}));
    await worker.evaluate(() => {
        const set = chrome.cookies.set.bind(chrome.cookies);
        globalThis.expiredPaths = [];
        chrome.cookies.set = async (details) => {
            if (details.expirationDate === 0 && details.path === '/') throw new Error('root expiry denied');
            const result = await set(details);
            if (details.expirationDate === 0) globalThis.expiredPaths.push(details.path);
            return result;
        };
    });
    await page.locator('#clear-all').click();
    await page.locator('#notice.error').filter({ hasText: 'root expiry denied' }).waitFor();
    assert.match(await page.locator('#notice').textContent(), /已恢复操作前/);
    assert.deepEqual(await worker.evaluate(() => globalThis.expiredPaths), ['/review']);
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), before);
});

test('a parent-domain collision at the root blocks effective cleanup before any deletion', async (t) => {
    const { worker, page } = await setup(t);
    await seed(worker, [
        { name: 'BP_NODE_CONTAINER_ID', value: 'protected-parent', domain: '.baidu.com', path: '/', secure: true },
        { name: 'BP_NODE_CONTAINER_ID', value: 'root', path: '/' },
        { name: 'BP_NODE_PROXY_PASS', value: 'http://ancestor.example', path: '/review' }
    ]);
    const before = await worker.evaluate(() => chrome.cookies.getAll({}));
    await page.locator('#clear-all').click();
    await page.locator('#notice.error').filter({ hasText: '父域同名 Cookie' }).waitFor();
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), before);
});
