import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension as launch } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

const launchExtension = (t, options) => launch(t, { config: configFixture(), ...options });

test('cleanup actions and the popup shell share a deliberate visual language', async (t) => {
    const { page, url } = await launchExtension(t);
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    const groupClear = page.locator('.group-actions .clear').first();
    const bulkClear = page.locator('#clear-all');
    await groupClear.hover();
    const groupClearStyle = await groupClear.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    });
    await bulkClear.hover();
    const bulkClearStyle = await bulkClear.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    });
    assert.deepEqual(bulkClearStyle, groupClearStyle,
        'Single and bulk cleanup should communicate the same destructive action');
});

test('compact identity keeps the tool, target and counts together without crowding the actions', async (t) => {
    const { context, page, url } = await launchExtension(t);
    for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
        await page.setViewportSize({ width, height: 780 });
        await page.goto(popup ? url.split('?')[0] : url);
        await page.locator('#apply-all:not([disabled])').waitFor();
        const title = page.getByRole('heading', { name: 'Cookie Settle', exact: true });
        const site = page.getByText('pan.baidu.com', { exact: true });
        const counts = page.locator('#counts');
        const top = await title.boundingBox();
        const target = await site.boundingBox();
        const total = await counts.boundingBox();
        const heading = await page.locator('#environments-title').boundingBox();
        assert.ok(heading.y - top.y <= 80,
            `Identity should leave room for configuration controls at ${width}px`);
        assert.ok(Math.max(target.y + target.height, total.y + total.height) - top.y <= 48,
            'Site and counts should be compact metadata beside or below the tool name');
        assert.ok(target.x + target.width <= total.x, 'Site and counts must not overlap');
        for (const locator of [title, site, counts]) {
            assert.equal(await locator.isVisible(), true);
            assert.equal(await locator.evaluate((node) => node.scrollWidth <= node.clientWidth), true,
                'Identity text must remain fully readable');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (popup) {
            const expand = page.getByRole('button', { name: '展开', exact: true });
            const box = await expand.boundingBox();
            assert.ok(total.x + total.width <= box.x, 'Metadata must leave the expand action clear');
            await expand.focus();
            const opened = context.waitForEvent('page');
            await page.keyboard.press('Enter');
            const tab = await opened;
            await tab.waitForURL(url);
            await tab.close();
        }
    }
});

test('popup exposes environment notes and keeps primary actions within its compact viewport', async (t) => {
    const { page, url } = await launchExtension(t);
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    for (const note of await page.locator('.group > .group-note').all()) {
        assert.equal(await note.isVisible(), true, 'Environment notes should not require opening details');
    }
    for (const button of await page.locator('.group-actions button').all()) {
        const box = await button.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 600, 'Environment actions should fit the popup');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= 600),
        'Compact fixture including configuration tools should fit within 600px');
});

