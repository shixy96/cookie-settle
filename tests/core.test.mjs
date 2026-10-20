import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateConfig, configPaths, pathMatches, buildStatus,
    summarizePageCookies
} from '../config.js';
import { COOKIE_NAMES } from '../constants.js';
import { configFixture } from './fixtures.mjs';
import { mutateCookies, readRoutingCookies, readPageCookies } from '../cookie-engine.js';

const testConfig = validateConfig(configFixture());
const paths = configPaths(testConfig);
const primary = testConfig.groups[0];

function cookie(overrides = {}) {
    return {
        name: COOKIE_NAMES[0], value: 'old-container', domain: 'pan.baidu.com',
        path: '/review/main', hostOnly: true, secure: true, httpOnly: false,
        sameSite: 'lax', session: true, storeId: '0', ...overrides
    };
}

class FakeCookies {
    constructor(initial = [], failAtSet = 0) {
        this.items = structuredClone(initial);
        this.failAtSet = failAtSet;
        this.setCount = 0;
    }
    async getAll({ name, storeId, url }) {
        const target = url ? new URL(url) : undefined;
        return structuredClone(this.items.filter((item) =>
            (!name || name === item.name) && item.storeId === storeId &&
            (!target || pathMatches(item.path, target.pathname))
        ).sort((a, b) => b.path.length - a.path.length));
    }
    async set(details) {
        this.setCount += 1;
        if (this.setCount === this.failAtSet) throw new Error('simulated write failure');
        const next = cookie({
            ...details, domain: details.domain || 'pan.baidu.com',
            hostOnly: !details.domain, session: details.expirationDate === undefined
        });
        delete next.url;
        this.items = this.items.filter((item) =>
            !(item.name === next.name && item.domain === next.domain &&
                item.path === next.path && item.storeId === next.storeId && !item.partitionKey)
        );
        if (next.expirationDate !== undefined && next.expirationDate <= Date.now() / 1000) return null;
        this.items.push(next);
        return structuredClone(next);
    }

}

test('configuration rejects injection, broad paths, overlapping scopes and duplicate IDs', () => {
    for (const patch of [
        { container: 'abc; BDUSS=fake' },
        { proxy: 'javascript:alert(1)' },
        { proxy: 'https://user:pass@example.com' },
        { proxy: 'http://example.com/path' },
        { paths: ['/'] },
        { paths: ['/review/main?x=1'] },
        { paths: ['/review/main', '/review/main/child'] },
        { paths: ['/review/other'] },
        { id: 'secondary' }
    ]) {
        const input = structuredClone(testConfig);
        Object.assign(input.groups[0], patch);
        assert.throws(() => validateConfig(input));
    }
});

test('path matching follows slash boundaries and preserves trailing slash', () => {
    assert.equal(pathMatches('/review/main', '/review/main-sibling'), false);
    assert.equal(pathMatches('/review/main', '/review/main/home'), true);
    assert.equal(pathMatches('/e/', '/e'), false);
    assert.equal(pathMatches('/e/', '/e/abc'), true);
});

test('apply writes six cookies without touching login or unrelated paths', async () => {
    const login = cookie({ name: 'BDUSS', value: 'test-login', path: '/' });
    const unrelated = cookie({ path: '/unrelated' });
    const api = new FakeCookies([login, unrelated]);
    const result = await mutateCookies(api, '0', testConfig.groups, 'apply', paths, testConfig.host);
    assert.equal(result.cookies, 6);
    assert.deepEqual(api.items.find((item) => item.name === 'BDUSS'), login);
    assert.deepEqual(api.items.find((item) => item.path === '/unrelated'), unrelated);
    const status = buildStatus(testConfig, await readRoutingCookies(api, '0', testConfig.host), paths);
    assert.equal(status.groups.every((group) => group.state === 'active'), true);
});

test('reapplying is idempotent', async () => {
    const api = new FakeCookies();
    await mutateCookies(api, '0', testConfig.groups, 'apply', paths, testConfig.host);
    await mutateCookies(api, '0', testConfig.groups, 'apply', paths, testConfig.host);
    assert.equal(api.items.length, 6);
});

test('group cleanup leaves other groups and authentication untouched', async () => {
    const api = new FakeCookies([cookie({ name: 'BDUSS', path: '/' })]);
    await mutateCookies(api, '0', testConfig.groups, 'apply', paths, testConfig.host);
    await mutateCookies(api, '0', [primary], 'clear', primary.paths, testConfig.host);
    assert.equal(api.items.filter((item) => COOKIE_NAMES.includes(item.name)).length, 2);
    assert.equal(api.items.some((item) => item.name === 'BDUSS'), true);
});

