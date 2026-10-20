import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config.js';
import { configFixture } from './fixtures.mjs';

test('configuration preserves its explicit host and supports legacy files only with an explicit fallback', () => {
    const input = { ...configFixture(), host: 'review.example.com' };
    assert.equal(validateConfig(input).host, 'review.example.com');
    delete input.host;
    assert.equal(validateConfig(input, 'legacy.example.com').host, 'legacy.example.com');
    assert.throws(() => validateConfig(input), /域名/);
});

test('configuration rejects URLs, wildcards, ports and ambiguous hostnames', () => {
    for (const host of ['', null, 'https://example.com', '*.example.com', '.example.com',
        'example.com/path', 'example.com:443', 'example.com@evil.test', 'example.com.',
        '127.1', '0x7f000001', '-bad.example', 'example..com']) {
        assert.throws(() => validateConfig({ ...configFixture(), host }), /域名/, String(host));
    }
    assert.equal(validateConfig({ ...configFixture(), host: 'LOCALHOST' }).host, 'localhost');
});

test('legacy history without domain identity cannot become cleanup targets on a new default host', async () => {
    const { createMessageHandler } = await import('../background-service.js');
    const config = { ...configFixture(), host: 'review.example.com' };
    const data = { managedPaths: ['/legacy-only'] };
    const unrelated = { name: 'BP_NODE_CONTAINER_ID', value: 'preserve-me',
        domain: config.host, hostOnly: true, path: '/legacy-only', secure: true };
    const handle = createMessageHandler({
        loadDefaults: async () => config,
        storage: { get: async () => structuredClone(data), set: async (values) => Object.assign(data, values) },
        permissions: { contains: async () => true },
        tabs: { query: async () => [] },
        cookies: {
            getAllCookieStores: async () => [{ id: '0', tabIds: [] }],
            getAll: async ({ name }) => name === unrelated.name ? [unrelated] : [],
            set: async () => { throw new Error('Unrelated Cookie must not be changed'); }
        }
    });
    assert.equal((await handle({ type: 'status' })).status.inventory[0].clearable, false);
    assert.equal((await handle({ type: 'clear' })).cookies, 0);
});