test('expanded workspace places live inspection beside environments and stacks on narrow screens', async (t) => {
    const { page } = await launchExtension(t);
    await page.setViewportSize({ width: 1100, height: 900 });
    const groups = await page.locator('#groups').boundingBox();
    const inspector = await page.locator('#live-inspection').boundingBox();
    assert.ok(inspector.x >= groups.x + groups.width, 'Live inspection should sit beside the environment list');
    for (const width of [360, 320]) {
        await page.setViewportSize({ width, height: 780 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('.edit').first().click();
        const dialog = await page.locator('#editor').boundingBox();
        assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width);
        await page.keyboard.press('Escape');
    }
});


test('environment disclosure keeps its trigger and actions anchored when opened and closed', async (t) => {
    const { page, url } = await launchExtension(t);
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    const summary = page.locator('.group > details > summary').first();
    const actions = page.locator('.group-actions').first();
    const before = await summary.boundingBox();
    const actionsBefore = await actions.boundingBox();
    await summary.click();
    await page.locator('.group > details[open]').first().waitFor();
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const opened = await summary.boundingBox();
    assert.ok(Math.abs(opened.x - before.x) <= 1, 'Path trigger should not jump from right to left');
    assert.ok(Math.abs(opened.y - before.y) <= 1, 'Path trigger should stay on the action row');
    assert.deepEqual(await actions.boundingBox(), actionsBefore, 'Opening details should not stretch the actions');
    await summary.click();
    await page.waitForFunction(() => !document.querySelector('.group > details').open);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    assert.deepEqual(await summary.boundingBox(), before);
});


test('disclosures interpolate their height on both opening and closing', async (t) => {
    const { page, url } = await launchExtension(t);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    for (const selector of ['.group > details', '#live-inspection', '#cookie-inventory']) {
        for (const open of [true, false]) {
            const samples = await page.evaluate(async ({ selector, open }) => {
                const details = document.querySelector(selector);
                details.open = !open;
                await new Promise(requestAnimationFrame);
                const heights = [details.getBoundingClientRect().height];
                const summary = details.querySelector('summary');
                const arrow = () => {
                    const matrix = new DOMMatrix(getComputedStyle(summary, '::after').transform);
                    return { angle: Math.atan2(matrix.b, matrix.a), x: matrix.e, y: matrix.f };
                };
                const arrows = [arrow()];
                summary.click();
                const immediate = details.getBoundingClientRect().height;
                const started = performance.now();
                while (performance.now() - started < 350) {
                    await new Promise(requestAnimationFrame);
                    heights.push(details.getBoundingClientRect().height);
                    arrows.push(arrow());
                }
                return { heights, arrows, immediate, open: details.open };
            }, { selector, open });
            const start = samples.heights[0];
            const end = samples.heights.at(-1);
            assert.equal(samples.open, open, `${selector} should finish ${open ? 'opening' : 'closing'}`);
            assert.ok(Math.abs(samples.immediate - start) <= 1, 'The first frame must retain the starting height');
            assert.ok(samples.arrows.some(({ angle }) => Math.abs(angle - samples.arrows[0].angle) > .1 &&
                Math.abs(angle - samples.arrows.at(-1).angle) > .1), 'Arrow rotation must have intermediate angles');
            assert.ok(samples.arrows.every(({ x, y }) => Math.abs(x - samples.arrows[0].x) < .01 &&
                Math.abs(y - samples.arrows[0].y) < .01), 'The rotation center must stay fixed');
            assert.ok(Math.abs(end - start) > 10, `${selector} should change height`);
            assert.ok(samples.heights.some((height) => height > Math.min(start, end) + 1 && height < Math.max(start, end) - 1),
                `${selector} should interpolate instead of snapping ${open ? 'open' : 'closed'}`);
        }
        if (selector === '#live-inspection') {
            await page.locator('#live-summary').click();
            await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        }
    }
});


test('a status response during collapse preserves the last disclosure choice', async (t) => {
    const { page } = await launchExtension(t);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const summary = page.locator('.group > details > summary').first();
    await summary.click();
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let held = false;
        let armed = false;
        document.getElementById('refresh-status').addEventListener('click', () => { armed = true; }, { capture: true, once: true });
        chrome.runtime.sendMessage = async (message) => {
            const response = await send(message);
            if (message.type === 'status' && armed && !held) {
                held = true;
                await new Promise((resolve) => { window.releaseInspection = resolve; });
            }
            return response;
        };
    });
    await page.locator('#refresh-status').click();
    await page.waitForFunction(() => Boolean(window.releaseInspection));
    await page.evaluate(() => {
        document.querySelector('.group > details > summary').click();
        window.releaseInspection();
    });
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    assert.equal(await page.locator('.group > details').first().evaluate((details) => details.open), false,
        'A status update must not reopen a disclosure the user just closed');
});


test('closing a dialog fades out while releasing its modal state immediately', async (t) => {
    const { page } = await launchExtension(t);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.edit').first().click();
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const result = await page.evaluate(async () => {
        const dialog = document.getElementById('editor');
        dialog.querySelector('[data-close]').click();
        const openAfterClose = dialog.open;
        const samples = [];
        const started = performance.now();
        while (performance.now() - started < 300) {
            await new Promise(requestAnimationFrame);
            const style = getComputedStyle(dialog);
            samples.push({ opacity: Number(style.opacity), display: style.display });
        }
        return { openAfterClose, samples };
    });
    assert.equal(result.openAfterClose, false, 'Native modal state should close without waiting for the visual effect');
    assert.ok(result.samples.some(({ opacity, display }) => display !== 'none' && opacity > 0.05 && opacity < 0.95),
        'Closing should fade the dialog instead of abruptly removing it');
    assert.equal(result.samples.at(-1).display, 'none');
});


