import test from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

async function setup(t) {
    const app = await launchExtension(t, { config: configFixture() });
    await app.context.route(/https?:\/\/pan\.baidu\.com\//, (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Page indicator</title>'
    }));
    app.business = await app.context.newPage();
    await app.business.goto('https://pan.baidu.com/review/main?x=1#/folder');
    app.tabId = await app.worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://pan.baidu.com/*' }))[0].id);
    return app;
}

async function expectTitle(worker, tabId, pattern) {
    const title = await worker.evaluate(async ({ tabId, source }) => {
        const pattern = new RegExp(source);
        const deadline = Date.now() + 5000;
        let title;
        do {
            title = await chrome.action.getTitle({ tabId });
            if (pattern.test(title)) return title;
            await new Promise((resolve) => setTimeout(resolve, 30));
        } while (Date.now() < deadline);
        return title;
    }, { tabId, source: pattern.source });
    assert.match(title, pattern);
    return title;
}

async function setPair(page, proxy = 'http://localhost:8001', path = '/review/main') {
    await page.evaluate(({ proxy, path }) => {
        document.cookie = `BP_NODE_CONTAINER_ID=test-main;path=${path}`;
        document.cookie = `BP_NODE_PROXY_PASS=${proxy};path=${path}`;
    }, { proxy, path });
}

test('current page follows actual Cookies while global numeric badge remains intact', async (t) => {
    const { worker, page, business, tabId } = await setup(t);
    await page.close();
    await expectTitle(worker, tabId, /Primary.*尚未设置 Cookie.*全部配置已匹配 0 条路径/);
    await setPair(business);
    await expectTitle(worker, tabId, /Primary.*Cookie 与配置一致.*全部配置已匹配 1 条路径/);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '1');
    assert.equal(await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), '1');
    await business.evaluate(() => {
        for (const name of ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS']) {
            document.cookie = `${name}=;path=/review/main;max-age=0`;
        }
    });
    await expectTitle(worker, tabId, /Primary.*尚未设置 Cookie.*全部配置已匹配 0 条路径/);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
    await business.goto('https://pan.baidu.com/review/main-sibling');
    await expectTitle(worker, tabId, /未命中配置/);
});

test('hover explains missing values, mismatches and descendant scope conflicts', async (t) => {
    const { worker, business, tabId, context } = await setup(t);
    await business.evaluate(() => { document.cookie = 'BP_NODE_CONTAINER_ID=test-main;path=/review/main'; });
    await expectTitle(worker, tabId, /缺少 Cookie：BP_NODE_PROXY_PASS/);
    await setPair(business, 'http://wrong.example');
    await expectTitle(worker, tabId, /值不一致：BP_NODE_PROXY_PASS/);
    await setPair(business);
    await business.goto('https://pan.baidu.com/review/main/deep');
    await expectTitle(worker, tabId, /Cookie 与配置一致/);
    await business.evaluate(() => { document.cookie = 'BP_NODE_CONTAINER_ID=test-main;path=/review/main/deep'; });
    await expectTitle(worker, tabId, /同名冲突：BP_NODE_CONTAINER_ID/);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '1',
        'A descendant conflict changes this page without erasing the valid configured parent path');
    await business.goto('https://pan.baidu.com/review/main');
    await expectTitle(worker, tabId, /Cookie 与配置一致/);
    await context.clearCookies();
    await setPair(business, 'http://localhost:8001', '/');
    await expectTitle(worker, tabId, /Cookie 与配置一致.*Path=\//);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '',
        'The existing numeric badge still counts exact configured paths');
});

