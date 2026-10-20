import {
    validateConfig, configPaths, validPath, buildStatus, summarizePageCookies, hostPatterns
} from './config.js';
import { mutateCookies, readRoutingCookies, readPageCookies } from './cookie-engine.js';

export function createMessageHandler({ storage, cookies, tabs, permissions, loadDefaults }) {
    let queue = Promise.resolve();

    async function loadState() {
        const [defaults, saved] = await Promise.all([
            loadDefaults(),
            storage.get(['config', 'managedPaths', 'managedHost', 'managedPathsByHost'])
        ]);
        const config = validateConfig(saved.config ?? defaults, defaults.host);
        const history = { ...saved.managedPathsByHost };
        const cleanPaths = (paths) => Array.isArray(paths) ? paths.filter(validPath) : [];
        // Unscoped legacy history has no reliable domain identity; do not infer it from mutable defaults.
        if (saved.managedHost) {
            history[saved.managedHost] = [...new Set([
                ...cleanPaths(history[saved.managedHost]), ...cleanPaths(saved.managedPaths)
            ])];
        }
        const managedPaths = [...new Set([
            ...(config.host === defaults.host ? configPaths(defaults) : []),
            ...cleanPaths(history[config.host]), ...configPaths(config)
        ])];
        history[config.host] = managedPaths;
        if (saved.managedHost !== config.host ||
            JSON.stringify(saved.managedPaths) !== JSON.stringify(managedPaths) ||
            JSON.stringify(saved.managedPathsByHost) !== JSON.stringify(history)) {
            await storage.set({ managedPaths, managedHost: config.host, managedPathsByHost: history });
        }
        return { config, managedPaths, history };
    }

    async function requireHostAccess(host) {
        if (!await permissions.contains({ origins: hostPatterns(host) })) {
            throw new Error(`目标站点 ${host} 未获授权；请在 manifest.json 中声明该站点的 HTTP/HTTPS 权限并重新加载扩展。`);
        }
    }

    async function storeFor(tabId) {
        const stores = await cookies.getAllCookieStores();
        const store = stores.find((item) => item.tabIds.includes(tabId)) ||
            (stores.length === 1 ? stores[0] : undefined);
        if (!store) {
            throw new Error('无法确定当前浏览器的 Cookie 存储区。请在普通窗口重新打开扩展。');
        }
        return store.id;
    }

    async function openPageTabs(host) {
        return (await tabs.query({ url: hostPatterns(host) }))
            .filter((tab) => !tab.incognito && tab.url);
    }

    async function handle(message) {
        if (message.type === 'defaults') {
            return loadDefaults();
        }
        const state = await loadState();
        if (['saveConfig', 'apply', 'clear'].includes(message.type) && message.baseConfig &&
            JSON.stringify(message.baseConfig) !== JSON.stringify(state.config)) {
            throw new Error('配置已在另一个窗口更新。请关闭此对话框，检查状态后重试。');
        }
        if (message.type === 'saveConfig') {
            const config = validateConfig(message.config, (await loadDefaults()).host);
            await requireHostAccess(config.host);
            const previousPaths = state.history[config.host];
            const managedPaths = [...new Set([
                ...(Array.isArray(previousPaths) ? previousPaths.filter(validPath) : []), ...configPaths(config)
            ])];
            await storage.set({ config, managedPaths, managedHost: config.host,
                managedPathsByHost: { ...state.history, [config.host]: managedPaths } });
            return { config };
        }
        if (message.type === 'indicatorStatus') {
            // Keep configuration available even when the Cookie store cannot be read.
            let status = null;
            try {
                await requireHostAccess(state.config.host);
                const storeId = await storeFor(message.tabId);
                status = buildStatus(state.config, await readRoutingCookies(cookies, storeId, state.config.host), state.managedPaths);
            } catch { /* The badge reports an unknown count; page matching still uses config. */ }
            return { config: state.config, status };
        }
        await requireHostAccess(state.config.host);
        const storeId = await storeFor(message.tabId);
        if (message.type === 'status') {
            const [routingCookies, openTabs] = await Promise.all([
                readRoutingCookies(cookies, storeId, state.config.host),
                openPageTabs(state.config.host)
            ]);
            const urls = new Map();
            for (const tab of openTabs) {
                const url = new URL(tab.url);
                const address = `${url.origin}${url.pathname}`;
                const existing = urls.get(address);
                if (existing) {
                    existing.tabCount += 1;
                    existing.current ||= tab.id === message.tabId;
                } else {
                    urls.set(address, {
                        url: address, path: url.pathname, tabCount: 1,
                        current: tab.id === message.tabId
                    });
                }
            }
            const pages = await Promise.all([...urls.values()].map(async (page) => ({
                ...page,
                ...summarizePageCookies(await readPageCookies(cookies, storeId, page.url, state.config.host))
            })));
            return {
                config: state.config,
                status: {
                    ...buildStatus(state.config, routingCookies, state.managedPaths, pages.map((page) => page.path)),
                    pages: pages.sort((a, b) => Number(b.current) - Number(a.current) || a.path.localeCompare(b.path)),
                    checkedAt: Date.now()
                }
            };
        }
        if (['apply', 'clear'].includes(message.type)) {
            const groups = message.groupId ?
                state.config.groups.filter((group) => group.id === message.groupId) :
                state.config.groups;
            if (!groups.length) {
                throw new Error('环境已不存在，请重新检查配置。');
            }
            // Persist cleanup scope before writing so future config edits cannot
            // strand Cookies on a previously configured path.
            await storage.set({ managedPaths: state.managedPaths });
            const effectivePaths = message.type === 'clear' && !message.groupId ?
                [...state.managedPaths, ...(await openPageTabs(state.config.host)).map((tab) => new URL(tab.url).pathname)] : [];
            return mutateCookies(
                cookies, storeId, groups, message.type,
                message.groupId ? configPaths({ groups }) : state.managedPaths, state.config.host, effectivePaths
            );
        }
        throw new Error('未知操作。');
    }

    return (message) => {
        const task = queue.then(() => handle(message));
        queue = task.catch(() => {});
        return task;
    };
}
