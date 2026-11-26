'use strict';

const fs = require('fs');
const path = require('path');
const { CHANNELS, EVENTS, buildHandlers, registerIpc } = require('../src/main/ipc');
const { handleWindowOpen, isHttpsUrl, stripHash, isTrustedFrame, createMainWindow } = require('../src/main/window');
const { makeLog } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');

function loadPreload() {
    const exposed = {};
    const ipcRenderer = { invoke: jest.fn(async () => 'ok'), on: jest.fn(), removeListener: jest.fn() };
    jest.isolateModules(() => {
        jest.doMock('electron', () => ({
            contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
            ipcRenderer
        }));
        require(PRELOAD);
    });
    return { exposed, ipcRenderer };
}

describe('preload bridge', () => {
    test('exposes only the named functions under window.launcher', () => {
        const { exposed } = loadPreload();
        expect(Object.keys(exposed)).toEqual(['launcher']);
        expect(Object.keys(exposed.launcher).sort()).toEqual([
            'accountsFileState', 'addJagexAccounts', 'appInfo', 'assignPreset', 'cancelPairing', 'checkClientUpdate',
            'close', 'closeClient', 'confirmOutdated', 'copyPairingLink', 'deleteAccount', 'deletePreset', 'downloadClient', 'getNews',
            'getNicknames', 'getNormalProfile', 'getPanelSettings', 'getPresets', 'getSession', 'getSettings',
            'importVpnConfig', 'launchJagex', 'launchNormal', 'listAccounts', 'listInstalledClients', 'listLiveClients', 'listMyScripts', 'listProfiles',
            'listRunning', 'log', 'lookupHiscores', 'minimize', 'onDownloadProgress', 'onPairingResult',
            'onRunningChanged', 'openLocation', 'refreshAccounts', 'removeAllAccounts', 'reopenPairingPage',
            'resolveClientVersion', 'savePreset', 'setAccountProfile', 'setNickname', 'setNormalProfile',
            'setPanelSettings', 'setSetting', 'showError', 'signOut', 'startPairing', 'stopRemote', 'testVpnConfig', 'toggleMaximize'
        ]);
        expect(Object.isFrozen(exposed.launcher)).toBe(true);
        for (const banned of ['invoke', 'send', 'on', 'sendSync', 'ipcRenderer']) {
            expect(exposed.launcher).not.toHaveProperty(banned);
        }
    });

    test('every function maps to its own channel with the arguments passed through', async () => {
        const { exposed, ipcRenderer } = loadPreload();
        await exposed.launcher.setNickname('111', 'WC');
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(CHANNELS.setNickname, '111', 'WC');
        for (const [name, channel] of Object.entries(CHANNELS)) {
            ipcRenderer.invoke.mockClear();
            await exposed.launcher[name]();
            expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel);
        }
    });

    test('events subscribe to the two allowed channels and can unsubscribe', () => {
        const { exposed, ipcRenderer } = loadPreload();
        const callback = jest.fn();
        const stop = exposed.launcher.onDownloadProgress(callback);
        expect(ipcRenderer.on).toHaveBeenCalledWith(EVENTS.downloadProgress, expect.any(Function));
        ipcRenderer.on.mock.calls[0][1]({ sender: 'hidden' }, { percent: 5 });
        expect(callback).toHaveBeenCalledWith({ percent: 5 });
        stop();
        expect(ipcRenderer.removeListener).toHaveBeenCalled();
        exposed.launcher.onPairingResult(() => {});
        expect(ipcRenderer.on).toHaveBeenLastCalledWith(EVENTS.pairingResult, expect.any(Function));
        expect(exposed.launcher.onPairingResult('not a function')).toEqual(expect.any(Function));
        exposed.launcher.onRunningChanged(() => {});
        expect(ipcRenderer.on).toHaveBeenLastCalledWith(EVENTS.runningChanged, expect.any(Function));
    });

    test('the preload channel names match the main process', () => {
        const source = fs.readFileSync(PRELOAD, 'utf8');
        const used = new Set([...source.matchAll(/'(px:[a-z:-]+)'/g)].map((match) => match[1]));
        const known = new Set([...Object.values(CHANNELS), ...Object.values(EVENTS)]);
        expect([...used].sort()).toEqual([...known].sort());
    });
});

