'use strict';

function isHttpsUrl(url) {
    try {
        return new URL(url).protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function isFileUrl(url) {
    try {
        return new URL(url).protocol === 'file:';
    } catch (_) {
        return false;
    }
}

function stripHash(url) {
    const index = String(url).search(/[?#]/);
    return index >= 0 ? String(url).slice(0, index) : String(url);
}

// New windows are never opened by the page; https links go to the system browser instead.
function handleWindowOpen(url, openExternal) {
    if (isHttpsUrl(url)) {
        Promise.resolve(openExternal(url)).catch(() => {});
    }
    return { action: 'deny' };
}

function sameFrame(a, b) {
    if (!a || !b) {
        return false;
    }
    return a === b || (a.processId === b.processId && a.routingId === b.routingId);
}

// An IPC call is trusted when it comes from this window's own main frame showing a local file.
// URLs are compared only as Chromium reports them, never against a path we encoded ourselves,
// because the two can differ in escaping (brackets, tildes, percent signs, drive-letter case).
function isTrustedFrame(event, contents) {
    if (!contents || contents.isDestroyed() || event.sender !== contents) {
        return false;
    }
    const frame = event.senderFrame;
    if (!sameFrame(frame, contents.mainFrame)) {
        return false;
    }
    const frameUrl = frame.url;
    return isFileUrl(frameUrl) && stripHash(frameUrl) === stripHash(contents.getURL());
}

function createMainWindow({ BrowserWindow, shell, framed, iconPath, preloadPath, indexPath, log }) {
    const win = new BrowserWindow({
        width: 1280,
        height: framed ? 800 : 750,
        minWidth: 960,
        minHeight: 600,
        title: 'Project X Launcher',
        icon: iconPath,
        show: false,
        frame: framed,
        autoHideMenuBar: !framed,
        backgroundColor: '#08090d',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            sandbox: true,
            webviewTag: false,
            spellcheck: false,
            devTools: framed
        }
    });

    const contents = win.webContents;
    // Once the page has loaded, this is the only address the window may show.
    let pageUrl = null;
    contents.on('did-finish-load', () => {
        if (pageUrl === null && isFileUrl(contents.getURL())) {
            pageUrl = stripHash(contents.getURL());
        }
    });
    const isOwnPage = (url) => pageUrl !== null && stripHash(url) === pageUrl;

    contents.setWindowOpenHandler(({ url }) => handleWindowOpen(url, (target) => shell.openExternal(target)));
    contents.on('will-navigate', (event, url) => {
        if (!isOwnPage(url)) {
            event.preventDefault();
            if (isHttpsUrl(url)) {
                shell.openExternal(url).catch(() => {});
            }
        }
    });
    contents.on('will-redirect', (event, url) => {
        if (!isOwnPage(url)) {
            event.preventDefault();
        }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => log.error('Window renderer stopped: ' + details.reason));

    win.once('ready-to-show', () => win.show());
    win.loadFile(indexPath).catch((err) => log.error('Could not load the launcher page: ' + err.message));

    return { win, isTrustedSender: (event) => isTrustedFrame(event, contents) };
}

module.exports = { isHttpsUrl, isFileUrl, stripHash, handleWindowOpen, isTrustedFrame, createMainWindow };
