import test from 'node:test';
import assert from 'node:assert/strict';
import { createBadgeUpdater } from '../badge-service.js';

const snapshot = (state) => ({ config: { groups: [] }, status: { groups: [{ paths: [{ state }] }] } });
function actionLog() {
    const texts = [];
    return { texts, action: { setBadgeText: async ({ text }) => texts.push(text),
        setBadgeBackgroundColor: async () => {}, setTitle: async () => {} } };
}

test('a completed panel snapshot updates the badge without another Cookie read', async () => {
    const { action, texts } = actionLog();
    let reads = 0;
    const update = createBadgeUpdater({ action, readStatus: async () => { reads += 1; return snapshot('off'); } });
    await update(snapshot('active'));
    assert.equal(reads, 0);
    assert.deepEqual(texts, ['1']);
});

test('an in-flight invalidation takes precedence over a supplied stale snapshot', async () => {
    const { action, texts } = actionLog();
    let release;
    let reads = 0;
    const update = createBadgeUpdater({ action, readStatus: async () => {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => { release = () => resolve(snapshot('active')); });
        return snapshot('off');
    } });
    const first = update();
    const second = update(snapshot('active'));
    release();
    await Promise.all([first, second]);
    assert.equal(reads, 2);
    assert.deepEqual(texts, ['']);
});
