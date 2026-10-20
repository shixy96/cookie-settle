import { COOKIE_NAMES } from './constants.js';

export function pathMatches(cookiePath, requestPath) {
    return requestPath === cookiePath ||
        (requestPath.startsWith(cookiePath) &&
            (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}

export function validPath(path) {
    return typeof path === 'string' && path.length <= 200 &&
        /^\/[a-zA-Z0-9_/-]+$/.test(path) && !path.includes('//');
}

export function validateConfig(input, fallbackHost) {
    if (!input || input.version !== 1 || !Array.isArray(input.groups) ||
        input.groups.length < 1 || input.groups.length > 12) {
        throw new Error('配置必须是 version: 1，且包含 1–12 个环境组。');
    }
    const host = input.host === undefined ? fallbackHost : input.host;
    if (typeof host !== 'string' || host.length > 253 ||
        !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
        new URL(`https://${host}`).hostname !== host.toLowerCase()) {
        throw new Error('目标域名无效：请填写主机名，不含协议、端口、路径或通配符。');
    }
    const ids = new Set();
    const allPaths = [];
    const groups = input.groups.map((group) => {
        if (!group || typeof group.id !== 'string' ||
            !/^[a-z][a-z0-9-]{0,39}$/.test(group.id) || ids.has(group.id)) {
            throw new Error('环境 ID 必须唯一，且只包含小写字母、数字和连字符。');
        }
        ids.add(group.id);
        if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 60) {
            throw new Error('环境名称不能为空，且最多 60 个字符。');
        }
        if (typeof group.container !== 'string' ||
            !/^[a-zA-Z0-9._:-]{1,512}$/.test(group.container)) {
            throw new Error(`${group.name}：容器 ID 只能包含字母、数字、点、下划线、冒号和连字符。`);
        }
        let proxy;
        try {
            proxy = new URL(group.proxy);
        } catch {
            throw new Error(`${group.name}：代理地址不是有效 URL。`);
        }
        if (!['http:', 'https:'].includes(proxy.protocol) ||
            proxy.username || proxy.password || proxy.search || proxy.hash ||
            proxy.pathname !== '/' || proxy.origin.length > 512) {
            throw new Error(`${group.name}：代理地址仅支持 http(s)://主机:端口，不含路径、账号或参数。`);
        }
        if (!Array.isArray(group.paths) || group.paths.length < 1 || group.paths.length > 16) {
            throw new Error(`${group.name}：请填写 1–16 个路径。`);
        }
        const paths = group.paths.map((path) => {
            if (!validPath(path)) {
                throw new Error(`${group.name}：路径 ${String(path)} 无效；不允许根路径、空格或查询参数。`);
            }
            if (allPaths.some((other) => pathMatches(path, other) || pathMatches(other, path))) {
                throw new Error(`路径 ${path} 与其他路径重复或嵌套，会导致同名 Cookie 冲突。`);
            }
            allPaths.push(path);
            return path;
        });
        return {
            id: group.id,
            name: group.name.trim(),
            note: typeof group.note === 'string' ? group.note.slice(0, 300) : '',
            container: group.container,
            proxy: proxy.origin,
            paths
        };
    });
    if (allPaths.length > 32) {
        throw new Error('所有环境合计最多支持 32 个路径。');
    }
    return { version: 1, host: host.toLowerCase(), groups };
}

export function configPaths(config) {
    return config.groups.flatMap((group) => group.paths);
}

export function isManaged(cookie, paths, host) {
    return COOKIE_NAMES.includes(cookie.name) && paths.includes(cookie.path) &&
        [host, `.${host}`].includes(cookie.domain) && !cookie.partitionKey;
}

export function clearablePaths(cookies, managedPaths, effectivePaths = [], host) {
    return [...new Set([...managedPaths, ...cookies.filter((cookie) =>
        isManaged(cookie, [cookie.path], host) && effectivePaths.some((path) => pathMatches(cookie.path, path))
    ).map((cookie) => cookie.path)])];
}

export function cookieView(cookie) {
    return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        hostOnly: cookie.hostOnly,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        session: cookie.session,
        expirationDate: cookie.expirationDate,
        partitioned: Boolean(cookie.partitionKey)
    };
}

export function summarizePageCookies(cookies) {
    const counts = COOKIE_NAMES.map((name) => cookies.filter((cookie) => cookie.name === name).length);
    const missing = COOKIE_NAMES.filter((name, index) => counts[index] === 0);
    return {
        state: counts.some((count) => count > 1) ? 'conflict' :
            counts.every((count) => count === 0) ? 'off' :
                missing.length ? 'partial' : 'present',
        missing,
        cookies: cookies.map(cookieView)
    };
}

// Callers select the applicable Cookies; this comparison does not infer URL scope.
export function compareConfiguredCookies(group, path, cookies, { exactScope = true, host } = {}) {
    const missing = [];
    const differences = [];
    const values = [group.container, group.proxy];
    COOKIE_NAMES.forEach((name, index) => {
        const matches = cookies.filter((cookie) => cookie.name === name);
        if (!matches.length) missing.push(name);
        for (const cookie of matches) {
            const duplicate = matches.length > 1;
            const wrongScope = exactScope && (cookie.domain !== host || !cookie.hostOnly || cookie.path !== path);
            const wrongValue = cookie.value !== values[index];
            if (duplicate || wrongScope || wrongValue) {
                differences.push({ cookie: cookieView(cookie), duplicate, wrongScope, wrongValue });
            }
        }
    });
    return { state: !cookies.length ? 'off' : missing.length || differences.length ? 'mixed' : 'active',
        missing, differences };
}

export function buildStatus(config, cookies, managedPaths, pagePaths = []) {
    const groups = config.groups.map((group) => {
        const paths = group.paths.map((path) => {
            const relevant = cookies.filter((cookie) => !cookie.partitionKey &&
                pathMatches(cookie.path, path));
            return { path, ...compareConfiguredCookies(group, path, relevant, { host: config.host }) };
        });
        return {
            id: group.id,
            state: paths.every((path) => path.state === 'active') ? 'active' :
                paths.every((path) => path.state === 'off') ? 'off' : 'mixed',
            paths
        };
    });
    const currentPaths = configPaths(config);
    const leftovers = [...new Set(cookies.filter((cookie) =>
        isManaged(cookie, managedPaths, config.host) && !currentPaths.includes(cookie.path)
    ).map((cookie) => cookie.path))];
    const cleanup = clearablePaths(cookies, managedPaths, [...managedPaths, ...pagePaths], config.host);
    const unmanaged = cookies.filter((cookie) => !isManaged(cookie, cleanup, config.host)).map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        partitioned: Boolean(cookie.partitionKey)
    }));
    const inventory = cookies.map((cookie) => ({
        ...cookieView(cookie),
        managed: isManaged(cookie, managedPaths, config.host),
        clearable: isManaged(cookie, cleanup, config.host)
    }));
    return { groups, leftovers, unmanaged, inventory };
}

export function hostPatterns(host) {
    return [`http://${host}/*`, `https://${host}/*`];
}
