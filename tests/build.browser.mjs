import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFixture, build, exec } from './build-fixture.mjs';
import { launchExtension } from './browser-helpers.mjs';

test('the distributed ZIP loads in Chromium and can apply and clear its bundled configuration', async (t) => {
    const root = await buildFixture(t);
    await build(root);
    const { version } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const unpacked = join(root, 'unpacked');
    await exec('unzip', ['-q', join(root, 'dist', `cookie-settle-${version}.zip`), '-d', unpacked]);
    const config = JSON.parse(await readFile(join(unpacked, 'default-config.json'), 'utf8'));
    const { page, worker } = await launchExtension(t, { root: unpacked });
    assert.equal(await page.locator('.site-address').textContent(), config.host);
    const first = page.locator('.group').first();
    await first.locator('.apply').click();
    await first.locator('.group-top .active').waitFor();
    await page.waitForFunction(async (count) => await chrome.action.getBadgeText({}) === String(count), config.groups[0].paths.length);
    await first.locator('.clear').click();
    await first.locator('.group-top .off').waitFor();
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), []);
});
