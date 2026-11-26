'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell, session } = require('electron');
const log = require('electron-log/main');

const { scrubValue } = require('./redact');
const { createPaths } = require('./paths');
const { resolveSiteUrl } = require('./site');
const { createAppFetch } = require('./http');
const { LAUNCHER_FEED_URL } = require('./launcher-version');
const { createSettingsStore } = require('./settings');
const { createNicknameStore } = require('./nicknames');
const { createAccountService } = require('./account');
const { createUrlOpener } = require('./open-url');
const { createClientService } = require('./client-service');
const { createAccountsStore } = require('./jagex/accounts');
const { findBrowser, launchBrowser } = require('./jagex/browser');
const { runJagexLogin } = require('./jagex/login');
const { createHiscoresService, HISCORES_URL } = require('./hiscores-service');
const { createLauncher } = require('./launch');
const { createPresetStore, toClientPreset } = require('./presets');
const { createSiteData } = require('./site-data');
const { createRunningRegistry } = require('./running');
const { createVpnStore } = require('./vpn-store');
const { createVpnManager, findHelper, cleanRunDir } = require('./vpn');
const { createLocations } = require('./locations');
const { createOperations } = require('./operations');
const { registerIpc, EVENTS } = require('./ipc');
const { createMainWindow } = require('./window');

log.transports.file.level = 'info';
log.transports.console.level = process.env.DEBUG ? 'debug' : 'warn';
log.hooks.push((message) => {
    message.data = message.data.map(scrubValue);
    return message;
});

process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));

const framed = process.env.DEBUG === 'true';
const root = path.join(__dirname, '..', '..');
let mainWindow = null;
let vpn = null;
let quitConfirmed = false;

function messageBox(options) {
    return mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options);
}

function emit(name, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(EVENTS[name], payload);
    }
}

// The system key store, when there is a real one. On Linux, Electron falls back to a fixed
// built-in password when no keyring is running; that is no protection, so it counts as none and
// configs are then kept unencrypted with a note in the UI.
const secretBox = {
    isAvailable() {
        if (!safeStorage.isEncryptionAvailable()) {
            return false;
        }
        if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
            return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
        }
        return true;
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer)
};

