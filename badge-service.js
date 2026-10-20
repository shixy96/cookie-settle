// Coalesce Cookie bursts and serialize reads/writes so an older count cannot win.
export function createBadgeUpdater({ action, readStatus, updatePages = async () => {} }) {
    let pending = false;
    let running;
    let supplied;

    async function update() {
        do {
            pending = false;
            const snapshot = supplied;
            supplied = undefined;
            let text;
            let title;
            let color;
            let data;
            let count;
            try {
                data = snapshot || await readStatus();
                if (!data.status) throw new Error('Cookie status unavailable');
                count = data.status.groups.reduce((total, group) =>
                    total + group.paths.filter((path) => path.state === 'active').length, 0);
                text = count ? String(count) : '';
                title = `Cookie Settle · 已命中 ${count} 个配置路径`;
                color = '#51806a';
            } catch {
                text = '?';
                title = 'Cookie Settle · 状态读取失败，请打开面板重新检查';
                color = '#a65d14';
            }
            if (pending) continue;
            // A browser shutdown can reject action writes; the next wake retries.
            await Promise.allSettled([
                action.setBadgeBackgroundColor({ color }),
                action.setBadgeText({ text }),
                action.setTitle({ title })
            ]);
            if (!pending) await updatePages({ data, count });
        } while (pending);
    }

    return function refreshBadge(snapshot) {
        supplied = running ? undefined : snapshot;
        pending = true;
        running ||= update().finally(() => { running = undefined; });
        return running;
    };
}
