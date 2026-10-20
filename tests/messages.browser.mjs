import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';

test('operation messages float at the top right without moving content or adding scrollbars', async (t) => {
    const { page, url } = await launchExtension(t, { showScrollbars: true });
    for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
        await page.setViewportSize({ width, height: popup ? 600 : 900 });
        await page.goto(popup ? url.split('?')[0] : url);
        await page.locator('#clear-all:not([disabled])').waitFor();
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        const before = await page.locator('.workbench').boundingBox();
        const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.locator('#clear-all').click();
        await page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
        assert.deepEqual(await page.locator('.workbench').boundingBox(), before,
            'A message should not push the environment list down');
        const message = await page.locator('#notice').boundingBox();
        assert.ok(message.y >= 0 && message.y <= 20, 'Message should sit at the top');
        assert.ok(message.x >= 0 && message.x + message.width <= width, 'Message should fit the viewport');
        assert.ok(width - (message.x + message.width) <= 36, 'Message should align to the right');
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), heightBefore);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const buttonReceivesPointer = await page.locator('#expand').evaluate((button) => {
            if (button.hidden) return true;
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        assert.equal(buttonReceivesPointer, true, 'Message should not block the controls underneath');
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        assert.ok((await page.locator('#notice').boundingBox()).y <= 20, 'Message should stay visible when the page scrolls');
    }
});


test('operation message disappears after three seconds without shifting content', async (t) => {
    const { page } = await launchExtension(t);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const before = await page.locator('.workbench').boundingBox();
    await page.locator('#clear-all').click();
    const notice = page.locator('#notice');
    await notice.filter({ hasText: '已清理' }).waitFor();
    await page.waitForTimeout(2600);
    assert.equal(await notice.isVisible(), true, 'Message should remain visible until its dismissal time');
    await notice.waitFor({ state: 'hidden', timeout: 1200 });
    assert.deepEqual(await page.locator('.workbench').boundingBox(), before);
});


test('a newer error message gets its own three seconds instead of the previous timer', async (t) => {
    const { page, worker } = await launchExtension(t);
    await page.locator('#clear-all').click();
    const notice = page.locator('#notice');
    await notice.filter({ hasText: '已清理' }).waitFor();
    await page.waitForTimeout(2000);
    await worker.evaluate(() => {
        chrome.storage.local.set = async () => { throw new Error('notification timer fixture'); };
    });
    await page.locator('#clear-all').click();
    await notice.filter({ hasText: 'notification timer fixture' }).waitFor();
    assert.equal(await page.locator('#notice.error').count(), 1);
    await page.waitForTimeout(1300);
    assert.equal(await notice.isVisible(), true, 'The previous message timer must not dismiss the new error');
    await notice.waitFor({ state: 'hidden', timeout: 2300 });
});
