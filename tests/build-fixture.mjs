import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));

export async function buildFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'cookie-settle-package-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isFile() && /\.(js|json|html|css)$/.test(entry.name) ||
            ['icons', 'scripts'].includes(entry.name)) {
            await cp(join(source, entry.name), join(root, entry.name), { recursive: true });
        }
    }
    for (const name of ['.env', 'debug.js', 'notes.md', 'tests/private.txt', 'node_modules/private.txt', 'icons/.DS_Store']) {
        const file = join(root, name);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, 'PRIVATE_BUILD_FIXTURE');
    }
    return root;
}

export function build(root) {
    return exec('npm', ['run', 'build', '--silent'], { cwd: root });
}
