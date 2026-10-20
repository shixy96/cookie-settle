import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

const occurrences = (text, value) => text.split(value).length - 1;

test('expanded groups show shared Cookie configuration once and compact per-path status in every layout', async (t) => {
    const config = configFixture();
    const expected = config.groups[0];
    const { page, url } = await launchExtension(t, { config });
    await page.locator('.group').first().locator('.apply').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(popup ? url.split('?')[0] : url);
        await page.locator('#apply-all:not([disabled])').waitFor();
        const group = page.locator('.group').first();
        await group.locator('summary').click();
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
        const text = await group.innerText();
        for (const value of ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS', expected.container, expected.proxy]) {
            assert.equal(occurrences(text, value), 1, `${value} should appear once at ${width}px`);
        }
        assert.match(text, /共用 Cookie 配置/);
        assert.equal(await group.locator('.paths > li').count(), expected.paths.length);
        assert.equal(await group.locator('.path-row .active').count(), expected.paths.length);
        for (const path of await group.locator('.paths > li').all()) {
            assert.ok(!(await path.innerText()).includes(expected.container));
            assert.ok(!(await path.innerText()).includes(expected.proxy));
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
});


test('a mismatched path shows only the changed Cookie while the matching value remains shared', async (t) => {
    const config = configFixture();
    const { page, worker } = await launchExtension(t, { config });
    const group = page.locator('.group').first();
    await group.locator('.apply').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await worker.evaluate(() => chrome.cookies.set({
        url: 'https://pan.baidu.com/review/main', path: '/review/main', secure: true,
        name: 'BP_NODE_PROXY_PASS', value: 'http://actual.example:9000'
    }));
    await group.locator('.group-top .mixed').waitFor();
    await group.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const path = group.locator('.paths > li').filter({ hasText: '/review/main' });
    const text = await path.innerText();
    assert.ok(!text.includes('BP_NODE_CONTAINER_ID'), 'Matching Cookie should not repeat in path differences');
    assert.match(text, /BP_NODE_PROXY_PASS/);
    assert.match(text, /值不一致/);
    assert.match(text, /http:\/\/actual.example:9000/);
    assert.equal(occurrences(await group.innerText(), config.groups[0].container), 1);
    assert.match(await page.locator('#inventory-list').textContent(), /http:\/\/actual.example:9000/);
});


test('missing Cookie diagnostics remain explicit without repeating the matching counterpart', async (t) => {
    const { page, worker } = await launchExtension(t, { config: configFixture() });
    const group = page.locator('.group').first();
    await group.locator('.apply').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await worker.evaluate(() => chrome.cookies.remove({
        url: 'https://pan.baidu.com/review/main', name: 'BP_NODE_PROXY_PASS'
    }));
    await group.locator('.group-top .mixed').waitFor();
    await group.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const path = group.locator('.paths > li').filter({ hasText: '/review/main' });
    const text = await path.innerText();
    assert.match(text, /缺少 BP_NODE_PROXY_PASS/);
    assert.ok(!text.includes('BP_NODE_CONTAINER_ID'));
    assert.equal(await group.locator('.path-row .active').count(), 1);
});


test('equal Cookie values do not hide distinct Domain or Path conflicts', async (t) => {
    const config = configFixture();
    const { page, worker, context } = await launchExtension(t, { config });
    const group = page.locator('.group').first();
    await group.locator('.apply').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await context.addCookies([{
        name: 'BP_NODE_CONTAINER_ID', value: config.groups[0].container,
        domain: '.baidu.com', path: '/review/main', secure: true
    }]);
    await group.locator('.group-top .mixed').waitFor();
    await group.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const path = group.locator('.paths > li').filter({ has: page.locator('.path-row > code', { hasText: /^\/review\/main$/ }) });
    let text = await path.innerText();
    assert.match(text, /同名冲突/);
    assert.match(text, /Domain：\.baidu\.com/);
    assert.match(text, /Domain：pan\.baidu\.com/);
    assert.match(text, /值与共用配置一致/);
    assert.equal(occurrences(await group.innerText(), config.groups[0].container), 1);
    assert.ok(!text.includes('BP_NODE_PROXY_PASS'));
    await context.clearCookies({ domain: '.baidu.com' });
    await worker.evaluate(() => chrome.cookies.set({
        url: 'https://pan.baidu.com/', path: '/', secure: true,
        name: 'BP_NODE_CONTAINER_ID', value: 'test-main'
    }));
    await path.locator('.difference-scope').filter({ hasText: /Path：\/$/ }).waitFor();
    text = await path.innerText();
    assert.match(text, /Path：\/review\/main/);
    assert.match(text, /Path：\/(?:\n|$)/);
    assert.equal(occurrences(await group.innerText(), config.groups[0].container), 1);
});

test('shared values remain clearly labelled as configuration when Cookies are unset or cleared', async (t) => {
    const config = configFixture();
    const { page } = await launchExtension(t, { config });
    const group = page.locator('.group').first();
    await group.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    for (const cleared of [false, true]) {
        if (cleared) {
            await group.locator('.apply').click();
            await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
            await group.locator('.clear').click();
            await page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
        }
        assert.equal(await group.locator('.path-row .off').count(), config.groups[0].paths.length);
        assert.equal(await group.locator('.path-differences').count(), 0);
        const text = await group.innerText();
        assert.match(text, /共用 Cookie 配置/);
        assert.equal(occurrences(text, config.groups[0].container), 1);
        assert.equal(occurrences(text, config.groups[0].proxy), 1);
    }
});


test('raw Cookie inventory is opt-in and refresh respects the chosen disclosure state', async (t) => {
    const { page } = await launchExtension(t, { config: configFixture() });
    const inventory = page.locator('#cookie-inventory');
    assert.equal(await inventory.evaluate((node) => node.open), false);
    await page.locator('.group').first().locator('.apply').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    assert.equal(await inventory.evaluate((node) => node.open), false);
    for (const open of [true, false]) {
        await inventory.locator('summary').click();
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
        await page.locator('#refresh-status').click();
        await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
        await page.locator('#apply-all:not([disabled])').waitFor();
        assert.equal(await inventory.evaluate((node) => node.open), open);
    }
    assert.match(await page.locator('#inventory-list').textContent(), /Domain：pan.baidu.com/);
    assert.match(await page.locator('#inventory-list').textContent(), /Path：\/review\/main/);
});
