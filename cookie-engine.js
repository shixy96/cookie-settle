import { COOKIE_NAMES } from './constants.js';
import { isManaged, pathMatches, compareConfiguredCookies, clearablePaths } from './config.js';

export async function readRoutingCookies(api, storeId, host) {
    const lists = await Promise.all(COOKIE_NAMES.map((name) => api.getAll({ name, storeId })));
    return lists.flat().filter((cookie) => {
        const domain = cookie.domain.replace(/^\./, '');
        return domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`));
    });
}

export async function readPageCookies(api, storeId, pageUrl, host) {
    const url = new URL(pageUrl);
    if (url.hostname !== host || !['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`仅检查 http(s)://${host} 页面。`);
    }
    // Let Chrome resolve Domain/Path matching for the real page URL, including
    // manually written Cookies on deeper paths that are not in any preset.
    const lists = await Promise.all(COOKIE_NAMES.map((name) =>
        api.getAll({ url: `${url.origin}${url.pathname}`, name, storeId })
    ));
    return lists.flat().filter((cookie) => !cookie.partitionKey);
}

export function cookieDetails(cookie, storeId, host) {
    const details = {
        url: `https://${host}${cookie.path}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        storeId
    };
    if (!cookie.hostOnly) {
        details.domain = cookie.domain;
    }
    if (!cookie.session && cookie.expirationDate !== undefined) {
        details.expirationDate = cookie.expirationDate;
    }
    return details;
}

async function removeAtPath(api, storeId, path, name, host) {
    const owned = (await api.getAll({ url: `https://${host}${path}`, name, storeId }))
        .filter((cookie) => isManaged(cookie, [path], host));
    if (!owned.length) return;
    // Expire the exact identity: URL-based removal can select an ancestor Cookie.
    for (const cookie of owned) {
        await api.set({ ...cookieDetails(cookie, storeId, host), expirationDate: 0 });
    }
    const remaining = await api.getAll({ url: `https://${host}${path}`, name, storeId });
    if (remaining.some((cookie) => isManaged(cookie, [path], host))) {
        throw new Error(`${path} 的 ${name} 未能删除，请重试检查。`);
    }
}

async function clearPaths(api, storeId, paths, host) {
    for (const path of [...paths].sort((a, b) => b.length - a.length)) {
        for (const name of COOKIE_NAMES) {
            await removeAtPath(api, storeId, path, name, host);
        }
    }
}

function fingerprint(cookies) {
    return cookies.map((cookie) => JSON.stringify([
        cookie.name, cookie.value, cookie.domain, cookie.path, cookie.hostOnly,
        cookie.secure, cookie.httpOnly, cookie.sameSite, cookie.session,
        cookie.expirationDate ?? null
    ])).sort().join('\n');
}

async function restoreSnapshot(api, storeId, paths, snapshot, host) {
    let current = [];
    const failures = [];
    try {
        current = (await readRoutingCookies(api, storeId, host)).filter((cookie) => isManaged(cookie, paths, host));
    } catch (error) {
        // An unavailable inventory must not prevent restoring known snapshot values.
        failures.push(error.message);
    }
    for (const path of [...paths].sort((a, b) => b.length - a.length)) {
        for (const name of COOKIE_NAMES) {
            const original = snapshot.filter((cookie) => cookie.path === path && cookie.name === name);
            const remaining = current.filter((cookie) => cookie.path === path && cookie.name === name);
            if (fingerprint(original) === fingerprint(remaining)) continue;
            // Remove only newly introduced identities; restoring an old value needs no delete.
            if (remaining.some((cookie) => !original.some((old) => old.domain === cookie.domain))) {
                try {
                    await removeAtPath(api, storeId, path, name, host);
                } catch (error) {
                    failures.push(error.message);
                }
            }
            for (const cookie of original) {
                try {
                    await api.set(cookieDetails(cookie, storeId, host));
                } catch (error) {
                    failures.push(error.message);
                }
            }
        }
    }
    const restored = (await readRoutingCookies(api, storeId, host)).filter((cookie) => isManaged(cookie, paths, host));
    if (fingerprint(restored) !== fingerprint(snapshot)) {
        throw new Error(failures.join('；') || '恢复后校验不一致');
    }
}

export async function mutateCookies(api, storeId, groups, action, managedPaths, host, effectivePaths = []) {
    if (!['apply', 'clear'].includes(action)) {
        throw new Error('不支持的 Cookie 操作。');
    }
    const targets = [...new Set(action === 'apply' ?
        groups.flatMap((group) => group.paths) : managedPaths)];
    const before = await readRoutingCookies(api, storeId, host);
    const paths = action === 'clear' ? clearablePaths(before, targets, effectivePaths, host) : targets;
    const snapshot = before.filter((cookie) => isManaged(cookie, paths, host));
    if (action === 'apply') {
        const conflicts = before.filter((cookie) => !cookie.partitionKey &&
            !isManaged(cookie, paths, host) &&
            paths.some((path) => pathMatches(cookie.path, path)));
        if (conflicts.length) {
            const first = conflicts[0];
            const guidance = isManaged(first, [first.path], host) ?
                '请先使用“全部清理”移除共享路径 Cookie，再启用' : '请先在开发者工具处理，再启用';
            throw new Error(`发现范围外的代理 Cookie：${first.domain}${first.path}（${first.name}）。${guidance}；本次未修改 Cookie。`);
        }
    }
    if (action === 'clear') {
        // Check every target before deleting any Cookie in the batch.
        const conflict = before.find((cookie) => !cookie.partitionKey &&
            !isManaged(cookie, paths, host) && snapshot.some((owned) =>
                owned.name === cookie.name && owned.path === cookie.path));
        if (conflict) {
            throw new Error(`${conflict.path} 存在父域同名 Cookie，无法安全清理 ${conflict.name}；本次未修改 Cookie。`);
        }
    }
    try {
        await clearPaths(api, storeId, paths, host);
        if (action === 'apply') {
            for (const group of groups) {
                for (const path of group.paths) {
                    for (const [index, name] of COOKIE_NAMES.entries()) {
                        const saved = await api.set({
                            url: `https://${host}${path}`,
                            name,
                            value: [group.container, group.proxy][index],
                            path,
                            secure: true,
                            httpOnly: false,
                            sameSite: 'lax',
                            storeId
                        });
                        if (!saved) {
                            throw new Error(`${path} 的 ${name} 写入失败。`);
                        }
                    }
                }
            }
        }
        const after = await readRoutingCookies(api, storeId, host);
        const owned = after.filter((cookie) => isManaged(cookie, paths, host));
        if (action === 'clear' && owned.length) {
            throw new Error('清理后仍有代理 Cookie，请重新检查。');
        }
        if (action === 'apply') {
            for (const group of groups) {
                for (const path of group.paths) {
                    const relevant = after.filter((cookie) => !cookie.partitionKey && pathMatches(cookie.path, path));
                    if (compareConfiguredCookies(group, path, relevant, { host }).state !== 'active') {
                        throw new Error(`${path} 写入后的校验未通过。`);
                    }
                }
            }
        }
        return { paths: paths.length, cookies: action === 'apply' ? owned.length : snapshot.length };
    } catch (error) {
        try {
            await restoreSnapshot(api, storeId, paths, snapshot, host);
        } catch (rollbackError) {
            throw new Error(`${error.message} 自动恢复未完成：${rollbackError.message}。请立即检查当前 Cookie 状态。`);
        }
        throw new Error(`${error.message} 已恢复操作前的 Cookie 值和属性。`);
    }
}