test('scrollbar appearance does not shift the workspace or dialog fields', async (t) => {
    const { page, url } = await launchExtension(t, { showScrollbars: true });
    for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(popup ? url.split('?')[0] : url);
        await page.locator('#apply-all:not([disabled])').waitFor();
        // Force space-taking scrollbars even on hosts configured for overlay scrollbars.
        await page.addStyleTag({ content: '::-webkit-scrollbar { width: 12px; height: 12px; }' });
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        const contentHeight = await page.locator('.workspace').evaluate((node) => node.getBoundingClientRect().bottom);
        await page.setViewportSize({ width, height: Math.ceil(contentHeight) + 8 });
        const before = await page.locator('#groups').boundingBox();
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
        await page.evaluate(() => document.querySelectorAll('.group > details > summary').forEach((summary) => summary.click()));
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        const after = await page.locator('#groups').boundingBox();
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), true);
        assert.equal(after.x, before.x, `Scrollbar must not move the workspace at ${width}px`);
        assert.equal(after.width, before.width, `Scrollbar must not resize the workspace at ${width}px`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
            `Scrollbar must not cause horizontal overflow at ${width}px`);
        await page.evaluate(() => document.querySelectorAll('.group > details > summary').forEach((summary) => summary.click()));
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        const collapsed = await page.locator('#groups').boundingBox();
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
        assert.equal(collapsed.x, before.x, `Scrollbar removal must not move the workspace at ${width}px`);
        assert.equal(collapsed.width, before.width, `Scrollbar removal must not resize the workspace at ${width}px`);
    }
    await page.setViewportSize({ width: 1100, height: 1100 });
    await page.locator('.edit').first().click();
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const field = page.locator('#edit-name');
    const before = await field.boundingBox();
    assert.equal(await page.locator('#editor').evaluate((dialog) => dialog.scrollHeight > dialog.clientHeight), false);
    await page.locator('#edit-paths').evaluate((textarea) => { textarea.style.height = '1200px'; });
    assert.equal(await page.locator('#editor').evaluate((dialog) => dialog.scrollHeight > dialog.clientHeight), true);
    const after = await field.boundingBox();
    assert.equal(after.x, before.x, 'An internal scrollbar must not move the form');
    assert.equal(after.width, before.width, 'An internal scrollbar must not resize form fields');
});


test('disclosures support keyboard, rapid reversal and reduced motion without clipping', async (t) => {
    const { page } = await launchExtension(t);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const summary = page.locator('.group > details > summary').first();
    const details = page.locator('.group > details').first();
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    assert.equal(await details.evaluate((node) => node.open), true);
    const reversal = await details.evaluate(async (node) => {
        const trigger = node.querySelector('summary');
        trigger.click();
        const started = performance.now();
        while (performance.now() - started < 50) await new Promise(requestAnimationFrame);
        const before = node.getBoundingClientRect().height;
        trigger.click();
        return { before, after: node.getBoundingClientRect().height };
    });
    assert.ok(Math.abs(reversal.after - reversal.before) <= 1, 'Reversal should continue from the visible height');
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    assert.equal(await details.evaluate((node) => node.open), true);
    assert.equal(await details.evaluate((node) => getComputedStyle(node).overflow), 'visible');
    await summary.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('.group > details').open);
    assert.equal(await summary.evaluate((node) => document.activeElement === node), true);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await summary.press('Enter');
    assert.equal(await details.evaluate((node) => node.open), true);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await summary.press('Space');
    assert.equal(await details.evaluate((node) => node.open), false);
    await page.locator('.edit').first().click();
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.locator('#editor [data-close]').first().click();
    assert.equal(await page.locator('#editor').isVisible(), false);
});


