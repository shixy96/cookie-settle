import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

async function expectBadge(worker, text, title) {
    const actual = await worker.evaluate(async ({ text }) => {
        const deadline = Date.now() + 5000;
        let result;
        do {
            result = {
                text: await chrome.action.getBadgeText({}),
                title: await chrome.action.getTitle({})
            };
            if (result.text === text) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return result;
    }, { text });
    assert.equal(actual.text, text);
    if (title) assert.match(actual.title, title);
}

test('icon badge counts exact matching paths and follows manual Cookies even with the popup closed', async (t) => {
    const config = configFixture();
    const { page, worker, context, url } = await launchExtension(t, { config });
    await expectBadge(worker, '');
    await page.close();
    await context.route('https://pan.baidu.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Badge regression</title>'
    }));
    const business = await context.newPage();
    await business.goto('https://pan.baidu.com/review/main');
    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=test-main;path=/review/main';
        document.cookie = 'BP_NODE_PROXY_PASS=http://localhost:8001;path=/review/main';
    });
    await expectBadge(worker, '1', /已命中 1 个配置路径/);
    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=test-main;path=/review/preview';
        document.cookie = 'BP_NODE_PROXY_PASS=http://wrong.example;path=/review/preview';
    });
    await expectBadge(worker, '1');
    const panel = await context.newPage();
    await panel.goto(url);
    await panel.locator('#apply-all:not([disabled])').waitFor();
    await panel.locator('#apply-all').click();
    await panel.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await expectBadge(worker, '3', /已命中 3 个配置路径/);
    await panel.locator('.group').filter({ hasText: 'Primary fixture' }).locator('.clear').click();
    await panel.locator('#notice').filter({ hasText: '已清理' }).waitFor();
    await expectBadge(worker, '1');
    await panel.locator('#clear-all').click();
    await panel.locator('#notice').filter({ hasText: '已清理 2 个' }).waitFor();
    await expectBadge(worker, '', /已命中 0 个配置路径/);
});


test('badge marks a failed read as unknown and recovers on the next change', async (t) => {
    const { page, worker } = await launchExtension(t, { config: configFixture() });
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await expectBadge(worker, '3');
    await page.close();
    await worker.evaluate(async () => {
        const original = chrome.cookies.getAll.bind(chrome.cookies);
        globalThis.restoreCookieReads = () => { chrome.cookies.getAll = original; };
        chrome.cookies.getAll = async () => { throw new Error('simulated read failure'); };
        const { config } = await chrome.storage.local.get('config');
        config.groups[0].note = 'Force failed badge refresh';
        await chrome.storage.local.set({ config });
    });
    await expectBadge(worker, '?', /状态读取失败/);
    await worker.evaluate(async () => {
        globalThis.restoreCookieReads();
        const { config } = await chrome.storage.local.get('config');
        config.groups[0].note = 'Force recovered badge refresh';
        await chrome.storage.local.set({ config });
    });
    await expectBadge(worker, '3', /已命中 3 个配置路径/);
});


test('a parent-domain collision removes the match from the badge while the panel is closed', async (t) => {
    const { page, worker, context } = await launchExtension(t, { config: configFixture() });
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await expectBadge(worker, '3');
    await page.close();
    await context.addCookies([{
        name: 'BP_NODE_CONTAINER_ID', value: 'parent-collision',
        domain: '.baidu.com', path: '/review/main', secure: true
    }]);
    await expectBadge(worker, '2');
    await context.clearCookies({ domain: '.baidu.com' });
    await expectBadge(worker, '3');
});
