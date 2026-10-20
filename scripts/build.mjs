import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeFiles = [
    'manifest.json', 'default-config.json', 'popup.html', 'popup.css',
    'background.js', 'background-service.js', 'badge-service.js',
    'config.js', 'config-editor.js', 'constants.js', 'cookie-engine.js',
    'default-config-loader.js', 'page-indicator.js', 'popup.js', 'status-icon.js',
    'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'
];

async function build() {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
        throw new Error('manifest.json 必须包含有效的数字版本号。');
    }
    validateConfig(JSON.parse(await readFile(join(root, 'default-config.json'), 'utf8')));
    const name = `cookie-settle-${manifest.version}`;
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    const staging = await mkdtemp(join(dist, '.build-'));
    const directory = join(staging, name);
    const archive = join(staging, `${name}.zip`);
    try {
        for (const file of runtimeFiles) {
            const destination = join(directory, file);
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(join(root, file), destination);
        }
        try {
            await promisify(execFile)('zip', ['-q', '-r', '-X', archive, '.'], { cwd: directory });
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error('构建需要 zip 命令，请安装 zip 后重试。');
            throw error;
        }
        // Publish only after every required file and the archive have been produced.
        await rm(join(dist, name), { recursive: true, force: true });
        await rename(directory, join(dist, name));
        await rename(archive, join(dist, `${name}.zip`));
        console.log(`扩展目录：dist/${name}/\n分发压缩包：dist/${name}.zip`);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

build().catch((error) => {
    console.error(`构建失败：${error.message}`);
    process.exitCode = 1;
});
