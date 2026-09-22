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
        axios = { get: jest.fn().mockResolvedValue({ data: '9.9.9' }) };

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

    test('prefers the newest locally installed client over the remote feed', async () => {
        for (const name of [
            'projectx-2.6.9.jar',
            'projectx-2.6.22.jar',
            'projectx-2.6.3.jar',
            'projectx-launcher-1.0.0.jar'
        ]) {
            fs.writeFileSync(path.join(testTempDir, name), '');
        }

        const version = await registeredHandlers['fetch-client-version']();

        expect(version).toBe('2.6.22');
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('falls back to the remote feed when no client is installed', async () => {
        const version = await registeredHandlers['fetch-client-version']();

        expect(version).toBe('9.9.9');
        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('/api/version/client')
        );
    });
});