function start() {
    log.info('App starting (version ' + app.getVersion() + ')');
    const paths = createPaths();
    fs.mkdirSync(paths.projectxDir, { recursive: true });

    const siteUrl = resolveSiteUrl(process.env);
    const userAgent = 'ProjectXLauncher/' + app.getVersion();
    // Jagex and GitHub requests keep the network stack's own User-Agent.
    const ownPrefixes = [siteUrl + '/', LAUNCHER_FEED_URL, HISCORES_URL];
    const fetchImpl = createAppFetch({ net, userAgent, isOwnUrl: (url) => ownPrefixes.some((prefix) => url.startsWith(prefix)) });
    const settings = createSettingsStore({ file: paths.settingsFile, log });
    const nicknames = createNicknameStore({ settings });
    const openUrl = createUrlOpener({ openExternal: (url) => shell.openExternal(url), spawn: childProcess.spawn, log });
    const account = createAccountService({
        sessionFile: path.join(app.getPath('userData'), 'projectx-session.json'),
        siteUrl,
        fetch: fetchImpl,
        openExternal: openUrl,
        copyText: (text) => clipboard.writeText(text),
        notify: (payload) => emit('pairingResult', payload),
        log
    });
    const client = createClientService({ paths, settings, siteUrl, fetch: fetchImpl, log });
    const accounts = createAccountsStore({ file: paths.accountsFile, fetch: fetchImpl, log });
    const hiscores = createHiscoresService({ fetch: fetchImpl, cacheFile: paths.hiscoresCacheFile, log, userAgent });
    const presets = createPresetStore({ file: path.join(app.getPath('userData'), 'launch-presets.json'), log });
    const siteData = createSiteData({ fetch: fetchImpl, siteUrl, readToken: () => account.readToken(), log });
    const running = createRunningRegistry({ log, onChange: (clients) => emit('runningChanged', clients) });
    const vpnRunDir = path.join(app.getPath('userData'), 'vpn-run');
    cleanRunDir(vpnRunDir);
    const vpnStore = createVpnStore({ dir: path.join(app.getPath('userData'), 'vpn'), secretBox, log });
    try {
        vpnStore.sweep(presets.vpnIds());
    } catch (err) {
        log.warn('Could not tidy the saved WireGuard configs: ' + err.message);
    }
    vpn = createVpnManager({
        store: vpnStore,
        findHelperPath: () => findHelper({
            platform: process.platform,
            arch: process.arch,
            resourcesPath: process.resourcesPath,
            appRoot: root,
            isPackaged: app.isPackaged
        }),
        spawn: childProcess.spawn,
        runDir: vpnRunDir,
        log,
        onDisconnect: (names) => {
            messageBox({
                type: 'warning',
                title: 'VPN disconnected',
                message: names.map((name) => 'VPN for ' + name + ' disconnected').join('\n'),
                detail: 'The client using it was closed so it never plays without the VPN. Launch it again to reconnect.',
                buttons: ['OK']
            }).catch((err) => log.warn('Could not show the VPN message: ' + err.message));
        }
    });
    const launcher = createLauncher({
        paths,
        log,
        spawn: childProcess.spawn,
        dialog: {
            showMessageBox: messageBox,
            showErrorBox: (title, content) => dialog.showErrorBox(title, content)
        },
        openExternal: openUrl,
        readToken: () => account.readToken(),
        accounts,
        presets,
        toClientPreset,
        running,
        vpn
    });
    const locations = createLocations({
        paths,
        shell,
        launcherLogFile: () => log.transports.file.getFile().path,
        log
    });

    const ops = createOperations({
        appInfo: { version: app.getVersion(), platform: process.platform },
        windowControls: {
            minimize: () => mainWindow && mainWindow.minimize(),
            toggleMaximize: () => {
                if (mainWindow) {
                    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
                }
            },
            close: () => app.quit()
        },
        messageBox,
        log,
        paths,
        account,
        settings,
        nicknames,
        client,
        accounts,
        runJagexLogin: () => runJagexLogin({ findBrowser, launchBrowser, fetch: fetchImpl, accounts, log }),
        hiscores,
        launcher,
        locations,
        emit,
        presets,
        siteData,
        running,
        vpnStore,
        vpn,
        pickConfigFile: async () => {
            const options = {
                title: 'Import WireGuard config',
                properties: ['openFile'],
                filters: [{ name: 'WireGuard config', extensions: ['conf'] }, { name: 'All files', extensions: ['*'] }]
            };
            const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
            return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
        }
    });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    const created = createMainWindow({
        BrowserWindow,
        shell,
        framed,
        iconPath: path.join(root, 'images', 'projectx_transparent.png'),
        preloadPath: path.join(root, 'src', 'preload', 'preload.js'),
        indexPath: path.join(root, 'src', 'renderer', 'index.html'),
        log
    });
    mainWindow = created.win;
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    // Closing the launcher stops the VPN helpers, so clients using one would be cut off. Ask first.
    mainWindow.on('close', (event) => {
        const count = vpn ? vpn.activeClientCount() : 0;
        if (quitConfirmed || count === 0) {
            return;
        }
        event.preventDefault();
        messageBox({
            type: 'warning',
            title: 'Close the launcher?',
            message: count === 1 ? 'A client is using a VPN through the launcher.' : count + ' clients are using a VPN through the launcher.',
            detail: 'The VPN stops when the launcher closes, so ' + (count === 1 ? 'that client' : 'those clients') + ' will be closed too.',
            buttons: ['Cancel', 'Close the launcher'],
            defaultId: 0,
            cancelId: 0
        }).then(({ response }) => {
            if (response === 1) {
                quitConfirmed = true;
                app.quit();
            }
        }).catch((err) => log.warn('Could not ask before closing: ' + err.message));
    });
    registerIpc({ ipcMain, ops, isTrustedSender: (event) => created.isTrustedSender(event), log });

    if (!framed) {
        mainWindow.once('show', () => {
            const { autoUpdater } = require('electron-updater');
            const { createUpdater } = require('./updater');
            const updater = createUpdater({ autoUpdater, dialog: { showMessageBox: messageBox }, shell, log, fetch: fetchImpl, appVersion: app.getVersion() });
            updater.check().catch((err) => log.error('Launcher update check failed: ' + err.message));
        });
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => {
        if (vpn) {
            vpn.stopAll({ closeClients: true });
        }
    });
    process.on('exit', () => {
        if (vpn) {
            vpn.stopAll({ closeClients: true });
        }
    });
    app.whenReady().then(start).catch((err) => {
        log.error('Start-up failed:', err);
        dialog.showErrorBox('Project X Launcher', 'The launcher could not start: ' + err.message);
        app.quit();
    });
}
