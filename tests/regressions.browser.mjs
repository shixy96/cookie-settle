import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExtension, extensionRoot } from './browser-helpers.mjs';

test('clear with a later parent-domain collision preserves every original Cookie', async (t) => {
    const { page } = await launchExtension(t);
    const result = await page.evaluate(async () => {
        const { mutateCookies } = await import('./cookie-engine.js');
        const name = 'BP_NODE_CONTAINER_ID';
        const paths = ['/review/long-target', '/review/x'];
        for (const details of [
            { path: paths[1], domain: '.baidu.com', value: 'parent' },
            { path: paths[1], value: 'short' },
            { path: paths[0], value: 'long' }
        ]) {
            await chrome.cookies.set({ url: `https://pan.baidu.com${details.path}`, name, secure: true, ...details });
        }
        const storeId = (await chrome.cookies.getAllCookieStores())[0].id;
        const before = await chrome.cookies.getAll({ name, storeId });
        let error;
        try {
            await mutateCookies(chrome.cookies, storeId, [{ paths }], 'clear', paths, 'pan.baidu.com');
        } catch (failure) {
            error = failure.message;
        }
        return { before, after: await chrome.cookies.getAll({ name, storeId }), error };
    });
    assert.match(result.error, /父域同名/);
    assert.deepEqual(result.after, result.before);
});


for (const close of ['cancel', 'escape']) {
    test(`manual Cookie changes while editing refresh after ${close}`, async (t) => {
        const { page, context } = await launchExtension(t);
        await context.route('https://pan.baidu.com/**', (route) => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><title>Isolated test page</title>'
        }));
        const businessPage = await context.newPage();
        await businessPage.goto('https://pan.baidu.com/review/manual');
        await page.locator('.edit').first().click();
        await businessPage.evaluate(() => {
            document.cookie = 'BP_NODE_CONTAINER_ID=manual-during-dialog; Path=/review; Secure';
        });
        // Let the change notification reach the debounce while the dialog is open.
        await page.waitForTimeout(400);
        if (close === 'escape') await page.keyboard.press('Escape');
        else await page.locator('#editor').getByRole('button', { name: '取消', exact: true }).click();
        await page.waitForFunction(() => document.getElementById('live-summary').textContent.includes('1 条'));
        assert.match(await page.locator('#inventory-list').textContent(), /manual-during-dialog/);
    });
}


for (const entry of ['editor', 'import', 'defaults']) {
    test(`${entry}: saved config remains acknowledged when status refresh fails`, async (t) => {
        const { page } = await launchExtension(t);
        const note = 'Saved config must remain visible';
        if (entry === 'editor') {
            await page.locator('.edit').first().click();
            await page.locator('#edit-note').fill(note);
        } else if (entry === 'import') {
            const config = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'defaults' })).data);
            config.groups[0].note = note;
            await page.locator('#import-file').setInputFiles({
                name: 'config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config))
            });
            await page.locator('#confirm').waitFor({ state: 'visible' });
        } else {
            await page.locator('#defaults').click();
        }
        await page.evaluate(() => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            let saved = false;
            chrome.runtime.sendMessage = async (message) => {
                if (saved && message.type === 'status') throw new Error('simulated status read failure');
                const response = await send(message);
                if (message.type === 'saveConfig' && response.ok) saved = true;
                return response;
            };
        });
        if (entry === 'editor') await page.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
        else await page.locator('#confirm-save').click();
        await page.locator('#notice').filter({ hasText: '配置已保存，但状态刷新失败' }).waitFor();
        const dialog = page.locator(entry === 'editor' ? '#editor' : '#confirm');
        assert.equal(await dialog.evaluate((node) => node.open), false);
        await dialog.waitFor({ state: 'hidden' });
        await page.reload();
        await page.locator('#apply-all:not([disabled])').waitFor();
        if (entry !== 'defaults') assert.equal(await page.locator('.group > .group-note').first().textContent(), note);
    });
}


test('status remembers manual Cookie paths across bundled config updates and worker restarts', async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'cookie-settle-update-'));
    const root = join(temporary, 'extension');
    await cp(join(extensionRoot, 'icons'), join(root, 'icons'), { recursive: true });
    for (const name of await readdir(extensionRoot)) {
        if (/\.(js|json|html|css)$/.test(name)) await copyFile(join(extensionRoot, name), join(root, name));
    }
    const profile = join(temporary, 'profile');
    const defaultsPath = join(root, 'default-config.json');
    const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
    const oldPath = defaults.groups[0].paths[0];
    const first = await launchExtension(t, { root, profile });
    await first.context.route('https://pan.baidu.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Isolated history test</title>'
    }));
    const businessPage = await first.context.newPage();
    await businessPage.goto(`https://pan.baidu.com${oldPath}`);
    await businessPage.evaluate((path) => {
        document.cookie = `BP_NODE_CONTAINER_ID=manual-old-default; Path=${path}; Secure; Max-Age=3600`;
    }, oldPath);
    await first.page.locator('#refresh-status').click();
    await first.page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    assert.equal(await first.worker.evaluate(async () => (await chrome.storage.local.get('config')).config), undefined);
    await first.context.close();
    defaults.groups[0].paths[0] = '/review/new-default';
    await writeFile(defaultsPath, JSON.stringify(defaults));
    const second = await launchExtension(t, { root, profile });
    t.after(() => rm(temporary, { recursive: true, force: true }));
    await second.page.locator('#clear-all').click();
    await second.page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
    const remaining = await second.worker.evaluate(() => chrome.cookies.getAll({ name: 'BP_NODE_CONTAINER_ID' }));
    assert.deepEqual(remaining, []);
});


