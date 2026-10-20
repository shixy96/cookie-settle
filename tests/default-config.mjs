import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_CONFIG = JSON.parse(
    await readFile(process.env.COOKIE_SETTLE_TEST_ROOT ?
        join(process.env.COOKIE_SETTLE_TEST_ROOT, 'default-config.json') :
        new URL('../default-config.json', import.meta.url), 'utf8')
);
