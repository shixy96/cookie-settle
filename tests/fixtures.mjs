export function configFixture() {
    return {
        version: 1,
        host: 'pan.baidu.com',
        groups: [
            { id: 'primary', name: 'Primary', note: 'Primary fixture', container: 'test-main',
                proxy: 'http://localhost:8001', paths: ['/review/main', '/review/preview'] },
            { id: 'secondary', name: 'Secondary', note: 'Secondary fixture', container: 'test-other',
                proxy: 'http://localhost:8002', paths: ['/review/other'] }
        ]
    };
}