for (const control of ['summary', '.apply', '.clear', '.edit']) {
    test(`automatic refresh preserves ${control} focus and expansion by group id across reorder`, async (t) => {
        const { page, worker } = await launchExtension(t);
        const group = page.locator('.group').filter({ has: page.getByRole('heading', { name: 'Secondary', exact: true }) });
        await group.locator('summary').click();
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
        await group.locator(control).focus();
        const config = configFixture();
        config.groups.reverse();
        config.groups[0].note = 'Reordered externally';
        await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
        await page.locator('.group').first().locator('.group-note').filter({ hasText: 'Reordered externally' }).waitFor();
        await page.locator('#apply-all:not([disabled])').waitFor();
        assert.equal(await group.locator(control).evaluate((node) => document.activeElement === node), true);
        assert.equal(await group.locator('details').evaluate((node) => node.open), true);
        assert.equal(await page.locator('.group').nth(1).locator('details').evaluate((node) => node.open), false);

        await worker.evaluate(() => chrome.cookies.set({
            url: 'https://pan.baidu.com/review/other', path: '/review/other',
            name: 'BP_NODE_CONTAINER_ID', value: 'test-other'
        }));
        await group.locator('.group-top .mixed').waitFor();
        await page.locator('#apply-all:not([disabled])').waitFor();
        assert.equal(await group.locator(control).evaluate((node) => document.activeElement === node), true);
        assert.equal(await group.locator('details').evaluate((node) => node.open), true);
    });
}


test('long configuration names keep status badges aligned to the first line without overlapping actions', async (t) => {
    const config = configFixture();
    config.groups[0].name = '用于验证长配置名称换行后状态标签对齐'.repeat(3);
    config.groups[0].note = 'A long description for a reusable configuration. '.repeat(6);
    const { page } = await launchExtension(t, { config });
    for (const width of [320, 460, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        const group = page.locator('.group').first();
        const heading = await group.locator('h3').boundingBox();
        const status = await group.locator('.group-top .state').boundingBox();
        assert.ok(Math.abs(status.y - heading.y) <= 3, `Status should align to the first line at ${width}px`);
        const actions = await group.locator('.group-actions').boundingBox();
        const summary = await group.locator('summary').boundingBox();
        assert.ok(summary.x >= actions.x + actions.width, `Actions and disclosure must not overlap at ${width}px`);
        assert.ok(Math.abs((summary.y + summary.height / 2) - (actions.y + actions.height / 2)) <= 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
});


test('removing the focused group uses a safe focus fallback', async (t) => {
    const { page, worker } = await launchExtension(t);
    await page.locator('.group').nth(1).locator('.clear').focus();
    const config = configFixture();
    config.groups.pop();
    await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    await page.waitForFunction(() => document.querySelectorAll('.group').length === 1 &&
        !document.getElementById('apply-all').disabled);
    assert.equal(await page.locator('#apply-all').evaluate((node) => document.activeElement === node), true);
});

test('an in-flight refresh does not steal focus moved outside the group list', async (t) => {
    const { page, worker } = await launchExtension(t);
    await page.locator('.group').first().locator('.clear').focus();
    await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let hold = true;
        chrome.runtime.sendMessage = async (message) => {
            const response = await send(message);
            if (message.type === 'status' && hold) {
                hold = false;
                await new Promise((resolve) => { window.releaseFocusCheck = resolve; });
            }
            return response;
        };
    });
    const config = configFixture();
    config.groups[0].note = 'Focus moved during refresh';
    await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    await page.waitForFunction(() => Boolean(window.releaseFocusCheck));
    await page.locator('#live-summary').focus();
    await page.evaluate(() => window.releaseFocusCheck());
    await page.locator('.group-note').filter({ hasText: 'Focus moved during refresh' }).waitFor();
    await page.locator('#apply-all:not([disabled])').waitFor();
    assert.equal(await page.locator('#live-summary').evaluate((node) => document.activeElement === node), true);
});


for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
    test(`status markers share the rail center and the title first-line center at ${width}px`, async (t) => {
        const config = configFixture();
        config.groups[0].name = '用于验证标题换行时左侧状态框的位置'.repeat(3);
        const { page, url } = await launchExtension(t, { config });
        await page.setViewportSize({ width, height: 900 });
        if (popup) await page.goto(url.split('?')[0]);
        await page.locator('#apply-all:not([disabled])').waitFor();
        for (const expanded of [false, true]) {
            if (expanded) {
                await page.locator('.group').first().locator('summary').click();
                await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
            }
            const alignment = await page.evaluate(() => {
                function center(node, pseudo) {
                    const style = getComputedStyle(node, pseudo);
                    const parent = node.getBoundingClientRect();
                    const parentStyle = getComputedStyle(node);
                    const transform = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
                    const borderBox = style.boxSizing === 'border-box';
                    const width = parseFloat(style.width) + (borderBox ? 0 :
                        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth));
                    const height = parseFloat(style.height) + (borderBox ? 0 :
                        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth));
                    return {
                        x: parent.x + parseFloat(parentStyle.borderLeftWidth) + parseFloat(style.left) + transform.m41 + width / 2,
                        y: parent.y + parseFloat(parentStyle.borderTopWidth) + parseFloat(style.top) + transform.m42 + height / 2
                    };
                }
                const rail = center(document.getElementById('groups'), '::before');
                return [...document.querySelectorAll('.group')].map((group) => {
                    const marker = center(group, '::before');
                    const title = group.querySelector('h3');
                    const titleCenter = title.getBoundingClientRect().y + parseFloat(getComputedStyle(title).lineHeight) / 2;
                    return { horizontalError: marker.x - rail.x, verticalError: marker.y - titleCenter };
                });
            });
            for (const result of alignment) {
                assert.ok(Math.abs(result.horizontalError) <= 0.5,
                    `Marker and rail centers differ by ${result.horizontalError}px`);
                assert.ok(Math.abs(result.verticalError) <= 0.5,
                    `Marker and title centers differ by ${result.verticalError}px`);
            }
        }
    });
}