describe('main-process handlers', () => {
    const ops = new Proxy({}, { get: (_target, name) => jest.fn(async () => ({ ok: true, name })) });
    const handlers = buildHandlers(ops);

    const bad = {
        [CHANNELS.minimize]: [['extra']],
        [CHANNELS.setSetting]: [
            ['account_nicknames', {}],
            ['accounts_panel', { hidden: true }],
            ['client_ram', '1k'],
            ['client_ram', 5],
            ['version_pref', '../../etc'],
            ['proxyip', 'x'.repeat(513)],
            ['selected_account', '__proto__'],
            ['unknown', 'x'],
            ['proxyip']
        ],
        [CHANNELS.downloadClient]: [['../x'], [5], []],
        [CHANNELS.confirmOutdated]: [['2.0.0'], ['2.0.0', '/etc']],
        [CHANNELS.deleteAccount]: [['constructor'], [123], ['a b']],
        [CHANNELS.setAccountProfile]: [['111', ''], ['111', 'x'.repeat(200)], ['111', 'bad\nname']],
        [CHANNELS.setNickname]: [['111', 5], ['111', 'x'.repeat(300)], ['__proto__', 'x']],
        [CHANNELS.setPanelSettings]: [[{ hidden: 'yes' }], [{ other: true }], [null], [[true]]],
        [CHANNELS.lookupHiscores]: [['name'], ['name', 'yes'], ['x'.repeat(65), false]],
        [CHANNELS.launchJagex]: [
            [{ version: '2.0.0' }],
            [{ accountId: '111', version: '2.0.0', sessionId: 'injected' }],
            [{ accountId: '111', version: '../2' }],
            [{ accountId: '111', version: '2.0.0', proxy: 'x'.repeat(600) }],
            ['111']
        ],
        [CHANNELS.launchNormal]: [[{ version: '2.0.0', accountId: '111' }], [{}]],
        [CHANNELS.importVpnConfig]: [['/home/x/vpn.conf']],
        [CHANNELS.testVpnConfig]: [[], ['../etc/passwd'], ['ABCDEF0123456789'], ['0123456789abcdef', 'extra'], [{ id: '0123456789abcdef' }]],
        [CHANNELS.savePreset]: [
            [{ connection: 'vpn', vpn: { id: '0123456789abcdef', privateKey: 'x' } }],
            [{ connection: 'vpn', vpn: { id: '../x' } }],
            [{ connection: 'vpn', vpn: 'text' }],
            [{ connection: 5 }]
        ],
        [CHANNELS.showError]: [['x'.repeat(2001)], [{}]],
        [CHANNELS.openLocation]: [['C:\\Windows'], ['/etc'], ['launcherlogs']],
        [CHANNELS.log]: [['fatal', 'x'], ['info', 5]]
    };

    test.each(Object.entries(bad))('%s rejects malformed arguments', (channel, cases) => {
        for (const args of cases) {
            expect(handlers[channel].check(...args)).toBe(false);
        }
    });

    test('well-formed arguments are accepted', () => {
        expect(handlers[CHANNELS.setSetting].check('client_ram', '2G')).toBe(true);
        expect(handlers[CHANNELS.setSetting].check('selected_account', null)).toBe(true);
        expect(handlers[CHANNELS.setSetting].check('proxyip', 'host:1080:user:pw')).toBe(true);
        expect(handlers[CHANNELS.launchJagex].check({ accountId: '111', version: '2.0.0', ram: '2g', proxy: '' })).toBe(true);
        expect(handlers[CHANNELS.launchNormal].check({ version: '1.2.3-dev' })).toBe(true);
        expect(handlers[CHANNELS.setPanelSettings].check({ collapsed: true })).toBe(true);
        expect(handlers[CHANNELS.openLocation].check('clientLogs')).toBe(true);
        expect(handlers[CHANNELS.lookupHiscores].check('Iron Wick', false)).toBe(true);
        expect(handlers[CHANNELS.setAccountProfile].check('111', 'default')).toBe(true);
        expect(handlers[CHANNELS.importVpnConfig].check()).toBe(true);
        expect(handlers[CHANNELS.testVpnConfig].check('0123456789abcdef')).toBe(true);
        expect(handlers[CHANNELS.savePreset].check({ name: 'VPN', connection: 'vpn', vpn: { id: '0123456789abcdef', name: 'se-1', endpoint: 'se1.example.net:51820', encrypted: true } })).toBe(true);
        expect(handlers[CHANNELS.savePreset].check({ name: 'Old', proxy: '1.2.3.4:1080' })).toBe(true);
    });

    test('registered handlers refuse untrusted senders and invalid arguments', async () => {
        const registered = {};
        const ipcMain = { handle: (channel, fn) => { registered[channel] = fn; } };
        const log = makeLog();
        const trusted = { trusted: true };
        registerIpc({ ipcMain, ops, isTrustedSender: (event) => event === trusted, log });
        expect(Object.keys(registered).sort()).toEqual(Object.values(CHANNELS).sort());
        await expect(registered[CHANNELS.getSession]({ trusted: false })).rejects.toThrow('Refused');
        await expect(registered[CHANNELS.deleteAccount](trusted, '__proto__')).rejects.toThrow(TypeError);
        await expect(registered[CHANNELS.getSession](trusted)).resolves.toMatchObject({ ok: true });
        expect(log.all()).toContain('invalid arguments');
    });
});

