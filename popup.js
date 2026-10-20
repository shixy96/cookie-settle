import { validateConfig, configPaths, hostPatterns } from './config.js';
import { COOKIE_NAMES } from './constants.js';
import { editGroup } from './config-editor.js';

const $ = (id) => document.getElementById(id);
const stateLabels = {
    active: '已启用', off: '未设置', mixed: '配置不一致',
    present: '已设置', partial: '缺少一项', conflict: '同名冲突'
};
let config;
let defaultHost;
let tabId;
let busy = false;
let editingId;
let editingBase;
let pendingConfig;
let pendingBase;
let updateTimer;
let noticeTimer;
let refreshPending = false;
let savedConfigAwaitingRefresh = false;
const dialogOpeners = new Map();

if (new URLSearchParams(location.search).get('view') === 'tab') {
    document.body.classList.add('full-page');
    $('expand').hidden = true;
    $('live-inspection').open = true;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function showNotice(text, error = false) {
    clearTimeout(noticeTimer);
    $('notice').textContent = text;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = false;
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3000);
}

function setBusy(value) {
    busy = value;
    document.querySelectorAll('button').forEach((button) => { button.disabled = value; });
    if (!value && !config) {
        ['apply-all', 'clear-all', 'export'].forEach((id) => { $(id).disabled = true; });
    }
    $('groups').setAttribute('aria-busy', String(value));
    if (!value) drainRefresh();
}

async function request(type, extra = {}) {
    const result = await chrome.runtime.sendMessage({ type, tabId, ...extra });
    if (!result?.ok) throw new Error(result?.error || '扩展服务未响应，请重新打开扩展。');
    return result.data;
}

function updateStatus(node, state) {
    node.className = `state ${state}`;
    node.textContent = stateLabels[state];
}

function statusNode(state) {
    return element('span', `state ${state}`, stateLabels[state]);
}

function actionButton(label, className, callback) {
    const button = element('button', className, label);
    button.title = label;
    button.addEventListener('click', callback);
    return button;
}

function cookieText(cookie) {
    const flags = [
        cookie.hostOnly ? '仅当前主机' : '包含子域',
        cookie.secure ? 'Secure' : '',
        cookie.httpOnly ? 'HttpOnly（页面 JS 不可读）' : '',
        cookie.partitioned ? '分区 Cookie' : ''
    ].filter(Boolean);
    return `${cookie.name}=${cookie.value}\nDomain：${cookie.domain}\nPath：${cookie.path}\n${flags.join(' · ')}`;
}

