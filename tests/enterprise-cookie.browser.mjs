import assert from 'node:assert/strict';
import test from 'node:test';
import { launchExtension } from './browser-helpers.mjs';

test('enterprise page manual Cookies without Secure are visible in the live check', async (t) => {
    const { context, page } = await launchExtension(t, { config: {
        version: 1, groups: [{
            id: 'enterprise-review', name: 'Manual Cookie regression', note: '',
            container: '0.opera-70849400-SceneEnterpriseNodeServer-000-all.TOOS.yq01f',
            proxy: 'http://yq01-sys-rpm-ps10774.yq01.baidu.com:8075',
            paths: ['/disk/enterprise']
        }]
    } });
    await context.route('https://pan.baidu.com/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Enterprise Cookie test</title>'
    }));
    const business = await context.newPage();
    await business.goto('https://pan.baidu.com/disk/enterprise?cid=1000023900747#/index?category=all');
    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=0.opera-70849400-SceneEnterpriseNodeServer-000-all.TOOS.yq01f;path=/disk/enterprise';
        document.cookie = 'BP_NODE_PROXY_PASS=http://yq01-sys-rpm-ps10774.yq01.baidu.com:8075;path=/disk/enterprise';
    });
    // Verify the browser accepted both writes before testing the extension's view.
    const actual = (await context.cookies(business.url())).map(({ name, domain, path, secure }) =>
        ({ name, domain, path, secure })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(actual, ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS'].map((name) => ({
        name, domain: 'pan.baidu.com', path: '/disk/enterprise', secure: false
    })));
    await page.locator('#refresh-status').click();
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    assert.match(await page.locator('#live-summary').textContent(), /实际 Cookie：2 条/);
    assert.equal(await page.locator('.live-page[data-path="/disk/enterprise"] .state').textContent(), '已设置');
    const configuredPath = page.locator('.paths li').filter({ has: page.locator('code', { hasText: /^\/disk\/enterprise$/ }) });
    assert.equal(await configuredPath.locator('.state').textContent(), '已启用');

    await page.locator('.group').filter({ hasText: 'Manual Cookie regression' }).getByRole('button', { name: '清理' }).click();
    await page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
    assert.deepEqual(
        (await context.cookies(business.url())).filter((cookie) =>
            ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS'].includes(cookie.name)
        ),
        []
    );

    await business.evaluate(() => {
        document.cookie = 'BP_NODE_CONTAINER_ID=manual-enterprise-container;path=/disk/enterprise';
        document.cookie = 'BP_NODE_PROXY_PASS=http://manual.enterprise:8075;path=/disk/enterprise';
    });
    await page.locator('#refresh-status').click();
    await page.locator('#notice').filter({ hasText: '状态已更新' }).waitFor();
    await page.locator('#clear-all').click();
    await page.locator('#notice').filter({ hasText: '已清理' }).waitFor();
    assert.deepEqual(
        (await context.cookies(business.url())).filter((cookie) =>
            ['BP_NODE_CONTAINER_ID', 'BP_NODE_PROXY_PASS'].includes(cookie.name)
        ),
        []
    );
});
