'use strict';

const { EventEmitter } = require('events');
const { createUpdater, SITE_FEED, GITHUB_FEED } = require('../src/main/updater');
const { fetchLatestLauncherVersion, cleanVersion, LAUNCHER_LATEST_JSON, GITHUB_LATEST_RELEASE } = require('../src/main/launcher-version');
const { makeLog, makeFetch, jsonResponse, networkError, flush } = require('./helpers');

function fakeAutoUpdater({ siteFails = false, githubFails = false, info = null, siteDownloadFails = false, githubDownloadFails = false } = {}) {
    const updater = new EventEmitter();
    updater.feeds = [];
    updater.setFeedURL = jest.fn((options) => {
        updater.feed = options;
        updater.feeds.push(options);
    });
    updater.checkForUpdates = jest.fn(async () => {
        const failing = updater.feed.provider === 'generic' ? siteFails : githubFails;
        if (failing) {
            const err = new Error(updater.feed.provider === 'generic' ? 'HttpError: 404 latest.yml' : 'GitHub unreachable');
            updater.emit('error', err);
            throw err;
        }
        if (info) {
            updater.emit('update-available', info);
        } else {
            updater.emit('update-not-available');
        }
        return { updateInfo: info, isUpdateAvailable: Boolean(info) };
    });
    updater.downloadUpdate = jest.fn(async () => {
        const failing = updater.feed.provider === 'generic' ? siteDownloadFails : githubDownloadFails;
        if (failing) {
            const err = new Error(updater.feed.provider === 'generic' ? 'HttpError: 404 installer' : 'GitHub download broke');
            updater.emit('error', err);
            throw err;
        }
        updater.emit('update-downloaded', info);
        return [];
    });
    updater.quitAndInstall = jest.fn();
    return updater;
}

function setup({ platform = 'win32', response = 0, updaterOptions, fetchHandler, lookupTimeoutMs } = {}) {
    const autoUpdater = fakeAutoUpdater(updaterOptions);
    const dialog = { showMessageBox: jest.fn(async () => ({ response })) };
    const shell = { openExternal: jest.fn(async () => {}) };
    const log = makeLog();
    const fetch = makeFetch(fetchHandler || (() => jsonResponse(404, {})));
    const updater = createUpdater({ autoUpdater, dialog, shell, log, fetch, appVersion: '2.0.0', platform, lookupTimeoutMs });
    return { autoUpdater, dialog, shell, log, fetch, updater };
}

describe('updater settings', () => {
    test('automatic, web-installer and differential downloads are off; the app logger is used', () => {
        const { autoUpdater, log } = setup();
        expect(autoUpdater.autoDownload).toBe(false);
        expect(autoUpdater.disableWebInstaller).toBe(true);
        expect(autoUpdater.disableDifferentialDownload).toBe(true);
        expect(autoUpdater.logger).toBe(log);
    });

    test('the feeds point at xclient.dev first and the GitHub releases second', () => {
        expect(SITE_FEED).toEqual({ provider: 'generic', url: 'https://xclient.dev/api/v1/launcher/osrs/' });
        expect(GITHUB_FEED).toEqual({ provider: 'github', owner: 'iEasyScript', repo: 'xclient-launcher' });
    });
});

