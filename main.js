const { app, BrowserWindow, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { ipcMain } = require('electron');
const AdmZip = require('adm-zip');
const packageJson = require(path.join(__dirname, 'package.json'));
const { spawn } = require('child_process');
const { projectxDir, openLocation } = require(path.join(
    __dirname,
    'libs',
    'dir-module.js'
));

process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
});

let mainWindow = null;

// Ensure the .projectx directory exists
if (!fs.existsSync(projectxDir)) {
    fs.mkdirSync(projectxDir);
}

async function loadLibraries() {
    log.info('Loading libraries...');

    const ipcHandlersPath = path.join(__dirname, 'libs', 'ipc-handlers.js');

    try {
        log.info('Requiring ipc-handlers...');
        const handler = require(ipcHandlersPath);
        const deps = {
            AdmZip: AdmZip,
            axios: axios,
            ipcMain: ipcMain,
            projectxDir: projectxDir,
            packageJson: packageJson,
            path: path,
            log: log,
            spawn: spawn,
            dialog: dialog,
            shell: shell,
            projectDir: __dirname,
            fs: fs,
            app: app,
            mainWindow: mainWindow
        };
        try {
            const accountHandler = require(path.join(
                __dirname,
                'libs',
                'projectx-account.js'
            ));
            const account = accountHandler({ ipcMain, app, shell, log });
            // jar-executor reads this when it spawns the client, so the client
            // starts as whoever is signed in to the launcher.
            deps.currentAccountToken = account.currentToken;
        } catch (accountError) {
            log.error('Error requiring projectx-account:', accountError);
        }

        try {
            const mockAuthHandler = require(path.join(
                __dirname,
                'libs',
                'mock-auth.js'
            ));
            if (typeof mockAuthHandler === 'function') {
                mockAuthHandler({ ipcMain, log });
            } else {
                log.error('mock-auth does not export a function');
            }
        } catch (authError) {
            log.error('Error requiring mock-auth:', authError);
        }
        if (typeof handler === 'function') {
            await handler(deps);
        } else {
            log.error('ipcHandlers does not export a function');
        }
        log.info('Done requiring ipcHandlers...');
    } catch (error) {
        log.error('Error requiring ipcHandlers:', error);
    }
}

async function createWindow() {
    // Create the main window, but don't show it yet
    mainWindow = new BrowserWindow({
        width: 1280,
        height: process.env.DEBUG !== 'true' ? 750 : 800,
        show: false, // Don't show the main window immediately
        title: 'ProjectX Launcher',
        autoHideMenuBar: process.env.DEBUG !== 'true',
        icon: path.join(__dirname, 'images/projectx_transparent.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: true,
            webviewTag: true
        },
        titleBarStyle: process.env.DEBUG !== 'true' ? 'hidden' : '',
        frame: process.env.DEBUG === 'true'
    });

    if (process.platform === 'darwin') {
        mainWindow.setWindowButtonVisibility(false);
    }

    try {
        const extraHandlers = require(path.join(
            __dirname,
            'libs',
            'extra-ipc-handlers.js'
        ));
        if (typeof extraHandlers === 'function') {
            await extraHandlers(app, ipcMain, mainWindow, log, openLocation);
        } else {
            log.error('extra-ipc-handlers does not export a function');
        }
    } catch (e) {
        log.error('Failed to load extra-ipc-handlers:', e);
    }

    await mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

/*
 * Updating the launcher.
 *
 * Three things were missing, and together they produced an update that appeared
 * to start and then silently did nothing: no logger, so electron-updater wrote
 * its side of the story nowhere; no error handler, so any failure was swallowed
 * whole and the user was left looking at a "Downloading..." box forever; and
 * differential downloads left on, which need the *installed* version's blockmap
 * to compute a delta. 1.0.0 was published without one, so there was nothing to
 * diff against and the download died before it began.
 */
autoUpdater.logger = log;
autoUpdater.autoDownload = false;
autoUpdater.disableWebInstaller = true;

// Fetch the whole installer rather than a delta. It is the difference between
// a hundred megabytes and a failed update, and it does not depend on what some
// earlier release happened to publish alongside itself.
autoUpdater.disableDifferentialDownload = true;

autoUpdater.on('error', (error) => {
    log.error('Launcher update failed:', error);
    dialog.showMessageBox({
        type: 'error',
        title: 'Update failed',
        message: 'The launcher could not update itself.',
        detail:
            `${error?.message || error}\n\n` +
            'You can carry on using this version, or download the latest one from ' +
            'https://xclient.dev/download'
    });
});

autoUpdater.on('download-progress', (progress) => {
    log.info(
        `Update download ${Math.round(progress.percent)}% ` +
        `(${Math.round(progress.transferred / 1e6)}MB of ${Math.round(progress.total / 1e6)}MB)`
    );
});

autoUpdater.on('update-available', (info) => {
    dialog
        .showMessageBox({
            type: 'info',
            title: 'Update available',
            detail: `Would you like to download version ${info.version} and install it now?`,
            message: `New version of launcher available!`,
            buttons: ['Install', 'Later'],
            cancelId: 1,
            defaultId: 0,
            noLink: false
        })
        .then((result) => {
            if (result.response === 0) {
                dialog.showMessageBox({
                    type: 'info',
                    title: 'Downloading',
                    message: `Downloading version ${info.version} of the launcher...`,
                    detail:
                        'This takes a minute or two. The launcher will tell you when it ' +
                        'is ready to restart, and you can keep using it until then.'
                });
                autoUpdater.downloadUpdate().catch((error) => {
                    // downloadUpdate rejects as well as emitting 'error'; without
                    // this the rejection is unhandled and nothing says why.
                    log.error('Launcher update download failed:', error);
                });
            }
        });
});

autoUpdater.on('update-downloaded', () => {
    dialog
        .showMessageBox({
            title: 'Install Updates',
            message:
                'Updates downloaded. The application will now quit and install the updates.'
        })
        .then(() => {
            autoUpdater.quitAndInstall();
        });
});

app.whenReady().then(async () => {
    log.info('App starting...');

    await loadLibraries();
    await createWindow();

    if (process.env.DEBUG !== 'true') {
        mainWindow.show();
        autoUpdater.checkForUpdates();
    } else {
        mainWindow.show();
    }
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
