import { pathMatches, compareConfiguredCookies } from './config.js';
import { readPageCookies } from './cookie-engine.js';

function pageURL(address, host) {
    let url;
    try { url = new URL(address); } catch { return undefined; }
    if ((host && url.hostname !== host) || !['http:', 'https:'].includes(url.protocol)) return undefined;
    return url;
}

function pageMatch(config, url) {
    for (const group of config.groups) {
        const path = group.paths.find((path) => pathMatches(path, url.pathname));
        if (path) return { group, path };
    }
}

function describeCookies({ group, path }, cookies) {
    const { state, missing, differences } = compareConfiguredCookies(group, path, cookies, { exactScope: false });
    if (state === 'off') return { state, reason: '尚未设置 Cookie' };
    const reasons = missing.map((name) => `缺少 Cookie：${name}`);
    for (const { cookie, duplicate, wrongValue } of differences) {
        if (duplicate) {
            const reason = `同名冲突：${cookie.name}`;
            if (!reasons.includes(reason)) reasons.push(reason);
        } else if (wrongValue) {
            reasons.push(`值不一致：${cookie.name}`);
        }
    }
    const scopes = [...new Set(cookies.map((cookie) => `Domain=${cookie.domain}，Path=${cookie.path}`))];
    const reason = reasons.length ? reasons.join('；') : 'Cookie 与配置一致';
    return { state, reason: `${reason}；生效范围：${scopes.join('；')}` };
}

export function createPageIndicatorUpdater({ action, tabs, cookies, renderIcon }) {
    let revision = 0;
    let lastConfig;
    return {
        invalidate() { revision += 1; },
        async update({ data, count }, tabId) {
            // A fresh global snapshot supersedes checks using the previous configuration.
            if (tabId === undefined) revision += 1;
            const version = revision;
            if (data?.config) lastConfig = data.config;
            const config = data?.config || lastConfig;
            let openTabs;
            try { openTabs = tabId === undefined ? await tabs.query({}) : [await tabs.get(tabId)]; } catch {
                // Tabs may be unavailable during shutdown; the next event retries.
                return;
            }
            let stores;
            try { stores = await cookies.getAllCookieStores(); } catch { stores = []; }
            await Promise.all(openTabs.filter((tab) => !tab.incognito).map(async (tab) => {
                let result = { state: 'unmatched', reason: '当前页面未命中配置' };
                try {
                    const url = pageURL(tab.url, config?.host);
                    if (url && !config) throw new Error('配置读取失败');
                    const match = url && pageMatch(config, url);
                    if (match) {
                        if (!data || data.status === null) throw new Error('状态读取失败');
                        const store = stores.find((store) => store.tabIds.includes(tab.id));
                        if (!store) throw new Error('无法确定 Cookie 存储区');
                        const actual = await readPageCookies(cookies, store.id, tab.url, config.host);
                        result = describeCookies(match, actual);
                        result.reason = `${match.group.name}（${match.path}）：${result.reason}`;
                    }
                } catch {
                    result = { state: 'unknown', reason: '状态读取失败，请打开面板重新检查' };
                }
                if (version !== revision) return;
                try {
                    const imageData = await renderIcon(result.state);
                    const current = await tabs.get(tab.id);
                    if (version !== revision || current.url !== tab.url) return;
                    await action.setIcon({ tabId: tab.id, imageData });
                    if (version !== revision) return;
                    const total = count === undefined ? '全部配置匹配数量读取失败' : `全部配置已匹配 ${count} 条路径`;
                    await action.setTitle({ tabId: tab.id,
                        title: `Cookie Settle · 当前页：${result.reason} · ${total}` });
                } catch {
                    // The tab may have closed while its Cookies were being read.
                }
            }));
        }
    };
}
