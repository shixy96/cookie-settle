import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionRoot, launchExtension } from './browser-helpers.mjs';
import { configFixture } from './fixtures.mjs';

test('bundled configuration variants load and apply without fixed groups or paths', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cookie-settle-defaults-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(extensionRoot, 'icons'), join(root, 'icons'), { recursive: true });
    for (const name of await readdir(extensionRoot)) {
        if (/\.(js|json|html|css)$/.test(name)) await copyFile(join(extensionRoot, name), join(root, name));
    }
    const fixture = configFixture();
    const variants = [
        fixture.groups,
        [fixture.groups[1]],
        [{ ...fixture.groups[0], paths: ['/trailing/'] }],
        [{ ...fixture.groups[0], paths: [`/${'a'.repeat(199)}`] }]
    ];
    for (const groups of variants) {
        await t.test(`${groups.length} groups, first path ${groups[0].paths[0]}`, async (variant) => {
            await writeFile(join(root, 'default-config.json'), JSON.stringify({ version: 1, host: fixture.host, groups }));
            const { page, worker } = await launchExtension(variant, { root });
            assert.deepEqual(await page.locator('.group h3').allTextContents(), groups.map((group) => group.name));
            assert.deepEqual(await page.locator('.group > .group-note').allTextContents(), groups.map((group) => group.note));
            assert.deepEqual(await page.locator('.path-row > code').allTextContents(), groups.flatMap((group) => group.paths));
            const first = page.locator('.group').first();
            await first.getByRole('button', { name: '启用', exact: true }).click();
            await first.locator('.group-top .active').waitFor();
            const cookies = await worker.evaluate(() => chrome.cookies.getAll({}));
            assert.deepEqual([...new Set(cookies.map((cookie) => cookie.path))].sort(), [...groups[0].paths].sort());
            await first.getByRole('button', { name: '清理', exact: true }).click();
            await first.locator('.group-top .off').waitFor();
            assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), []);
        });
    }
});


test('twelve groups and thirty-two paths can shrink to one while cleanup retains historical paths', async (t) => {
    const template = configFixture().groups[0];
    const config = { version: 1, host: configFixture().host, groups: Array.from({ length: 12 }, (_, index) => ({
        ...template, id: `group-${index}`, name: `Environment ${index}`,
        paths: Array.from({ length: index < 8 ? 3 : 2 }, (_, path) => `/boundary/g${index}/p${path}`)
    })) };
    const { page, worker } = await launchExtension(t, { config });
    assert.equal(await page.locator('#counts').textContent(), '12 组 / 32 个路径');
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: '已写入并校验 64 个' }).waitFor();
    await page.waitForFunction(async () => await chrome.action.getBadgeText({}) === '32');
    config.groups = [{ ...config.groups[0], paths: [config.groups[0].paths[0]] }];
    await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    await page.locator('#counts').filter({ hasText: '1 组 / 1 个路径' }).waitFor();
    await page.waitForFunction(async () => await chrome.action.getBadgeText({}) === '1');
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理 64 个' }).waitFor();
    await page.waitForFunction(async () => await chrome.action.getBadgeText({}) === '');
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), []);
});