// Keep native focus and disclosure state on stable nodes; only reconcile membership/order.
function reconcile(container, entries, renderItem, fallback) {
    const focus = document.activeElement;
    const heldFocus = container.contains(focus);
    const previous = new Map([...container.children].map((node) => [node.dataset.key, node]));
    const kept = new Set();
    entries.forEach(([key, item], index) => {
        const node = renderItem(previous.get(key), item);
        node.dataset.key = key;
        kept.add(node);
        if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    for (const node of [...container.children]) {
        if (!kept.has(node)) node.remove();
    }
    if (heldFocus && document.activeElement === document.body) {
        (focus.isConnected ? focus : fallback).focus({ preventScroll: true });
    }
}

function renderPage(details, page, label) {
    if (!details) {
        details = element('details', 'live-page');
        const summary = element('summary', 'page-summary');
        summary.append(element('code'), statusNode(page.state));
        details.append(summary, element('div', 'page-content'));
    }
    details.dataset.path = page.path;
    details.querySelector('summary code').textContent = label;
    updateStatus(details.querySelector('.state'), page.state);
    const content = details.querySelector('.page-content');
    const context = [page.current ? '当前标签页' : '',
        page.tabCount > 1 ? `${page.tabCount} 个标签页` : ''].filter(Boolean).join(' · ');
    content.replaceChildren();
    if (context) content.append(element('p', 'inspection-help', context));
    content.append(page.cookies.length ?
        element('pre', 'actual-values', page.cookies.map(cookieText).join('\n\n')) :
        element('p', 'inspection-help', '没有匹配此页面 URL 的代理 Cookie。'));
    if (page.state === 'partial') content.append(element('p', 'inspection-help', `缺少 ${page.missing.join('、')}`));
    if (page.state === 'conflict') {
        content.append(element('p', 'inspection-help', '同一个名称匹配了多个 Domain / Path，可能导致路由异常。'));
    }
    return details;
}

function renderInspection(status) {
    $('live-summary').textContent = `实际 Cookie：${status.inventory.length} 条 · ${status.pages.length} 个页面路径`;
    reconcile($('page-checks'), status.pages.map((page) => [page.url, page]), (node, page) =>
        renderPage(node, page, status.pages.some((other) => other.url !== page.url && other.path === page.path) ?
            page.url : page.path), $('live-summary'));
    if (!status.pages.length) {
        $('page-checks').append(element('p', 'inspection-help empty-state',
            '打开目标站点页面后，这里会显示对应路径的实际 Cookie。'));
    }
    $('inventory-summary').textContent = `全部代理 Cookie（${status.inventory.length} 条，含未打开的路径）`;
    $('inventory-list').replaceChildren();
    if (!status.inventory.length) {
        $('inventory-list').append(element('p', 'inspection-help', '还没有代理 Cookie。启用环境，或在页面手动设置后检查。'));
    }
    for (const cookie of status.inventory) {
        const item = element('div', 'inventory-item');
        item.append(
            element('pre', 'actual-values', cookieText(cookie)),
            element('p', 'inspection-help', cookie.clearable ? (cookie.managed ?
                '位于当前或历史配置路径，可用“全部清理”移除。' :
                '对配置路径或已打开页面生效，可用“全部清理”移除；共享此 Cookie 的页面会一并受影响。') :
                '不在清理范围内；如需删除，请在开发者工具中处理。')
        );
        $('inventory-list').append(item);
    }
}

function renderPathDifferences(path) {
    const differences = element('div', 'path-differences');
    for (const name of path.missing) {
        differences.append(element('p', 'difference-missing', `缺少 ${name}`));
    }
    for (const { cookie, duplicate, wrongScope, wrongValue } of path.differences) {
        const entry = element('div', 'cookie-difference');
        const heading = element('p', 'difference-heading');
        heading.append(
            element('code', '', cookie.name),
            element('span', '', duplicate ? '同名冲突' : wrongScope ? '作用范围不一致' : '值不一致')
        );
        entry.append(heading);
        entry.append(wrongValue ?
            element('code', 'difference-value', cookie.value) :
            element('p', 'difference-note', '值与共用配置一致'));
        if (wrongScope || duplicate) {
            entry.append(element('p', 'difference-scope',
                `Domain：${cookie.domain}（${cookie.hostOnly ? '仅当前主机' : '包含子域'}）\nPath：${cookie.path}`));
        }
        differences.append(entry);
    }
    return differences;
}

function renderGroup(section, { group, status }) {
    if (!section) {
        section = element('section', 'group');
        section.dataset.id = group.id;
        const top = element('div', 'group-top');
        top.append(element('h3'), statusNode(status.state));
        const actions = element('div', 'group-actions');
        actions.append(
            actionButton('启用', 'apply', () => mutate('apply', group.id)),
            actionButton('清理', 'clear clear-action', () => mutate('clear', group.id)),
            actionButton('编辑配置', 'quiet edit', () => openEditor(config.groups.find((item) => item.id === group.id)))
        );
        const details = element('details');
        details.dataset.id = group.id;
        const shared = element('div', 'detail-config');
        shared.append(element('p', 'detail-heading', '共用 Cookie 配置'), element('dl', 'shared-cookies'));
        details.append(element('summary'), shared, element('ul', 'paths'));
        section.append(top, element('p', 'group-note'), actions, details);
    }
    section.dataset.state = status.state;
    section.querySelector('h3').textContent = group.name;
    updateStatus(section.querySelector('.group-top .state'), status.state);
    section.querySelector('.group-note').textContent = group.note;
    section.querySelector('summary').textContent = `${group.paths.length} 个路径`;
    section.querySelector('.shared-cookies').replaceChildren(...[group.container, group.proxy].flatMap((value, index) => {
        const name = element('dt');
        name.append(element('code', '', COOKIE_NAMES[index]));
        const content = element('dd');
        content.append(element('code', '', value));
        return [name, content];
    }));
    section.querySelector('.paths').replaceChildren(...status.paths.map((path) => {
        const item = element('li');
        const row = element('div', 'path-row');
        row.append(element('code', '', path.path), statusNode(path.state));
        item.append(row);
        if (path.state === 'mixed') item.append(renderPathDifferences(path));
        return item;
    }));
    return section;
}

function render(data) {
    config = data.config;
    const site = document.querySelector('.site-address');
    site.textContent = config.host;
    site.title = config.host;
    $('counts').textContent = `${config.groups.length} 组 / ${configPaths(config).length} 个路径`;
    reconcile($('groups'), config.groups.map((group) => [group.id,
        { group, status: data.status.groups.find((item) => item.id === group.id) }]), renderGroup, $('apply-all'));
    const warnings = [];
    if (data.status.leftovers.length) {
        warnings.push(`旧配置仍有 Cookie：${data.status.leftovers.join('、')}。点击“全部清理”可一并移除。`);
    }
    if (data.status.unmanaged.length) {
        const scopes = [...new Set(data.status.unmanaged.map((cookie) =>
            `${cookie.domain}${cookie.path}${cookie.partitioned ? '（分区 Cookie）' : ''}`
        ))];
        warnings.push(`发现范围外的代理 Cookie：${scopes.join('、')}。可能影响路由，本工具不会修改；请在开发者工具检查。`);
    }
    $('conflicts').textContent = warnings.join('\n');
    $('conflicts').hidden = !warnings.length;
    renderInspection(data.status);
    $('checked-at').textContent = `已检查 ${new Date(data.status.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function refresh() {
    refreshPending = false;
    try {
        const data = await request('status');
        render(data);
        savedConfigAwaitingRefresh = false;
    } catch (error) {
        if (savedConfigAwaitingRefresh) {
            throw new Error(`配置已保存，但状态刷新失败；请点击“检查状态”。${error.message}`);
        }
        throw error;
    }
}

async function saveConfigAndRefresh(next, base, dialogId, notice) {
    await request('saveConfig', { config: next, baseConfig: base });
    savedConfigAwaitingRefresh = true;
    $(dialogId).close();
    try {
        await refresh();
        showNotice(notice);
    } catch (error) {
        showNotice(error.message, true);
    }
}

async function run(task) {
    if (busy) return;
    const focus = document.activeElement;
    setBusy(true);
    try {
        await task();
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        setBusy(false);
        if (document.activeElement === document.body) {
            (focus.isConnected ? focus : $('apply-all')).focus({ preventScroll: true });
        }
    }
}

async function mutate(type, groupId) {
    await run(async () => {
        try {
            const result = await request(type, { groupId, baseConfig: config });
            await refresh();
            showNotice(type === 'apply' ?
                `已写入并校验 ${result.cookies} 个 Cookie，覆盖 ${result.paths} 个路径。请刷新业务页面。` :
                `已清理 ${result.cookies} 个代理 Cookie。请刷新业务页面；无需重新登录。`);
        } catch (error) {
            await refresh().catch(() => {});
            throw error;
        }
    });
}

function openDialog(id, opener) {
    dialogOpeners.set(id, opener);
    $(id).showModal();
}

function restoreDialogFocus(id) {
    if (busy || $(id).open) return;
    const opener = dialogOpeners.get(id);
    dialogOpeners.delete(id);
    if (opener && (document.activeElement === document.body || $(id).contains(document.activeElement))) {
        (opener.isConnected ? opener : $('apply-all')).focus({ preventScroll: true });
    }
}

function openEditor(group) {
    editingId = group.id;
    editingBase = structuredClone(config);
    $('editor-title').textContent = `编辑${group.name}`;
    $('edit-name').value = group.name;
    $('edit-proxy').value = group.proxy;
    $('edit-container').value = group.container;
    $('edit-paths').value = group.paths.join('\n');
    $('edit-note').value = group.note;
    $('edit-error').hidden = true;
    openDialog('editor', document.activeElement);
}

$('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
        const next = editGroup(editingBase, editingId, {
            name: $('edit-name').value,
            proxy: $('edit-proxy').value,
            container: $('edit-container').value,
            paths: $('edit-paths').value,
            note: $('edit-note').value
        });
        await saveConfigAndRefresh(next, editingBase, 'editor',
            '配置已保存。点击对应环境的“启用”写入新值；旧路径可用“全部清理”移除。');
    } catch (error) {
        $('edit-error').textContent = error.message;
        $('edit-error').hidden = false;
    } finally {
        setBusy(false);
        restoreDialogFocus('editor');
    }
});

function confirmConfig(next, title, opener) {
    pendingConfig = validateConfig(next, defaultHost);
    pendingBase = structuredClone(config);
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = `目标站点：${pendingConfig.host}。将使用 ${pendingConfig.groups.length} 个环境、${configPaths(pendingConfig).length} 个路径：`;
    $('confirm-groups').replaceChildren(...pendingConfig.groups.map((group) =>
        element('li', '', `${group.name}：${group.proxy}`)
    ));
    $('confirm-error').hidden = true;
    openDialog('confirm', opener);
}

$('confirm-save').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
        await saveConfigAndRefresh(pendingConfig, pendingBase, 'confirm',
            '配置已更新，Cookie 尚未改变。点击“启用”应用新环境。');
    } catch (error) {
        $('confirm-error').textContent = error.message;
        $('confirm-error').hidden = false;
    } finally {
        setBusy(false);
        restoreDialogFocus('confirm');
    }
});

document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => $(button.dataset.close).close());
});
$('apply-all').addEventListener('click', () => mutate('apply'));
$('clear-all').addEventListener('click', () => mutate('clear'));
$('refresh-status').addEventListener('click', () => run(async () => {
    await refresh();
    $('live-inspection').open = true;
    showNotice('状态已更新，已重新读取浏览器实际 Cookie，包含页面上手动设置的值。');
}));
$('expand').addEventListener('click', () => run(async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') });
}));
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', () => run(async () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (!file) return;
    if (file.size > 65536) throw new Error('配置文件不能超过 64 KB。');
    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new Error('配置文件不是有效 JSON，请检查文件格式。');
    }
    confirmConfig(parsed, '导入配置', $('import'));
}));
$('defaults').addEventListener('click', () => run(async () => {
    confirmConfig(await request('defaults'), '恢复内置环境配置', $('defaults'));
}));
$('export').addEventListener('click', () => run(async () => {
    const blob = new Blob([`${JSON.stringify(config, null, 4)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cookie-settle-config.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showNotice('已导出环境配置，不包含浏览器中的登录 Cookie。');
}));
$('reload-tabs').addEventListener('click', () => run(async () => {
    const tabs = await chrome.tabs.query({ url: hostPatterns(config.host) });
    const results = await Promise.allSettled(tabs.map((tab) => chrome.tabs.reload(tab.id)));
    const failed = results.filter((result) => result.status === 'rejected').length;
    showNotice(`已刷新 ${tabs.length - failed} 个目标站点标签页。${failed ? `${failed} 个页面未能刷新，请手动重试。` : ''}`, failed > 0);
}));

function drainRefresh() {
    if (refreshPending && !busy && !$('editor').open && !$('confirm').open) {
        scheduleRefresh();
    }
}

function scheduleRefresh() {
    refreshPending = true;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
        if (refreshPending && !busy && !$('editor').open && !$('confirm').open) {
            run(refresh);
        }
    }, 250);
}
for (const id of ['editor', 'confirm']) {
    $(id).addEventListener('cancel', (event) => {
        if (busy) event.preventDefault();
    });
    $(id).addEventListener('close', () => {
        restoreDialogFocus(id);
        drainRefresh();
    });
}
chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (COOKIE_NAMES.includes(cookie.name)) scheduleRefresh();
});
chrome.storage.onChanged.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
        scheduleRefresh();
    }
});
chrome.tabs.onRemoved.addListener(scheduleRefresh);

run(async () => {
    defaultHost = (await request('defaults')).host;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
    await refresh();
});
