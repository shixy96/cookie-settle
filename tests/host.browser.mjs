import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, cp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionRoot, launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

async function launchHost(t, host = 'review.example.com') {
    const root = await mkdtemp(join(tmpdir(), 'cookie-settle-host-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(extensionRoot, 'icons'), join(root, 'icons'), { recursive: true });
    for (const name of await readdir(extensionRoot)) {
        if (/\.(js|json|html|css)$/.test(name)) await copyFile(join(extensionRoot, name), join(root, name));
    }
    const config = { ...configFixture(), host };
    await writeFile(join(root, 'default-config.json'), JSON.stringify(config));
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push(`http://${host}/*`, `https://${host}/*`, 'https://example.com/*');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    return { ...await launchExtension(t, { root }), config };
}

test('configured host drives identity, reads, writes, page indicators, reload and safe cleanup', async (t) => {
    const { context, page, worker, config } = await launchHost(t);
    assert.equal(await page.locator('.site-address').textContent(), 'review.example.com');
    await context.route(/https?:\/\/(review\.example\.com|pan\.baidu\.com)\//, (route) => route.fulfill({
        contentType: 'text/html', body: '<title>Isolated host fixture</title>'
    }));
    const business = await context.newPage();
    const http = await context.newPage();
    const outside = await context.newPage();
    await business.goto('https://review.example.com/review/main/deep');
    await http.goto('http://review.example.com/review/main');
    await outside.goto('https://pan.baidu.com/review/main');
    await page.locator('.live-page').nth(1).waitFor();
    assert.equal(await page.locator('.live-page').count(), 2);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://review.example.com/*' }))[0].id);
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验 6 个' }).waitFor();
    const written = await worker.evaluate(() => chrome.cookies.getAll({}));
    assert.equal(written.length, 6);
    assert.ok(written.every((cookie) => cookie.domain === config.host));
    await page.waitForFunction(async (id) => (await chrome.action.getTitle({ tabId: id })).includes('Cookie 与配置一致'), tabId);
    await page.waitForFunction(async () => await chrome.action.getBadgeText({}) === '3');
    await business.evaluate(() => { document.cookie = 'BP_NODE_CONTAINER_ID=manual; path=/review/main; secure'; });
    await page.waitForFunction(async (id) => (await chrome.action.getTitle({ tabId: id })).includes('值不一致'), tabId);
    const loads = [0, 0, 0];
    [business, http, outside].forEach((tab, index) => tab.on('load', () => { loads[index] += 1; }));
    await page.locator('#reload-tabs').click();
    await page.locator('#notice').filter({ hasText: '已刷新 2 个' }).waitFor();
    await Promise.all([business.waitForLoadState(), http.waitForLoadState()]);
    assert.deepEqual(loads, [1, 1, 0]);
    await worker.evaluate(async () => {
        for (const entry of [
            { name: 'BP_NODE_CONTAINER_ID', value: 'root', domain: 'review.example.com', path: '/' },
            { name: 'BP_NODE_PROXY_PASS', value: 'parent', domain: '.example.com', path: '/', secure: true },
            { name: 'BP_NODE_CONTAINER_ID', value: 'other-site', domain: 'pan.baidu.com', path: '/review/main' },
            { name: 'BDUSS', value: 'login', domain: 'review.example.com', path: '/' },
            { name: 'BP_NODE_CONTAINER_ID', value: 'unrelated', domain: 'review.example.com', path: '/unrelated' }
        ]) await chrome.cookies.set({ ...entry, url: `https://${entry.domain.replace(/^\./, '')}${entry.path}` });
    });
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理 7 个' }).waitFor();
    const remaining = await context.cookies();
    assert.deepEqual(remaining.map((cookie) => cookie.value).sort(), ['login', 'other-site', 'parent', 'unrelated']);
});

async function importConfig(page, config) {
    await page.locator('#import-file').setInputFiles({
        name: 'config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config))
    });
    await page.locator('#confirm[open]').waitFor();
    await page.locator('#confirm-save').click();
    await page.locator('#confirm').waitFor({ state: 'hidden' });
    await page.locator('#apply-all:not([disabled])').waitFor();
}

test('changing hosts isolates cleanup history and switching back recovers it', async (t) => {
    const { page, worker, config } = await launchHost(t);
    const original = { ...config, groups: [{ ...config.groups[0], paths: ['/previous'] }] };
    await importConfig(page, original);
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验 2 个' }).waitFor();
    const next = { ...configFixture(), groups: [{ ...config.groups[0], paths: ['/current'] }] };
    await worker.evaluate(async () => {
        await chrome.cookies.set({ url: 'https://pan.baidu.com/previous', name: 'BP_NODE_CONTAINER_ID',
            value: 'unrelated-on-new-host', path: '/previous', secure: true });
    });
    await importConfig(page, next);
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理 0 个' }).waitFor();
    const unrelated = await worker.evaluate(() => chrome.cookies.get({ url: 'https://pan.baidu.com/previous', name: 'BP_NODE_CONTAINER_ID' }));
    assert.equal(unrelated?.value, 'unrelated-on-new-host');
    await importConfig(page, { ...config, groups: [{ ...config.groups[0], paths: ['/new'] }] });
    await page.locator('#conflicts').filter({ hasText: '/previous' }).waitFor();
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理 2 个' }).waitFor();
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({ domain: 'review.example.com' })), []);
});

test('an unauthorized imported or stored host cannot silently report an empty successful status', async (t) => {
    const { page, worker } = await launchExtension(t, { config: configFixture() });
    const next = { ...configFixture(), host: 'unauthorized.example' };
    await page.locator('#import-file').setInputFiles({
        name: 'config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next))
    });
    await page.locator('#confirm[open]').waitFor();
    await page.locator('#confirm-save').click();
    await page.locator('#confirm-error').filter({ hasText: '未获授权' }).waitFor();
    assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('config')).config)).host, configFixture().host);
    await page.locator('#confirm [data-close]').first().click();
    await worker.evaluate((config) => chrome.storage.local.set({ config }), next);
    const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
    assert.equal(result.ok, false, 'A missing permission must never appear as zero Cookies');
    assert.match(result.error, /未获授权/);
});


test('long configured hosts stay within the panel without overlapping the expand control', async (t) => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.example.com`;
    const { page, url } = await launchHost(t, host);
    await page.setViewportSize({ width: 460, height: 600 });
    await page.goto(url.split('?')[0]);
    await page.locator('#apply-all:not([disabled])').waitFor();
    assert.equal(await page.locator('.site-address').textContent(), host);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const site = await page.locator('.site-address').boundingBox();
    const expand = await page.locator('#expand').boundingBox();
    assert.ok(site.x + site.width <= expand.x, 'Long host must not overlap the expand button');
});