test('cleanup removes host and domain variants while retaining partitioned cookies', async () => {
    const partitioned = cookie({ partitionKey: { topLevelSite: 'https://example.com' } });
    const api = new FakeCookies([
        cookie(), cookie({ domain: '.pan.baidu.com', hostOnly: false }), partitioned
    ]);
    await mutateCookies(api, '0', [primary], 'clear', primary.paths, testConfig.host);
    assert.deepEqual(api.items, [partitioned]);
});

test('parent-domain collision refuses application before any mutation', async () => {
    const original = [cookie({ domain: '.baidu.com', hostOnly: false, path: '/' })];
    const api = new FakeCookies(original);
    await assert.rejects(
        mutateCookies(api, '0', [primary], 'apply', primary.paths, testConfig.host),
        /范围外/
    );
    assert.deepEqual(api.items, original);
    assert.equal(api.setCount, 0);
});

test('cleanup cannot remove a same-path parent-domain cookie by accident', async () => {
    const original = [cookie({ domain: '.baidu.com', hostOnly: false }), cookie()];
    const api = new FakeCookies(original);
    await assert.rejects(
        mutateCookies(api, '0', [primary], 'clear', primary.paths, testConfig.host),
        /父域同名/
    );
    assert.deepEqual(api.items, original);
});

test('failed apply restores original cookie attributes and values', async () => {
    const original = [cookie({
        domain: '.pan.baidu.com', hostOnly: false, httpOnly: true,
        secure: false, sameSite: 'unspecified', session: false,
        expirationDate: 2000000000
    })];
    const api = new FakeCookies(original, 3);
    await assert.rejects(
        mutateCookies(api, '0', [primary], 'apply', primary.paths, testConfig.host),
        /已恢复操作前/
    );
    assert.deepEqual(api.items, original);
});

test('failed rollback reports incomplete recovery', async () => {
    const api = new FakeCookies([cookie()]);
    const set = api.set.bind(api);
    api.set = async (details) => {
        if (details.expirationDate === 0) return set(details);
        throw new Error('permission denied');
    };
    await assert.rejects(
        mutateCookies(api, '0', [primary], 'apply', primary.paths, testConfig.host),
        /自动恢复未完成/
    );
});

test('clear-all includes paths from older configurations', async () => {
    const old = '/disk/old-environment';
    const api = new FakeCookies([cookie({ path: old })]);
    const status = buildStatus(testConfig, await readRoutingCookies(api, '0', testConfig.host), [...paths, old]);
    assert.deepEqual(status.leftovers, [old]);
    await mutateCookies(api, '0', testConfig.groups, 'clear', [...paths, old], testConfig.host);
    assert.equal(api.items.length, 0);
});

test('partial and mismatched values are never reported as active', () => {
    const status = buildStatus(testConfig, [cookie()], paths);
    assert.equal(status.groups[0].state, 'mixed');
    assert.equal(status.groups[1].state, 'off');
});

test('status exposes parent and root conflicts without exposing other cookie names', async () => {
    const api = new FakeCookies([
        cookie({ domain: '.baidu.com', path: '/', hostOnly: false }),
        cookie({ name: 'BDUSS', path: '/' })
    ]);
    const status = buildStatus(testConfig, await readRoutingCookies(api, '0', testConfig.host), paths);
    assert.equal(status.unmanaged.length, 1);
    assert.equal(status.unmanaged[0].name, COOKIE_NAMES[0]);
    assert.equal(status.groups.every((group) => group.state === 'mixed'), true);
});

test('an unrelated child domain is excluded from cookie reads', async () => {
    const api = new FakeCookies([cookie({ domain: 'other.pan.baidu.com' })]);
    assert.deepEqual(await readRoutingCookies(api, '0', testConfig.host), []);
});

test('host-only parent-domain cookies do not apply to pan.baidu.com', async () => {
    const api = new FakeCookies([cookie({ domain: 'baidu.com', hostOnly: true })]);
    assert.deepEqual(await readRoutingCookies(api, '0', testConfig.host), []);
});

test('live inventory includes manual cookies outside configured paths with real values', () => {
    const manual = cookie({ path: '/review/main/deep', value: 'set-in-page-console' });
    const status = buildStatus(testConfig, [manual], paths);
    assert.ok(Array.isArray(status.inventory), 'status must expose the actual Cookie inventory');
    assert.equal(status.inventory.length, 1);
    assert.equal(status.inventory[0].value, 'set-in-page-console');
    assert.equal(status.inventory[0].path, '/review/main/deep');
    assert.equal(status.inventory[0].managed, false);
});

