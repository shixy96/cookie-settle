const COLORS = {
    active: '#32a875', off: '#d5dce5', mixed: '#d99835',
    unknown: '#596579'
};

export function createStatusIconRenderer(getURL) {
    const cache = new Map();
    return function renderIcon(state) {
        if (!cache.has(state)) {
            const image = Promise.all([16, 32].map(async (size) => {
                const response = await fetch(getURL(`icons/${size}.png`));
                if (!response.ok) throw new Error('Unable to load extension logo');
                const bitmap = await createImageBitmap(await response.blob());
                const canvas = new OffscreenCanvas(size, size);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                // Cover the original decorative dot without redrawing the C logo.
                const blue = ctx.getImageData(Math.floor(size * .9), Math.floor(size / 2), 1, 1).data;
                ctx.fillStyle = `rgb(${blue[0]}, ${blue[1]}, ${blue[2]})`;
                ctx.beginPath();
                ctx.arc(size * .765625, size * .2734375, size * .09, 0, Math.PI * 2);
                ctx.fill();
                if (state === 'unmatched') {
                    return [size, ctx.getImageData(0, 0, size, size)];
                }
                // A 4.5px dot with a light rim stays legible on a 16px toolbar icon.
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(size * .1875, size * .1875, size * .171875, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = COLORS[state];
                ctx.beginPath();
                ctx.arc(size * .1875, size * .1875, size * .140625, 0, Math.PI * 2);
                ctx.fill();
                return [size, ctx.getImageData(0, 0, size, size)];
            })).then(Object.fromEntries).catch((error) => {
                cache.delete(state);
                throw error;
            });
            cache.set(state, image);
        }
        return cache.get(state);
    };
}
