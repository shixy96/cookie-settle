import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

test('expanded popup remains wheel-scrollable so footer actions can be reached', async (t) => {
    const { page, url } = await launchExtension(t, { config: configFixture(), showScrollbars: true });
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    await page.locator('.group summary').first().click();
    await page.waitForFunction(() => document.scrollingElement.scrollHeight > innerHeight);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => scrollY > 0);
    const button = await page.locator('#reload-tabs').boundingBox();
    assert.ok(button.y >= 0 && button.y + button.height <= 600, 'Footer must be reachable by scrolling');
});

test('live inspection removes a tab after it navigates outside the configured host', async (t) => {
    const { context, page } = await launchExtension(t, { config: configFixture() });
    await context.route(/https:\/\/(pan\.baidu\.com|outside\.example)\//, (route) => route.fulfill({
        contentType: 'text/html', body: '<title>Isolated navigation fixture</title>'
    }));
    const business = await context.newPage();
    await business.goto('https://pan.baidu.com/review/main');
    await page.locator('.live-page').waitFor();
    await business.goto('https://outside.example/');
    await page.waitForFunction(() => document.querySelectorAll('.live-page').length === 0);
    assert.match(await page.locator('#page-checks').textContent(), /打开目标站点页面/);
});

test('saving an edited group restores keyboard focus to its edit control', async (t) => {
    const { page } = await launchExtension(t, { config: configFixture() });
    const opener = page.locator('.group[data-id="secondary"] .edit');
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.locator('#edit-note').fill('Saved through keyboard');
    await page.locator('#editor button[type="submit"]').click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    await page.locator('#apply-all:not([disabled])').waitFor();
    assert.equal(await opener.evaluate((node) => document.activeElement === node), true);
});

for (const action of ['save', 'cancel']) {
    test(`configuration confirmation restores its opener after ${action}`, async (t) => {
        const { page } = await launchExtension(t, { config: configFixture() });
        await page.locator('#defaults').click();
        await page.locator('#confirm[open]').waitFor();
        await page.locator(action === 'save' ? '#confirm-save' : '#confirm [data-close]').first().click();
        await page.locator('#confirm').waitFor({ state: 'hidden' });
        await page.locator('#apply-all:not([disabled])').waitFor();
        assert.equal(await page.locator('#defaults').evaluate((node) => document.activeElement === node), true);
    });
}
