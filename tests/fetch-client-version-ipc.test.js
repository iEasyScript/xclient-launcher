const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('../libs/oauth-jagex.js', () => ({
    startAuthFlow: jest.fn(),
    writeAccountsToFile: jest.fn()
}));

describe('fetch-client-version IPC handler', () => {
    let testTempDir;
    let registeredHandlers;
    let axios;

    beforeEach(async () => {
        testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxtest-'));
        registeredHandlers = {};
        // The client version is the tag of the newest release on GitHub.
        axios = { get: jest.fn().mockResolvedValue({ data: { tag_name: 'v9.9.9' } }) };

        const ipcHandlersFn = require('../libs/ipc-handlers.js');
        await ipcHandlersFn({
            ipcMain: {
                handle: (channel, fn) => {
                    registeredHandlers[channel] = fn;
                }
            },
            axios,
            projectxDir: testTempDir,
            packageJson: { version: '1.0.0' },
            path,
            log: { info: jest.fn(), error: jest.fn() },
            dialog: {},
            fs,
            projectDir: path.join(__dirname, '..'),
            app: {}
        });
    });

    afterEach(() => {
        fs.rmSync(testTempDir, { recursive: true, force: true });
        jest.clearAllMocks();
    });

    const installClients = (...names) => {
        for (const name of names) {
            fs.writeFileSync(path.join(testTempDir, name), '');
        }
    };

    test('uses the published release even when a higher version is installed', async () => {
        // The case that stranded users: versioning restarted below the numbers
        // already on disk, and an installed 2.6.22 outranked the published
        // release forever.
        installClients('projectx-2.6.22.jar', 'projectx-2.6.9.jar');

        const version = await registeredHandlers['fetch-client-version']();

        // The leading "v" of a tag is not part of the version.
        expect(version).toBe('9.9.9');
        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('/xclient/releases/latest')
        );
    });

    test('uses the published release when nothing is installed', async () => {
        const version = await registeredHandlers['fetch-client-version']();

        expect(version).toBe('9.9.9');
    });

    test('falls back to the newest installed client when the release is unreachable', async () => {
        // Offline should still start the client already on disk rather than
        // refusing to launch at all.
        axios.get.mockRejectedValue(new Error('ENOTFOUND'));
        installClients(
            'projectx-2.6.9.jar',
            'projectx-2.6.22.jar',
            'projectx-2.6.3.jar',
            'projectx-launcher-1.0.0.jar'
        );

        const version = await registeredHandlers['fetch-client-version']();

        expect(version).toBe('2.6.22');
    });

    test('reports a problem when there is neither a release nor a local client', async () => {
        axios.get.mockRejectedValue(new Error('ENOTFOUND'));

        const version = await registeredHandlers['fetch-client-version']();

        expect(version).toHaveProperty('error');
    });

    test('a pinned version overrides everything, for local builds', async () => {
        process.env.PROJECTX_CLIENT_VERSION = '1.2.3-dev';
        try {
            installClients('projectx-2.6.22.jar');

            const version = await registeredHandlers['fetch-client-version']();

            expect(version).toBe('1.2.3-dev');
            expect(axios.get).not.toHaveBeenCalled();
        } finally {
            delete process.env.PROJECTX_CLIENT_VERSION;
        }
    });
});
