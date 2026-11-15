'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, net, shell, session } = require('electron');
const log = require('electron-log/main');

const { scrubValue } = require('./redact');
const { createPaths } = require('./paths');
const { resolveSiteUrl } = require('./site');
const { createAppFetch } = require('./http');
const { LAUNCHER_FEED_URL } = require('./launcher-version');
const { createSettingsStore } = require('./settings');
const { createNicknameStore } = require('./nicknames');
const { createAccountService } = require('./account');
const { createClientService } = require('./client-service');
const { createAccountsStore } = require('./jagex/accounts');
const { findBrowser, launchBrowser } = require('./jagex/browser');
const { runJagexLogin } = require('./jagex/login');
const { createHiscoresService, HISCORES_URL } = require('./hiscores-service');
const { createLauncher } = require('./launch');
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
    const account = createAccountService({
        sessionFile: path.join(app.getPath('userData'), 'projectx-session.json'),
        siteUrl,
        fetch: fetchImpl,
        openExternal: (url) => shell.openExternal(url),
        notify: (payload) => emit('pairingResult', payload),
        log
    });
    const client = createClientService({ paths, settings, siteUrl, fetch: fetchImpl, log });
    const accounts = createAccountsStore({ file: paths.accountsFile, fetch: fetchImpl, log });
    const hiscores = createHiscoresService({ fetch: fetchImpl, cacheFile: paths.hiscoresCacheFile, log, userAgent });
    const launcher = createLauncher({
        paths,
        log,
        spawn: childProcess.spawn,
        dialog: {
            showMessageBox: messageBox,
            showErrorBox: (title, content) => dialog.showErrorBox(title, content)
        },
        openExternal: (url) => shell.openExternal(url),
        readToken: () => account.readToken(),
        accounts
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
        emit
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
    app.whenReady().then(start).catch((err) => {
        log.error('Start-up failed:', err);
        dialog.showErrorBox('Project X Launcher', 'The launcher could not start: ' + err.message);
        app.quit();
    });
}
