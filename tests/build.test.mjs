import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFixture, build, exec } from './build-fixture.mjs';

test('build produces a loadable directory and root-level ZIP without development or private files', async (t) => {
    const root = await buildFixture(t);
    await build(root);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const name = `cookie-settle-${manifest.version}`;
    const directory = join(root, 'dist', name);
    const archive = join(root, 'dist', `${name}.zip`);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), manifest);
    const { stdout } = await exec('unzip', ['-Z1', archive]);
    const entries = stdout.trim().split('\n');
    for (const required of ['manifest.json', 'default-config.json', 'popup.html', 'popup.css', 'background.js', 'icons/16.png']) {
        assert.ok(entries.includes(required), `Missing runtime entry: ${required}`);
    }
    assert.ok(entries.every((entry) => !/node_modules|tests\/|scripts\/|package|\.md$|\.env|debug\.js|DS_Store/.test(entry)));
    assert.ok(!entries.some((entry) => entry.startsWith(`${name}/`)), 'ZIP must have manifest.json at its root');
    await exec('unzip', ['-tq', archive]);
});

test('rebuild removes stale runtime files and a failed build preserves the previous release', async (t) => {
    const { writeFile, rm, readdir } = await import('node:fs/promises');
    const root = await buildFixture(t);
    await build(root);
    const { version } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const dist = join(root, 'dist');
    const directory = join(dist, `cookie-settle-${version}`);
    const archive = join(dist, `cookie-settle-${version}.zip`);
    await writeFile(join(directory, 'obsolete.js'), 'old runtime');
    await writeFile(join(dist, 'keep.txt'), 'unrelated output');
    await build(root);
    await assert.rejects(readFile(join(directory, 'obsolete.js')), { code: 'ENOENT' });
    const published = await readFile(archive);
    await rm(join(root, 'cookie-engine.js'));
    await assert.rejects(build(root));
    assert.deepEqual(await readFile(archive), published);
    assert.ok((await readFile(join(directory, 'cookie-engine.js'), 'utf8')).length > 0);
    assert.equal(await readFile(join(dist, 'keep.txt'), 'utf8'), 'unrelated output');
    assert.ok(!(await readdir(dist)).some((name) => name.startsWith('.build-')));
});
