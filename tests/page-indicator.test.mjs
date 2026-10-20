import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageIndicatorUpdater } from '../page-indicator.js';
import { configFixture } from './fixtures.mjs';

test('a discarded tabs query does not reject a background refresh', async () => {
    const updater = createPageIndicatorUpdater({
        action: {}, cookies: {}, tabs: { query: async () => { throw new Error('Browser is closing'); } }
    });
    await assert.doesNotReject(updater.update({}));
});

test('a new global snapshot supersedes a slow page check using older configuration', async () => {
    const config = configFixture();
    const tab = { id: 1, url: 'https://pan.baidu.com/review/main' };
    const oldRead = Promise.withResolvers();
    const started = Promise.withResolvers();
    let reads = 0;
    const titles = [];
    const updater = createPageIndicatorUpdater({
        tabs: { get: async () => tab, query: async () => [tab] },
        cookies: {
            getAllCookieStores: async () => [{ id: '0', tabIds: [tab.id] }],
            getAll: async ({ name }) => {
                reads += 1;
                if (reads <= 2) { started.resolve(); await oldRead.promise; }
                return [{ name, value: name === 'BP_NODE_CONTAINER_ID' ? 'test-main' : 'http://localhost:8001',
                    domain: 'pan.baidu.com', hostOnly: true, path: '/review/main' }];
            }
        },
        renderIcon: async (state) => state,
        action: { setIcon: async () => {}, setTitle: async ({ title }) => titles.push(title) }
    });
    const pending = updater.update({ data: { config }, count: 1 }, tab.id);
    await started.promise;
    const updated = structuredClone(config);
    updated.groups[0].proxy = 'http://localhost:9000';
    await updater.update({ data: { config: updated }, count: 0 });
    oldRead.resolve();
    await pending;
    assert.equal(titles.length, 1, 'The older page read must be discarded');
    assert.match(titles[0], /值不一致：BP_NODE_PROXY_PASS/);
});

test('configuration read failure preserves known page classification and marks matching pages unknown', async () => {
    const config = configFixture();
    const tabs = [
        { id: 1, url: `https://${config.host}/review/main` },
        { id: 2, url: `https://${config.host}/unrelated` }
    ];
    const states = new Map();
    const updater = createPageIndicatorUpdater({
        tabs: { query: async () => tabs, get: async (id) => tabs.find((tab) => tab.id === id) },
        cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [1, 2] }], getAll: async () => [] },
        renderIcon: async (state) => state,
        action: { setIcon: async ({ tabId, imageData }) => states.set(tabId, imageData), setTitle: async () => {} }
    });
    await updater.update({ data: { config, status: {} }, count: 0 });
    assert.equal(states.get(1), 'off');
    await updater.update({ data: undefined });
    assert.equal(states.get(1), 'unknown');
    assert.equal(states.get(2), 'unmatched');
});