test('toolbar keeps the logo and numeric badge while changing only the upper-left dot color', async (t) => {
    const { worker, business, tabId, context } = await setup(t);
    await worker.evaluate(() => {
        globalThis.iconSamples = {};
        const setIcon = chrome.action.setIcon.bind(chrome.action);
        chrome.action.setIcon = async (details) => {
            if (details.tabId) {
                globalThis.iconSamples[details.tabId] = Object.fromEntries(
                    Object.entries(details.imageData).map(([size, image]) => [size, Array.from(image.data)]));
            }
            return setIcon(details);
        };
    });
    async function expectDot(color, title) {
        await expectTitle(worker, tabId, title);
        const samples = await worker.evaluate((tabId) => globalThis.iconSamples[tabId], tabId);
        assert.ok(samples, 'The action API should receive the current page icon');
        assert.deepEqual(Object.keys(samples).sort(), ['16', '32']);
        const original = await worker.evaluate(async () => {
            const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/32.png'))).blob());
            const canvas = new OffscreenCanvas(32, 32);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            return Array.from(ctx.getImageData(0, 0, 32, 32).data);
        });
        if (!color) {
            for (const size of [16, 32]) {
                const pixels = samples[size];
                const center = (Math.floor(size * .2734375) * size + Math.floor(size * .765625)) * 4;
                const background = (Math.floor(size / 2) * size + Math.floor(size * .9)) * 4;
                assert.deepEqual(pixels.slice(center, center + 4), pixels.slice(background, background + 4),
                    'An unmatched page must erase the decorative green dot, not restore it from the source logo');
            }
            return;
        }
        const offset = (6 * 32 + 6) * 4;
        assert.deepEqual(samples['32'].slice(offset, offset + 3), color, 'The state dot belongs in the upper-left corner');
        assert.deepEqual(samples['32'].slice((8 * 32 + 24) * 4, (8 * 32 + 24) * 4 + 3),
            samples['32'].slice((16 * 32 + 28) * 4, (16 * 32 + 28) * 4 + 3),
            'The old upper-right decoration must stay erased');
        const unchanged = samples['32'].every((value, index) => {
            const pixel = Math.floor(index / 4);
            const x = pixel % 32;
            const y = Math.floor(pixel / 32);
            return (x <= 11 && y <= 11) || (x >= 21 && x <= 27 && y >= 5 && y <= 12) || value === original[index];
        });
        assert.equal(unchanged, true, 'Logo pixels outside the dot must not change');
    }
    await setPair(business);
    await expectDot([50, 168, 117], /Cookie 与配置一致/);
    assert.equal(await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), '1');
    await setPair(business, 'http://wrong.example');
    await expectDot([217, 152, 53], /值不一致/);
    await context.clearCookies();
    await expectDot([213, 220, 229], /尚未设置 Cookie/);
    await business.goto('https://pan.baidu.com/other');
    await expectDot(undefined, /未命中配置/);
});

test('HTTP and HTTPS tabs use their own applicable Cookies and survive activation and config edits', async (t) => {
    const { worker, business, tabId, context, page } = await setup(t);
    await setPair(business);
    const httpPage = await context.newPage();
    await httpPage.goto('http://pan.baidu.com/review/main');
    const httpTab = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://pan.baidu.com/*' }))[0].id);
    await expectTitle(worker, httpTab, /Cookie 与配置一致/);
    await context.clearCookies();
    await worker.evaluate(() => Promise.all(['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS'].map((name, i) => chrome.cookies.set({
        name, value: ['test-main', 'http://localhost:8001'][i],
        url: 'https://pan.baidu.com/review/main', path: '/review/main', secure: true
    }))));
    await expectTitle(worker, tabId, /Cookie 与配置一致/);
    await expectTitle(worker, httpTab, /尚未设置 Cookie/);
    for (const selected of [httpTab, tabId, httpTab]) {
        await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), selected);
        await expectTitle(worker, selected, selected === tabId ? /Cookie 与配置一致/ : /尚未设置 Cookie/);
    }
    const config = configFixture();
    config.groups[0].proxy = 'http://localhost:9000';
    await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    await expectTitle(worker, tabId, /值不一致：BP_NODE_PROXY_PASS/);
    config.groups.shift();
    await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    await expectTitle(worker, tabId, /未命中配置/);
    await expectTitle(worker, httpTab, /未命中配置/);
    await expectTitle(worker, await page.evaluate(async () => (await chrome.tabs.getCurrent()).id), /未命中配置/);
    await page.waitForFunction((count) => document.querySelectorAll('#groups .group').length === count, config.groups.length);
});