describe('feed fallback', () => {
    test('a working site feed is the only one checked', async () => {
        const { autoUpdater, updater, dialog } = setup();
        await expect(updater.check()).resolves.toBe('site');
        expect(autoUpdater.feeds).toEqual([SITE_FEED]);
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a failing site falls back to GitHub once, without an error dialog', async () => {
        const { autoUpdater, updater, dialog, log } = setup({ updaterOptions: { siteFails: true } });
        await expect(updater.check()).resolves.toBe('github');
        expect(autoUpdater.feeds).toEqual([SITE_FEED, GITHUB_FEED]);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
        expect(log.all()).toMatch(/xclient\.dev failed .*trying GitHub/);
    });

    test('when both fail the update-failed dialog names the download page', async () => {
        const { updater, dialog } = setup({ updaterOptions: { siteFails: true, githubFails: true } });
        await expect(updater.check()).resolves.toBe('failed');
        expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
        const options = dialog.showMessageBox.mock.calls[0][0];
        expect(options).toMatchObject({ type: 'error', title: 'Update failed', message: 'The launcher could not update itself.' });
        expect(options.detail).toContain('GitHub unreachable');
        expect(options.detail).toContain('https://xclient.dev/download');
    });

    test('the failure dialog mentions a newer version when the site lists one', async () => {
        const { updater, dialog } = setup({
            updaterOptions: { siteFails: true, githubFails: true },
            fetchHandler: (url) => (url === LAUNCHER_LATEST_JSON ? jsonResponse(200, { version: 'v2.1.0' }) : jsonResponse(404, {}))
        });
        await updater.check();
        expect(dialog.showMessageBox.mock.calls[0][0].detail).toContain('Version 2.1.0 is available.');
    });
});

describe('download fallback', () => {
    async function settle() {
        for (let i = 0; i < 20; i++) {
            await flush();
        }
    }

    test('a failed download from the site is retried once from GitHub without asking again', async () => {
        const { autoUpdater, updater, dialog, log } = setup({ updaterOptions: { info: { version: '2.1.0' }, siteDownloadFails: true } });
        await updater.check();
        await settle();
        expect(autoUpdater.feeds).toEqual([SITE_FEED, GITHUB_FEED]);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
        const titles = dialog.showMessageBox.mock.calls.map((call) => call[0].title);
        expect(titles).toEqual(['Update available', 'Downloading', 'Install Updates']);
        expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
        expect(log.all()).toMatch(/download from xclient\.dev failed .*trying GitHub/);
    });

    test('when the retry also fails there is one error dialog and no further attempts', async () => {
        const { autoUpdater, updater, dialog } = setup({ updaterOptions: { info: { version: '2.1.0' }, siteDownloadFails: true, githubDownloadFails: true } });
        await updater.check();
        await settle();
        expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
        const titles = dialog.showMessageBox.mock.calls.map((call) => call[0].title);
        expect(titles).toEqual(['Update available', 'Downloading', 'Update failed']);
        expect(dialog.showMessageBox.mock.calls[2][0].detail).toContain('GitHub download broke');
    });

    test('a failed download from GitHub is not retried', async () => {
        const { autoUpdater, updater, dialog } = setup({ updaterOptions: { info: { version: '2.1.0' }, siteFails: true, githubDownloadFails: true } });
        await updater.check();
        await settle();
        expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
        expect(dialog.showMessageBox.mock.calls.map((call) => call[0].title)).toEqual(['Update available', 'Downloading', 'Update failed']);
    });

    test('the error dialog does not wait for a slow version lookup', async () => {
        const { updater, dialog } = setup({
            updaterOptions: { siteFails: true, githubFails: true },
            fetchHandler: () => new Promise(() => {}),
            lookupTimeoutMs: 30
        });
        const started = Date.now();
        await expect(updater.check()).resolves.toBe('failed');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update failed' }));
        expect(dialog.showMessageBox.mock.calls[0][0].detail).not.toContain('is available');
    });
});

