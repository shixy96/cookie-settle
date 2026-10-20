import test from 'node:test';
import assert from 'node:assert/strict';

import { configFixture } from './fixtures.mjs';

const fixture = configFixture();
let instance = 0;

async function background(t, initialCookies = []) {
    const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
    const data = {};
    const writes = [];
    const lifecycle = { startup: [], installed: [] };
    const badge = {};
    let cookieItems = initialCookies;
    let failStorage = false;
    let mutations = 0;
    let listener;
    globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(fixture) });
    globalThis.chrome = {
        permissions: { contains: async () => true },
        storage: { onChanged: { addListener() {} }, local: {
            get: async () => structuredClone(data),
            set: async (values) => {
                if (failStorage) throw new Error('storage unavailable');
                writes.push(structuredClone(values));
                Object.assign(data, structuredClone(values));
            }
        } },
        cookies: {
            onChanged: { addListener() {} },
            getAllCookieStores: async () => [{ id: '0', tabIds: [1] }],
            getAll: async ({ name }) => cookieItems.filter((cookie) => cookie.name === name),
            set: async () => { mutations += 1; throw new Error('unexpected mutation'); },
            remove: async () => { mutations += 1; throw new Error('unexpected mutation'); }
        },
        action: {
            async setBadgeText({ text }) { badge.text = text; },
            async setBadgeBackgroundColor() {},
            async setTitle() {}
        },
        tabs: { query: async () => [], onUpdated: { addListener() {} },
            onActivated: { addListener() {} }, onRemoved: { addListener() {} } },
        runtime: {
            id: 'test-extension', getURL: (path) => `chrome-extension://test-extension/${path}`,
            onStartup: { addListener: (callback) => lifecycle.startup.push(callback) },
            onInstalled: { addListener: (callback) => lifecycle.installed.push(callback) },
            onMessage: { addListener: (callback) => { listener = callback; } }
        }
    };
    t.after(() => { globalThis.chrome = previous.chrome; globalThis.fetch = previous.fetch; });
    await import(`../background.js?test=${++instance}`);
    await new Promise(setImmediate);
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
    return {
        send: (message) => new Promise((resolve) => {
            assert.equal(listener({ tabId: 1, ...message }, sender, resolve), true);
        }),
        badgeText: () => badge.text,
        setCookies: (items) => { cookieItems = items; },
        emit: async (event) => {
            await Promise.all(lifecycle[event].map((callback) => callback()));
            await new Promise(setImmediate);
        },
        failStorage: (value) => { failStorage = value; },
        mutations: () => mutations,
        writes
    };
}

test('concurrent saves reject a stale base and the queue accepts a later valid request', async (t) => {
    const app = await background(t);
    const base = (await app.send({ type: 'status' })).data.config;
    const first = structuredClone(base);
    first.groups[0].note = 'first edit';
    const second = structuredClone(base);
    second.groups[0].note = 'stale edit';
    const [saved, rejected] = await Promise.all([
        app.send({ type: 'saveConfig', config: first, baseConfig: base }),
        app.send({ type: 'saveConfig', config: second, baseConfig: base })
    ]);
    assert.equal(saved.ok, true);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /另一个窗口更新/);
    const status = await app.send({ type: 'status' });
    assert.equal(status.ok, true);
    assert.equal(status.data.config.groups[0].note, 'first edit');
});

test('storage failure prevents Cookie mutation and does not poison the message queue', async (t) => {
    const app = await background(t);
    await app.send({ type: 'status' });
    app.failStorage(true);
    for (const type of ['apply', 'clear']) {
        const result = await app.send({ type });
        assert.equal(result.ok, false);
        assert.match(result.error, /storage unavailable/);
    }
    assert.equal(app.mutations(), 0);
    app.failStorage(false);
    assert.equal((await app.send({ type: 'status' })).ok, true);
});

test('unchanged status reads do not keep writing storage and triggering refresh events', async (t) => {
    const app = await background(t);
    assert.equal((await app.send({ type: 'status' })).ok, true);
    const writes = app.writes.length;
    assert.equal((await app.send({ type: 'status' })).ok, true);
    assert.equal(app.writes.length, writes);
});


test('apply and clear reject the displayed config after another window changes it', async (t) => {
    const app = await background(t);
    const base = (await app.send({ type: 'status' })).data.config;
    const next = structuredClone(base);
    next.groups[0].proxy = 'http://localhost:8002';
    assert.equal((await app.send({ type: 'saveConfig', config: next, baseConfig: base })).ok, true);
    for (const type of ['apply', 'clear']) {
        const result = await app.send({ type, baseConfig: base });
        assert.equal(result.ok, false);
        assert.match(result.error, /另一个窗口更新/);
    }
    assert.equal(app.mutations(), 0);
});


for (const event of ['startup', 'installed']) {
    test(`${event} recalculates the badge instead of retaining a previous count`, async (t) => {
        const group = fixture.groups[0];
        const items = ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS'].map((name, index) => ({
            name, value: [group.container, group.proxy][index], path: group.paths[0],
            domain: 'pan.baidu.com', hostOnly: true, storeId: '0'
        }));
        const app = await background(t, items);
        assert.equal(app.badgeText(), '1');
        app.setCookies([]);
        await app.emit(event);
        assert.equal(app.badgeText(), '');
    });
}