test('soft blue and green controls retain readable text in normal and hover states', async (t) => {
    const { page } = await launchExtension(t);
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验' }).waitFor();
    await page.mouse.move(0, 0);
    for (const selector of ['#apply-all', '.group-actions .apply', '.group-top .active']) {
        for (const hover of [false, true]) {
            if (hover) await page.locator(selector).first().hover();
            else await page.mouse.move(0, 0);
            await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
            const ratio = await page.locator(selector).first().evaluate((node) => {
                const style = getComputedStyle(node);
                function luminance(color) {
                    const values = color.match(/[\d.]+/g).slice(0, 3).map((part) => Number(part) / 255)
                        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
                    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
                }
                const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
                return (values[1] + 0.05) / (values[0] + 0.05);
            });
            assert.ok(ratio >= 4.5, `${selector} ${hover ? 'hover' : 'normal'} contrast is ${ratio.toFixed(2)}`);
        }
    }
});


test('group separators align with content and leave the status rail uninterrupted', async (t) => {
    const { page, url } = await launchExtension(t);
    for (const [width, popup] of [[460, true], [1100, false], [320, false]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(popup ? url.split('?')[0] : url);
        await page.locator('#apply-all:not([disabled])').waitFor();
        const result = await page.locator('.group').nth(1).evaluate((group) => {
            const separator = getComputedStyle(group, '::after');
            const marker = getComputedStyle(group, '::before');
            return { content: separator.content, left: parseFloat(separator.left), right: parseFloat(separator.right),
                titleLeft: group.querySelector('h3').getBoundingClientRect().left - group.getBoundingClientRect().left,
                rail: parseFloat(marker.left), border: parseFloat(getComputedStyle(group).borderTopWidth) };
        });
        assert.notEqual(result.content, 'none', 'A separate inset rule should replace the full-width border');
        assert.ok(result.left >= result.rail + 8, 'The rule must leave breathing room beside the rail');
        assert.ok(Math.abs(result.left - result.titleLeft) <= 1, 'The rule should align with the text column');
        assert.ok(result.right >= 8, 'The rule must leave a right inset');
        assert.equal(result.border, 0, 'No full-width border should cross the rail');
    }
});