test('failed checks replace stale green with unknown, leave unrelated pages neutral, and recover', async (t) => {
    const { worker, business, tabId, page } = await setup(t);
    await setPair(business);
    await expectTitle(worker, tabId, /Cookie 与配置一致/);
    const outside = await page.context().newPage();
    await outside.goto('https://pan.baidu.com/outside-config');
    const outsideTabId = await worker.evaluate(async () =>
        (await chrome.tabs.query({ url: 'https://pan.baidu.com/outside-config' }))[0].id);
    await expectTitle(worker, outsideTabId, /未命中配置/);
    const panelTabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    await worker.evaluate(async () => {
        const read = chrome.cookies.getAll.bind(chrome.cookies);
        globalThis.restoreIndicatorReads = () => { chrome.cookies.getAll = read; };
        chrome.cookies.getAll = async () => { throw new Error('test read failure'); };
        const setIcon = chrome.action.setIcon.bind(chrome.action);
        globalThis.failedIcon = {};
        chrome.action.setIcon = async (details) => {
            const pixels = details.imageData['32'].data;
            globalThis.failedIcon[details.tabId] = Array.from(pixels.slice((6 * 32 + 6) * 4, (6 * 32 + 6) * 4 + 3));
            return setIcon(details);
        };
        const { config } = await chrome.storage.local.get('config');
        config.groups[0].note = 'Trigger read failure';
        await chrome.storage.local.set({ config });
    });
    await expectTitle(worker, tabId, /状态读取失败/);
    assert.deepEqual(await worker.evaluate((id) => globalThis.failedIcon[id], tabId), [89, 101, 121]);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '?');
    await expectTitle(worker, panelTabId, /未命中配置/);
    await expectTitle(worker, outsideTabId, /未命中配置.*全部配置匹配数量读取失败/);
    assert.notDeepEqual(await worker.evaluate((id) => globalThis.failedIcon[id], outsideTabId), [89, 101, 121]);
    await worker.evaluate(async () => {
        globalThis.restoreIndicatorReads();
        const { config } = await chrome.storage.local.get('config');
        config.groups[0].note = 'Recover reads';
        await chrome.storage.local.set({ config });
    });
    await expectTitle(worker, tabId, /Cookie 与配置一致.*全部配置已匹配 1 条路径/);
    assert.deepEqual(await worker.evaluate((id) => globalThis.failedIcon[id], tabId), [50, 168, 117]);
});

test('navigation discards an older Cookie read and closing a checked tab leaves no stale writes', async (t) => {
    const { worker, business, tabId, context } = await setup(t);
    await setPair(business);
    await expectTitle(worker, tabId, /Cookie 与配置一致/);
    await worker.evaluate(async () => {
        const read = chrome.cookies.getAll.bind(chrome.cookies);
        let armed = true;
        chrome.cookies.getAll = async (query) => {
            const result = await read(query);
            if (armed && query.url?.includes('/review/main')) {
                armed = false;
                await new Promise((resolve) => { globalThis.releasePageRead = resolve; });
            }
            return result;
        };
        globalThis.pageTitleWrites = [];
        const title = chrome.action.setTitle.bind(chrome.action);
        chrome.action.setTitle = async (details) => {
            globalThis.pageTitleWrites.push(details);
            return title(details);
        };
        globalThis.backgroundErrors = [];
        self.addEventListener('unhandledrejection', (event) => globalThis.backgroundErrors.push(String(event.reason)));
        const { config } = await chrome.storage.local.get('config');
        config.groups[0].note = 'Hold this page check';
        await chrome.storage.local.set({ config });
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await worker.evaluate(() => Boolean(globalThis.releasePageRead))) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(await worker.evaluate(() => Boolean(globalThis.releasePageRead)), true);
    await business.evaluate(() => history.pushState({}, '', '/outside-config'));
    assert.match(await worker.evaluate(async (id) => (await chrome.tabs.get(id)).url, tabId), /outside-config$/);
    await worker.evaluate(() => { globalThis.pageTitleWrites = []; globalThis.releasePageRead(); });
    await expectTitle(worker, tabId, /未命中配置/);
    const writes = await worker.evaluate((id) => globalThis.pageTitleWrites.filter((item) => item.tabId === id), tabId);
    assert.equal(writes.some((item) => item.title.includes('Cookie 与配置一致')), false);
    await business.close();
    const next = await context.newPage();
    await next.goto('https://pan.baidu.com/review/main');
    const nextId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://pan.baidu.com/review/main' }))[0].id);
    await expectTitle(worker, nextId, /Cookie 与配置一致/);
    assert.deepEqual(await worker.evaluate(() => globalThis.backgroundErrors), []);
});

test('status dots are visible at toolbar resolution and unmatched has no green decoration', async (t) => {
    const { page } = await launchExtension(t, { config: configFixture() });
    const images = await page.evaluate(async () => {
        const { createStatusIconRenderer } = await import('./status-icon.js');
        const render = createStatusIconRenderer((path) => chrome.runtime.getURL(path));
        return Object.fromEntries(await Promise.all(['active', 'off', 'mixed', 'unknown', 'unmatched'].map(async (state) => {
            const sizes = await render(state);
            return [state, Object.fromEntries(Object.entries(sizes).map(([size, image]) => [size, Array.from(image.data)]))];
        })));
    });
    for (const [state, color] of Object.entries({
        active: [50, 168, 117], off: [213, 220, 229], mixed: [217, 152, 53], unknown: [89, 101, 121]
    })) {
        const pixels = images[state]['16'];
        let solidPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] === 255 && color.every((value, channel) => Math.abs(pixels[i + channel] - value) <= 8)) {
                solidPixels += 1;
            }
        }
        assert.ok(solidPixels >= 8, `${state} needs a readable dot at 16px; only ${solidPixels} solid pixels were visible`);
    }
    for (const size of [16, 32]) {
        const pixels = images.unmatched[size];
        const greenPixels = pixels.filter((_, i) => i % 4 === 0 && pixels[i + 1] > pixels[i] + 10 && pixels[i + 1] > pixels[i + 2] + 10);
        assert.equal(greenPixels.length, 0, 'Unmatched icons must not retain any green decorative pixels');
    }
});