test('configured path details include inherited root and parent-domain values', () => {
    const manual = cookie({ domain: '.baidu.com', hostOnly: false, path: '/', value: 'manual-parent' });
    const status = buildStatus(testConfig, [manual], paths);
    assert.equal(status.groups[0].paths[0].differences.length, 1);
    assert.equal(status.groups[0].paths[0].differences[0].cookie.value, 'manual-parent');
    assert.equal(status.groups[0].paths[0].differences[0].cookie.path, '/');
});

test('page presence is independent of preset values and detects missing or duplicate names', () => {
    const first = cookie({ value: 'manually-selected-environment' });
    const second = cookie({ name: COOKIE_NAMES[1], value: 'http://manual:8075' });
    assert.equal(summarizePageCookies([]).state, 'off');
    assert.equal(summarizePageCookies([first]).state, 'partial');
    assert.deepEqual(summarizePageCookies([first]).missing, [COOKIE_NAMES[1]]);
    assert.equal(summarizePageCookies([first, second]).state, 'present');
    assert.equal(summarizePageCookies([first, second, cookie({ path: '/' })]).state, 'conflict');
});

test('page query uses real URL path matching and ignores URL query/hash', async () => {
    const api = new FakeCookies([
        cookie({ path: '/review/main/deep', value: 'manual-deep' }),
        cookie({ name: 'BDUSS', path: '/' }),
        cookie({ name: COOKIE_NAMES[1], path: '/' })
    ]);
    const matching = await readPageCookies(api, '0', 'https://pan.baidu.com/review/main/deep/test?x=1#hash', testConfig.host);
    assert.equal(matching.length, 2);
    assert.equal(matching[0].value, 'manual-deep');
    const sibling = await readPageCookies(api, '0', 'https://pan.baidu.com/review/main-sibling/test', testConfig.host);
    assert.deepEqual(sibling.map((item) => item.name), [COOKIE_NAMES[1]]);
    await assert.rejects(readPageCookies(api, '0', 'https://other.baidu.com/review/main', testConfig.host), /仅检查/);
});


test('a later expiry failure does not block restoring earlier deleted Cookies', async () => {
    const original = [cookie({ path: '/review/long-target' }), cookie({ path: '/review/x' })];
    const api = new FakeCookies(original);
    const set = api.set.bind(api);
    api.set = async (details) => {
        if (details.expirationDate === 0 && details.path === '/review/x') throw new Error('expiry denied');
        return set(details);
    };
    await assert.rejects(mutateCookies(api, '0', [], 'clear', original.map((item) => item.path), testConfig.host), /expiry denied.*已恢复操作前/);
    const restored = await readRoutingCookies(api, '0', testConfig.host);
    assert.deepEqual(restored, original);
});


test('one failed restoration still allows other deleted Cookies to recover', async () => {
    const original = [cookie({ path: '/review/long-target' }), cookie({ path: '/review/x' })];
    const api = new FakeCookies(original);
    const set = api.set.bind(api);
    api.set = async (details) => {
        if (details.expirationDate !== 0 && details.path === '/review/long-target') throw new Error('target write denied');
        return set(details);
    };
    const group = { ...primary, paths: original.map((item) => item.path) };
    await assert.rejects(mutateCookies(api, '0', [group], 'apply', group.paths, testConfig.host), /自动恢复未完成/);
    assert.deepEqual(await readRoutingCookies(api, '0', testConfig.host), [original[1]]);
});


test('a transient rollback read failure still restores deleted snapshot Cookies', async () => {
    const original = [cookie({ path: '/review/long-target' }), cookie({ path: '/review/x' })];
    const api = new FakeCookies(original);
    const set = api.set.bind(api);
    const getAll = api.getAll.bind(api);
    let failRecoveryRead = false;
    api.set = async (details) => {
        if (details.expirationDate === 0 && details.path === '/review/x') {
            failRecoveryRead = true;
            throw new Error('expiry denied');
        }
        return set(details);
    };
    api.getAll = async (details) => {
        if (failRecoveryRead && !details.url) {
            failRecoveryRead = false;
            throw new Error('transient recovery read failure');
        }
        return getAll(details);
    };
    await assert.rejects(mutateCookies(api, '0', [], 'clear', original.map((item) => item.path), testConfig.host), /expiry denied.*已恢复操作前/);
    assert.deepEqual(await readRoutingCookies(api, '0', testConfig.host), original);
});
