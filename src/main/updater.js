'use strict';

const { DOWNLOAD_PAGE, MAC_DOWNLOAD_PAGE } = require('./site');
const { errorMessage } = require('./http');
const { compareVersions } = require('./client-versions');
const {
    LAUNCHER_FEED_URL,
    GITHUB_OWNER,
    GITHUB_REPO,
    fetchLatestLauncherVersion
} = require('./launcher-version');

const SITE_FEED = { provider: 'generic', url: LAUNCHER_FEED_URL };
const GITHUB_FEED = { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO };
const VERSION_LOOKUP_CAP_MS = 5000;

// Self-update. Windows and Linux install in place; the unsigned macOS build cannot replace itself,
// so Mac users are sent to the download page instead.
function createUpdater(deps) {
    const {
        autoUpdater,
        dialog,
        shell,
        log,
        fetch: fetchImpl,
        appVersion,
        platform = process.platform,
        lookupTimeoutMs = VERSION_LOOKUP_CAP_MS
    } = deps;
    const isMac = platform === 'darwin';
    // idle | checking | downloading | retrying. Outside "idle", failures are handled where the
    // promise is awaited, so the 'error' event must not show a second dialog.
    let phase = 'idle';
    let feed = null;
    let retried = false;

    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.disableDifferentialDownload = true;

    // The newest published version, if it can be found quickly; the error dialog never waits longer.
    async function newerVersionLine() {
        let timer;
        const cap = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), lookupTimeoutMs);
        });
        try {
            const latest = await Promise.race([
                fetchLatestLauncherVersion({ fetch: fetchImpl, log }).catch(() => null),
                cap
            ]);
            if (latest && latest.ok && appVersion && compareVersions(latest.version, appVersion) > 0) {
                return '\n\nVersion ' + latest.version + ' is available.';
            }
        } finally {
            clearTimeout(timer);
        }
        return '';
    }

    async function reportError(err) {
        phase = 'idle';
        const reason = errorMessage(err);
        log.error('Launcher update failed: ' + reason);
        const newer = await newerVersionLine();
        try {
            await dialog.showMessageBox({
                type: 'error',
                title: 'Update failed',
                message: 'The launcher could not update itself.',
                detail: reason + newer + '\n\nYou can carry on with this version, or download the latest from ' + DOWNLOAD_PAGE + '.',
                buttons: ['OK']
            });
        } catch (dialogErr) {
            log.warn('Could not show the update error: ' + dialogErr.message);
        }
    }

    // A download from the site can fail when the site has already moved on to a newer release,
    // so it is retried once from the GitHub releases.
    async function download() {
        try {
            await autoUpdater.downloadUpdate();
            return;
        } catch (err) {
            if (feed !== 'site' || retried) {
                return reportError(err);
            }
            retried = true;
            log.warn('Launcher update download from xclient.dev failed (' + errorMessage(err) + '); trying GitHub releases');
            phase = 'retrying';
            let result;
            try {
                autoUpdater.setFeedURL(GITHUB_FEED);
                feed = 'github';
                result = await autoUpdater.checkForUpdates();
            } catch (checkErr) {
                return reportError(checkErr);
            }
            if (!result || !result.updateInfo || result.isUpdateAvailable === false) {
                return reportError(err);
            }
            phase = 'downloading';
            try {
                await autoUpdater.downloadUpdate();
            } catch (retryErr) {
                return reportError(retryErr);
            }
        }
    }

    async function onUpdateAvailable(info) {
        // The GitHub retry downloads straight away; the user has already said yes.
        if (phase === 'retrying') {
            return;
        }
        const version = info && info.version ? info.version : 'new';
        log.info('Launcher update available: ' + version);
        if (isMac) {
            const { response } = await dialog.showMessageBox({
                type: 'info',
                title: 'Update available',
                message: 'Project X Launcher ' + version + ' is available.',
                detail: 'Download it from the website and drag it into Applications to replace this copy. '
                    + 'You may need to run the Terminal command from the install steps again.',
                buttons: ['Download', 'Later'],
                defaultId: 0,
                cancelId: 1
            });
            if (response === 0) {
                await shell.openExternal(MAC_DOWNLOAD_PAGE);
            }
            return;
        }
        const { response } = await dialog.showMessageBox({
            type: 'info',
            title: 'Update available',
            message: 'A new version of the launcher is available.',
            detail: 'Do you want to download version ' + version + ' and install it now?',
            buttons: ['Install', 'Later'],
            defaultId: 0,
            cancelId: 1
        });
        if (response !== 0) {
            return;
        }
        phase = 'downloading';
        dialog.showMessageBox({
            type: 'info',
            title: 'Downloading',
            message: 'Downloading version ' + version + '.',
            detail: 'This takes a minute or two. You can keep using the launcher until it says the update is ready.',
            buttons: ['OK']
        }).catch(() => {});
        await download();
    }

    autoUpdater.on('update-available', (info) => {
        onUpdateAvailable(info).catch((err) => log.error('Update prompt failed: ' + errorMessage(err)));
    });
    autoUpdater.on('update-not-available', () => log.info('Launcher is up to date'));
    autoUpdater.on('download-progress', (progress) => {
        const percent = progress && typeof progress.percent === 'number' ? progress.percent.toFixed(1) : '?';
        const mb = progress && typeof progress.transferred === 'number' ? (progress.transferred / 1048576).toFixed(1) : '?';
        const total = progress && typeof progress.total === 'number' ? (progress.total / 1048576).toFixed(1) : '?';
        log.info('Launcher update download: ' + percent + '% (' + mb + ' of ' + total + ' MB)');
    });
    autoUpdater.on('update-downloaded', () => {
        phase = 'idle';
        log.info('Launcher update downloaded');
        Promise.resolve(dialog.showMessageBox({
            type: 'info',
            title: 'Install Updates',
            message: 'The update has downloaded. The launcher will now quit and install it.',
            buttons: ['OK']
        }))
            .catch(() => {})
            .then(() => autoUpdater.quitAndInstall());
    });
    autoUpdater.on('error', (err) => {
        if (phase === 'idle') {
            reportError(err);
        }
    });

    // One check: the xclient.dev feed first, then GitHub releases once if the site fails.
    async function check() {
        phase = 'checking';
        try {
            autoUpdater.setFeedURL(SITE_FEED);
            feed = 'site';
            await autoUpdater.checkForUpdates();
            phase = phase === 'checking' ? 'idle' : phase;
            return 'site';
        } catch (err) {
            log.warn('Launcher update check against xclient.dev failed (' + errorMessage(err) + '); trying GitHub releases');
        }
        try {
            autoUpdater.setFeedURL(GITHUB_FEED);
            feed = 'github';
            await autoUpdater.checkForUpdates();
            phase = phase === 'checking' ? 'idle' : phase;
            return 'github';
        } catch (err) {
            await reportError(err);
            return 'failed';
        }
    }

    return { check };
}

module.exports = { createUpdater, SITE_FEED, GITHUB_FEED, VERSION_LOOKUP_CAP_MS };
