import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config.js';
import { DEFAULT_CONFIG } from './default-config.mjs';

let moduleId = 0;

async function withFetch(fetchResource, check) {
    const original = globalThis.fetch;
    globalThis.fetch = fetchResource;
    try {
        moduleId += 1;
        const { loadDefaultConfig } = await import(`../default-config-loader.js?test=${moduleId}`);
        await check(loadDefaultConfig);
    } finally {
        globalThis.fetch = original;
    }
}

const response = () => ({ ok: true, json: async () => structuredClone(DEFAULT_CONFIG) });

test('defaults load from the JSON file once and callers receive independent copies', async () => {
    let calls = 0;
    await withFetch(async (url) => {
        assert.ok(url.pathname.endsWith('/default-config.json'));
        calls += 1;
        return response();
    }, async (load) => {
        const [first, second] = await Promise.all([load(), load()]);
        assert.deepEqual(first, DEFAULT_CONFIG);
        assert.deepEqual(second, DEFAULT_CONFIG);
        first.groups[0].note = 'local edit';
        assert.equal(second.groups[0].note, DEFAULT_CONFIG.groups[0].note);
        assert.deepEqual(await load(), DEFAULT_CONFIG);
        assert.equal(calls, 1);
    });
});

test('a failed default-file read can be retried instead of caching the failure', async () => {
    let calls = 0;
    await withFetch(async () => {
        calls += 1;
        if (calls === 1) throw new Error('resource unavailable');
        return response();
    }, async (load) => {
        await assert.rejects(load(), /无法加载 default-config.json.*resource unavailable/);
        assert.deepEqual(await load(), DEFAULT_CONFIG);
        assert.equal(calls, 2);
    });
});

test('missing default file reports its filename and response status', async () => {
    await withFetch(async () => ({ ok: false, status: 404 }), async (load) => {
        await assert.rejects(load(), /default-config.json.*404/);
    });
});

test('invalid JSON reports the default file rather than silently falling back', async () => {
    await withFetch(async () => ({
        ok: true,
        json: async () => { throw new SyntaxError('Invalid JSON'); }
    }), async (load) => {
        await assert.rejects(load(), /default-config.json.*Invalid JSON/);
    });
});

test('parsed defaults must pass the same schema validation as imported configurations', async () => {
    await withFetch(async () => ({
        ok: true, json: async () => ({ version: 1, groups: [] })
    }), async (load) => {
        await assert.rejects(load(), /default-config.json.*1–12/);
    });
});

test('the bundled JSON is a valid canonical configuration', () => {
    assert.deepEqual(validateConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
});
