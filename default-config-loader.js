import { validateConfig } from './config.js';

let pending;

async function readDefaultConfig() {
    const response = await fetch(new URL('./default-config.json', import.meta.url));
    if (!response.ok) {
        throw new Error(`读取失败（HTTP ${response.status}）`);
    }
    return validateConfig(await response.json());
}

export async function loadDefaultConfig() {
    if (!pending) {
        pending = readDefaultConfig().catch((error) => {
            pending = undefined;
            throw new Error(`无法加载 default-config.json：${error.message}`);
        });
    }
    // Callers may edit a proposed configuration without changing the cached defaults.
    return structuredClone(await pending);
}