test('canceling confirmation displays config saved in another window', async (t) => {
    const { page, context, url } = await launchExtension(t);
    const other = await context.newPage();
    await other.goto(url);
    await other.locator('#apply-all:not([disabled])').waitFor();
    await page.locator('#defaults').click();
    await other.locator('.edit').first().click();
    await other.locator('#edit-note').fill('Edited in another window');
    await other.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
    await other.locator('#notice').filter({ hasText: '配置已保存' }).waitFor();
    await page.waitForTimeout(400);
    await page.locator('#confirm [data-close]').click();
    await page.locator('.group > .group-note').first().filter({ hasText: 'Edited in another window' }).waitFor();
});

test('Cookie changes during an in-flight status read are checked again after it finishes', async (t) => {
    const { page, worker } = await launchExtension(t);
    await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let delay = true;
        chrome.runtime.sendMessage = async (message) => {
            const response = await send(message);
            if (message.type === 'status' && delay) {
                delay = false;
                await new Promise((resolve) => { window.releaseStatus = resolve; });
            }
            return response;
        };
    });
    await page.locator('#refresh-status').click();
    await page.waitForFunction(() => Boolean(window.releaseStatus));
    await worker.evaluate(() => chrome.cookies.set({
        url: 'https://pan.baidu.com/review', name: 'BP_NODE_CONTAINER_ID', value: 'changed-while-busy', path: '/review', secure: true
    }));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.releaseStatus());
    await page.waitForFunction(() => document.getElementById('inventory-list').textContent.includes('changed-while-busy'));
});

test('editing normalizes form fields and preserves the other groups', async (t) => {
    const { page } = await launchExtension(t);
    const original = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'status' })).data.config);
    await page.locator('.edit').first().click();
    await page.locator('#edit-name').fill('  Updated name  ');
    await page.locator('#edit-proxy').fill('http://localhost:8081/');
    await page.locator('#edit-container').fill('  updated-container  ');
    await page.locator('#edit-paths').fill('  /review/form-a  \n\n /review/form-b ');
    await page.locator('#edit-note').fill('  Updated note  ');
    await page.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
    await page.locator('#notice').filter({ hasText: '配置已保存' }).waitFor();
    const saved = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'status' })).data.config);
    assert.deepEqual(saved.groups[0], {
        id: original.groups[0].id, name: 'Updated name', proxy: 'http://localhost:8081',
        container: 'updated-container', paths: ['/review/form-a', '/review/form-b'], note: 'Updated note'
    });
    assert.deepEqual(saved.groups.slice(1), original.groups.slice(1));
});

test('storage errors are visible and leave real browser Cookies unchanged', async (t) => {
    const { page, worker } = await launchExtension(t);
    await worker.evaluate(() => {
        chrome.storage.local.set = async () => { throw new Error('simulated storage unavailable'); };
    });
    await page.locator('#apply-all').click();
    await page.locator('#notice').filter({ hasText: 'simulated storage unavailable' }).waitFor();
    assert.deepEqual(await worker.evaluate(() => chrome.cookies.getAll({})), []);
});


for (const entry of ['editor', 'import', 'defaults']) {
    test(`${entry}: Esc during a pending save keeps a subsequent failure visible`, async (t) => {
        const { page } = await launchExtension(t);
        if (entry === 'editor') {
            await page.locator('.edit').first().click();
            await page.locator('#edit-note').fill('Must not be saved');
        } else if (entry === 'import') {
            const config = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'defaults' })).data);
            config.groups[0].note = 'Must not be saved';
            await page.locator('#import-file').setInputFiles({
                name: 'config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config))
            });
            await page.locator('#confirm').waitFor({ state: 'visible' });
        } else {
            await page.locator('#defaults').click();
        }
        await page.evaluate(() => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (message) => {
                if (message.type === 'saveConfig') {
                    return new Promise((resolve, reject) => {
                        window.rejectSave = () => reject(new Error('delayed storage failure'));
                    });
                }
                return send(message);
            };
        });
        if (entry === 'editor') await page.locator('#edit-form').getByRole('button', { name: '保存配置' }).click();
        else await page.locator('#confirm-save').click();
        await page.waitForFunction(() => Boolean(window.rejectSave));
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.rejectSave());
        const dialog = entry === 'editor' ? '#editor' : '#confirm';
        const error = entry === 'editor' ? '#edit-error' : '#confirm-error';
        await page.locator(error).filter({ hasText: 'delayed storage failure' }).waitFor();
        assert.equal(await page.locator(dialog).isVisible(), true);
        await page.keyboard.press('Escape');
        await page.locator(dialog).waitFor({ state: 'hidden' });
    });
}