describe('update prompts', () => {
    test('Windows/Linux: Install downloads the full installer, then quits and installs', async () => {
        const { autoUpdater, updater, dialog } = setup({ updaterOptions: { info: { version: '2.1.0' } }, response: 0 });
        await updater.check();
        await flush();
        await flush();
        const first = dialog.showMessageBox.mock.calls[0][0];
        expect(first).toMatchObject({ title: 'Update available', buttons: ['Install', 'Later'], defaultId: 0, cancelId: 1 });
        expect(first.detail).toContain('2.1.0');
        expect(dialog.showMessageBox.mock.calls[1][0]).toMatchObject({ title: 'Downloading' });
        expect(autoUpdater.downloadUpdate).toHaveBeenCalled();
        autoUpdater.emit('download-progress', { percent: 50, transferred: 1048576, total: 2097152 });
        autoUpdater.emit('update-downloaded', { version: '2.1.0' });
        await flush();
        await flush();
        expect(dialog.showMessageBox.mock.calls[2][0]).toMatchObject({ title: 'Install Updates' });
        expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    });

    test('Later does nothing', async () => {
        const { autoUpdater, updater } = setup({ updaterOptions: { info: { version: '2.1.0' } }, response: 1 });
        await updater.check();
        await flush();
        expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    test('macOS sends the user to the website instead of downloading', async () => {
        const { autoUpdater, updater, dialog, shell } = setup({ platform: 'darwin', updaterOptions: { info: { version: '2.1.0' } }, response: 0 });
        await updater.check();
        await flush();
        expect(dialog.showMessageBox.mock.calls[0][0]).toMatchObject({ title: 'Update available', buttons: ['Download', 'Later'] });
        expect(shell.openExternal).toHaveBeenCalledWith('https://xclient.dev/download?os=mac');
        expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    test('an error after the check (during download) shows the failure dialog', async () => {
        const { autoUpdater, dialog } = setup();
        autoUpdater.emit('error', new Error('download broke'));
        await flush();
        await flush();
        expect(dialog.showMessageBox.mock.calls[0][0]).toMatchObject({ title: 'Update failed' });
    });
});

describe('latest launcher version lookup', () => {
    test.each(['v1.0.9', '1.0.9'])('reads %p from latest.json and strips the v', async (version) => {
        const fetch = makeFetch(() => jsonResponse(200, { version, files: {}, updatedAt: '2026-11-15T00:00:00Z' }));
        await expect(fetchLatestLauncherVersion({ fetch, log: makeLog() })).resolves.toEqual({ ok: true, version: '1.0.9', source: 'site' });
        expect(fetch.calls).toHaveLength(1);
        expect(fetch.calls[0].url).toBe('https://xclient.dev/api/v1/launcher/osrs/latest.json');
    });

    test('falls back to the GitHub latest release only when the site fails', async () => {
        const fetch = makeFetch((url) => {
            if (url === LAUNCHER_LATEST_JSON) {
                throw networkError();
            }
            return jsonResponse(200, { tag_name: 'v2.0.1' });
        });
        await expect(fetchLatestLauncherVersion({ fetch, log: makeLog() })).resolves.toEqual({ ok: true, version: '2.0.1', source: 'github' });
        expect(fetch.calls.map((call) => call.url)).toEqual([LAUNCHER_LATEST_JSON, GITHUB_LATEST_RELEASE]);
        expect(GITHUB_LATEST_RELEASE).toBe('https://api.github.com/repos/iEasyScript/xclient-launcher/releases/latest');
    });

    test('a site answer without a usable version also falls back', async () => {
        const fetch = makeFetch((url) => (url === LAUNCHER_LATEST_JSON ? jsonResponse(200, { files: {} }) : jsonResponse(200, { tag_name: '2.0.2' })));
        await expect(fetchLatestLauncherVersion({ fetch, log: makeLog() })).resolves.toMatchObject({ version: '2.0.2', source: 'github' });
    });

    test('both failing is reported', async () => {
        const fetch = makeFetch(() => jsonResponse(500, {}));
        await expect(fetchLatestLauncherVersion({ fetch, log: makeLog() })).resolves.toEqual({ ok: false });
    });

    test('version cleaning', () => {
        expect(cleanVersion(' V2.0.0 ')).toBe('2.0.0');
        expect(cleanVersion('2.0.0-beta.1')).toBe('2.0.0-beta.1');
        expect(cleanVersion('2.0')).toBeNull();
        expect(cleanVersion(2)).toBeNull();
    });
});
