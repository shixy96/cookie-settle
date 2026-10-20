import { validateConfig } from './config.js';

export function editGroup(base, groupId, fields) {
    return validateConfig({
        ...base,
        groups: base.groups.map((group) => group.id === groupId ? {
            ...group,
            name: fields.name.trim(),
            proxy: fields.proxy.trim(),
            container: fields.container.trim(),
            paths: fields.paths.split('\n').map((path) => path.trim()).filter(Boolean),
            note: fields.note.trim()
        } : group)
    });
}
