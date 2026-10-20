import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

test('HTTP and HTTPS inspections keep separate labels, expansion and focus through refresh', async (t) => {
    const { page, context, worker } = await launchExtension(t, { config: configFixture() });
    await context.route(/https?:\/\/pan\.baidu\.com\//, (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Inspection fixture</title>'
    }));
    for (const protocol of ['https:', 'http:']) {
        const business = await context.newPage();
        await business.goto(`${protocol}//pan.baidu.com/review/main`);
    }
    await page.waitForFunction(() => document.querySelectorAll('.live-page').length === 2);
    await page.locator('#apply-all:not([disabled])').waitFor();
    const rows = page.locator('.live-page');
    await rows.first().locator('summary').click();
    await page.locator('#refresh-status').click();
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.open)), [true, false],
        'Refreshing one expanded origin must not expand the other origin');
    assert.deepEqual((await rows.locator('summary code').allTextContents()).sort(),
        ['http://pan.baidu.com/review/main', 'https://pan.baidu.com/review/main']);
    const summary = rows.first().locator('summary');
    await summary.focus();
    await worker.evaluate(() => chrome.cookies.set({
        url: 'https://pan.baidu.com/review/main', path: '/review/main', secure: true,
        name: 'BP_NODE_CONTAINER_ID', value: 'test-main'
    }));
    await rows.first().locator('.partial').waitFor();
    assert.equal(await summary.evaluate((node) => node === document.activeElement), true,
        'Automatic Cookie refresh must retain keyboard focus on the same page');
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.open)), [true, false]);
});
