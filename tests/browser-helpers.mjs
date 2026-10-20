import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = process.env.PLAYWRIGHT_MODULE ?
    await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright');
export const extensionRoot = fileURLToPath(new URL('../', import.meta.url));

export async function launchExtension(t, { root = extensionRoot, profile, config, showScrollbars = false } = {}) {
    const ownedProfile = !profile;
    profile ||= await mkdtemp(join(tmpdir(), 'cookie-settle-regression-'));
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        ignoreDefaultArgs: showScrollbars ? ['--hide-scrollbars'] : [],
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    context.setDefaultTimeout(5000);
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    t.after(async () => {
        await context.close();
        if (ownedProfile) await rm(profile, { recursive: true, force: true });
        assert.deepEqual(errors, []);
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    if (config) await worker.evaluate((config) => chrome.storage.local.set({ config }), config);
    const url = `chrome-extension://${new URL(worker.url()).host}/popup.html?view=tab`;
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('#apply-all:not([disabled])').waitFor();
    return { context, worker, page, url };
}