test('navigation updates only the changed tab without rereading global Cookie inventory', async (t) => {
    const { worker, business, tabId, page, context } = await setup(t);
    await page.close();
    const other = await context.newPage();
    await other.goto('https://pan.baidu.com/review/preview');
    await business.goto('https://pan.baidu.com/review/other');
    await expectTitle(worker, tabId, /Secondary/);
    await worker.evaluate(() => {
        const read = chrome.cookies.getAll.bind(chrome.cookies);
        const setIcon = chrome.action.setIcon.bind(chrome.action);
        globalThis.navigationWork = { globalReads: 0, iconTabs: [] };
        chrome.cookies.getAll = async (query) => {
            if (!query.url) globalThis.navigationWork.globalReads += 1;
            return read(query);
        };
        chrome.action.setIcon = async (details) => {
            globalThis.navigationWork.iconTabs.push(details.tabId);
            return setIcon(details);
        };
    });
    await business.goto('https://pan.baidu.com/review/main');
    await expectTitle(worker, tabId, /Primary/);
    const work = await worker.evaluate(() => globalThis.navigationWork);
    assert.equal(work.globalReads, 0, 'A navigation cannot change the global Cookie count by itself');
    assert.ok(work.iconTabs.length > 0);
    assert.deepEqual([...new Set(work.iconTabs)], [tabId], 'Unchanged tabs should not have their icons rewritten');
    await business.goto('https://pan.baidu.com/outside-config');
    await expectTitle(worker, tabId, /未命中配置/);
});

test('leaving the permitted host clears the matched indicator without requiring tabs permission', async (t) => {
    const { worker, business, tabId, page, context } = await setup(t);
    await page.close();
    await expectTitle(worker, tabId, /Primary/);
    await context.route('https://unrelated.example/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Unrelated</title>'
    }));
    await business.goto('https://unrelated.example/');
    await expectTitle(worker, tabId, /未命中配置/);
});

test('the page indicator accepts applicable ancestor and descendant paths but still detects value conflicts', async (t) => {
    const { worker, business, tabId, page, context } = await setup(t);
    await page.close();
    for (const path of ['/', '/review', '/review/main/deep']) {
        await context.clearCookies();
        await business.goto('https://pan.baidu.com/review/main/deep');
        await setPair(business, 'http://localhost:8001', path);
        await expectTitle(worker, tabId, /Cookie 与配置一致/);
        await setPair(business, 'http://wrong.example', path);
        await expectTitle(worker, tabId, /值不一致：BP_NODE_PROXY_PASS/);
    }
});