describe('window hardening', () => {
    test('new-window requests are denied and https links go to the system browser', async () => {
        const open = jest.fn(async () => {});
        expect(handleWindowOpen('https://xclient.dev/pair', open)).toEqual({ action: 'deny' });
        expect(handleWindowOpen('http://example.test', open)).toEqual({ action: 'deny' });
        expect(handleWindowOpen('file:///C:/Windows/notepad.exe', open)).toEqual({ action: 'deny' });
        expect(handleWindowOpen('javascript:alert(1)', open)).toEqual({ action: 'deny' });
        await Promise.resolve();
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith('https://xclient.dev/pair');
    });

    // Chromium's form of an install path with brackets, a tilde, a percent sign and a lower-case drive.
    const CHROMIUM_URL = 'file:///d:/Games%20%5BSSD%5D/~Tools/100%25/Project%20X%20Launcher/resources/app.asar/src/renderer/index.html';

    function fakeContents(url = CHROMIUM_URL) {
        const mainFrame = { url, processId: 4, routingId: 1 };
        return { mainFrame, getURL: () => url, isDestroyed: () => false };
    }

    test('calls from the window main frame are trusted whatever the install path looks like', () => {
        const contents = fakeContents();
        expect(isTrustedFrame({ sender: contents, senderFrame: contents.mainFrame }, contents)).toBe(true);
        expect(isTrustedFrame({ sender: contents, senderFrame: { url: CHROMIUM_URL + '#top', processId: 4, routingId: 1 } }, contents)).toBe(true);
        // A path we encode ourselves does not have to match Chromium's spelling.
        const ours = require('url').pathToFileURL('D:\\Games [SSD]\\~Tools\\100%\\Project X Launcher\\resources\\app.asar\\src\\renderer\\index.html').href;
        expect(ours).not.toBe(CHROMIUM_URL);
    });

    test('sub-frames, other windows, non-file pages and destroyed windows are refused', () => {
        const contents = fakeContents();
        const subFrame = { url: CHROMIUM_URL, processId: 4, routingId: 7 };
        expect(isTrustedFrame({ sender: contents, senderFrame: subFrame }, contents)).toBe(false);
        expect(isTrustedFrame({ sender: fakeContents(), senderFrame: contents.mainFrame }, contents)).toBe(false);
        expect(isTrustedFrame({ sender: contents, senderFrame: null }, contents)).toBe(false);
        const web = fakeContents('https://evil.example/index.html');
        expect(isTrustedFrame({ sender: web, senderFrame: web.mainFrame }, web)).toBe(false);
        const moved = fakeContents();
        moved.mainFrame.url = 'file:///c:/elsewhere/index.html';
        expect(isTrustedFrame({ sender: moved, senderFrame: moved.mainFrame }, moved)).toBe(false);
        const gone = fakeContents();
        gone.isDestroyed = () => true;
        expect(isTrustedFrame({ sender: gone, senderFrame: gone.mainFrame }, gone)).toBe(false);
    });

    test('the created window trusts its own page loaded from a bracketed path', () => {
        const { EventEmitter } = require('events');
        let created;
        class FakeWindow extends EventEmitter {
            constructor(options) {
                super();
                created = this;
                this.options = options;
                this.webContents = new EventEmitter();
                Object.assign(this.webContents, fakeContents(), { setWindowOpenHandler: jest.fn() });
            }
            isDestroyed() { return false; }
            show() {}
            loadFile() { return Promise.resolve(); }
        }
        const { isTrustedSender } = createMainWindow({
            BrowserWindow: FakeWindow,
            shell: { openExternal: jest.fn(async () => {}) },
            framed: false,
            iconPath: 'icon.png',
            preloadPath: 'preload.js',
            indexPath: 'D:\\Games [SSD]\\~Tools\\100%\\Project X Launcher\\resources\\app.asar\\src\\renderer\\index.html',
            log: makeLog()
        });
        const contents = created.webContents;
        expect(created.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false });
        expect(isTrustedSender({ sender: contents, senderFrame: contents.mainFrame })).toBe(true);

        contents.emit('did-finish-load');
        const blocked = { preventDefault: jest.fn() };
        contents.emit('will-navigate', blocked, 'https://evil.example/');
        expect(blocked.preventDefault).toHaveBeenCalled();
        const allowed = { preventDefault: jest.fn() };
        contents.emit('will-navigate', allowed, CHROMIUM_URL + '#section');
        expect(allowed.preventDefault).not.toHaveBeenCalled();
    });

    test('url helpers', () => {
        expect(isHttpsUrl('https://a.test')).toBe(true);
        expect(isHttpsUrl('nope')).toBe(false);
        expect(stripHash('file:///app/index.html#top')).toBe('file:///app/index.html');
    });

    test('the window is created with isolation, sandbox and no node or webview', () => {
        const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'window.js'), 'utf8');
        expect(source).toMatch(/contextIsolation: true/);
        expect(source).toMatch(/nodeIntegration: false/);
        expect(source).toMatch(/sandbox: true/);
        expect(source).toMatch(/webviewTag: false/);
    });

    test('the page has a strict Content-Security-Policy and no inline script or style', () => {
        const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
        const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("style-src 'self'");
        expect(csp).toContain("media-src 'self'");
        expect(csp).not.toContain('unsafe');
        expect(html).not.toMatch(/<script>(?!<)/);
        expect(html).not.toMatch(/\sstyle="/);
        expect(html).not.toMatch(/\son[a-z]+="/);
        expect(html).not.toMatch(/<webview/i);
        for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
            expect(fs.existsSync(path.join(ROOT, 'src', 'renderer', src))).toBe(true);
        }
    });

    test('the renderer never uses alert, confirm or innerHTML', () => {
        const dir = path.join(ROOT, 'src', 'renderer', 'js');
        for (const file of fs.readdirSync(dir)) {
            const source = fs.readFileSync(path.join(dir, file), 'utf8');
            expect(source).not.toMatch(/\b(alert|confirm)\(/);
            expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
        }
    });
});
