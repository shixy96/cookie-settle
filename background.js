import { createStatusIconRenderer } from './status-icon.js';
import { createPageIndicatorUpdater } from './page-indicator.js';
import { createBadgeUpdater } from './badge-service.js';
import { COOKIE_NAMES } from './constants.js';
import { loadDefaultConfig } from './default-config-loader.js';
import { createMessageHandler } from './background-service.js';

const handle = createMessageHandler({
    storage: chrome.storage.local,
    cookies: chrome.cookies,
    tabs: chrome.tabs,
    permissions: chrome.permissions,
    loadDefaults: loadDefaultConfig
});

const pageIndicators = createPageIndicatorUpdater({
    action: chrome.action,
    tabs: chrome.tabs,
    cookies: chrome.cookies,
    renderIcon: createStatusIconRenderer((path) => chrome.runtime.getURL(path))
});
let indicatorSnapshot;
const updateBadge = createBadgeUpdater({
    action: chrome.action,
    readStatus: () => handle({ type: 'indicatorStatus' }),
    updatePages: (snapshot) => {
        indicatorSnapshot = snapshot;
        return pageIndicators.update(snapshot);
    }
});

function refreshBadge(snapshot) {
    pageIndicators.invalidate();
    return updateBadge(snapshot);
}

chrome.tabs.onUpdated.addListener((tabId, changes) => {
    // Unpermitted destinations omit url; completion still resets their tab icon.
    if (changes.url === undefined && changes.status !== 'complete') return;
    if (indicatorSnapshot) void pageIndicators.update(indicatorSnapshot, tabId);
    else void refreshBadge();
});

chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (COOKIE_NAMES.includes(cookie.name)) {
        void refreshBadge();
    }
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) void refreshBadge();
});
chrome.runtime.onStartup.addListener(() => refreshBadge());
chrome.runtime.onInstalled.addListener(() => refreshBadge());
void refreshBadge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.incognito ||
        !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) {
        return false;
    }
    handle(message).then(
        (data) => {
            if (message.type === 'status') void refreshBadge(data);
            else if (['apply', 'clear'].includes(message.type)) void refreshBadge();
            sendResponse({ ok: true, data });
        },
        (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
});
