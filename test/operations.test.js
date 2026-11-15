'use strict';

const path = require('path');
const fs = require('fs');
const { chooseVersion, rememberedSelection, selectionAfterReload } = require('../src/shared/selection');
const { createOperations } = require('../src/main/operations');
const { createSettingsStore } = require('../src/main/settings');
const { createNicknameStore } = require('../src/main/nicknames');
const { createAccountsStore } = require('../src/main/jagex/accounts');
const { createLocations } = require('../src/main/locations');
const { createPaths } = require('../src/main/paths');
const { makeTempDir, cleanupTempDirs, makeLog, readJsonFile, writeJsonFile } = require('./helpers');

afterEach(cleanupTempDirs);

describe('version preference', () => {
    const installed = ['projectx-1.0.10.jar', 'projectx-1.0.9.jar'];

    test('applies only on an exact jar match', () => {
        expect(chooseVersion(installed, null, '1.0.9')).toBe('projectx-1.0.9.jar');
        expect(chooseVersion(installed, null, '1.0.1')).toBe('projectx-1.0.10.jar');
        expect(chooseVersion(installed, null, '0.0.0')).toBe('projectx-1.0.10.jar');
        expect(chooseVersion(installed, '1.0.9', '1.0.10')).toBe('projectx-1.0.9.jar');
        expect(chooseVersion([], null, '1.0.9')).toBeNull();
    });
});

describe('remembered selection', () => {
    const accounts = [{ accountId: '1' }, { accountId: '2' }];

    test('restored when it exists, forgotten when stale', () => {
        expect(rememberedSelection(accounts, '2')).toEqual({ action: 'select', accountId: '2' });
        expect(rememberedSelection(accounts, '9')).toEqual({ action: 'forget' });
        expect(rememberedSelection(accounts, undefined)).toEqual({ action: 'keep' });
    });

    test('after a reload the newest character (by createdOn) is chosen when the count changes', () => {
        const list = [
            { accountId: 'a', displayName: 'Alpha', createdOn: '2026-05-01T00:00:00Z' },
            { accountId: 'z', displayName: 'Zulu', createdOn: '2026-09-01T00:00:00Z' }
        ];
        expect(selectionAfterReload(list, 1, 'a')).toEqual({ accountId: 'z', changedCount: true });
        expect(selectionAfterReload(list, 2, 'a')).toEqual({ accountId: 'a', changedCount: false });
        expect(selectionAfterReload(list, 2, null)).toEqual({ accountId: null, changedCount: false });
        expect(selectionAfterReload(list, 2, 'gone')).toEqual({ accountId: 'a', changedCount: false });
        expect(selectionAfterReload([], 2, 'a')).toEqual({ accountId: null, changedCount: true });
    });
});

describe('operations', () => {
    function setup({ response = 1 } = {}) {
        const home = makeTempDir();
        const paths = createPaths(home);
        const log = makeLog();
        const settings = createSettingsStore({ file: paths.settingsFile, log });
        const nicknames = createNicknameStore({ settings });
        const accounts = createAccountsStore({ file: paths.accountsFile, fetch: jest.fn(), log });
        const messageBox = jest.fn(async () => ({ response }));
        const shell = { openPath: jest.fn(async () => '') };
        const ops = createOperations({
            appInfo: { version: '2.0.0', platform: 'win32' },
            windowControls: {},
            messageBox,
            log,
            paths,
            account: {},
            settings,
            nicknames,
            client: {},
            accounts,
            runJagexLogin: jest.fn(),
            hiscores: { lookup: jest.fn(async () => { throw new Error('boom'); }) },
            launcher: {},
            locations: createLocations({ paths, shell, launcherLogFile: () => path.join(home, 'main.log'), log }),
            emit: jest.fn()
        });
        writeJsonFile(paths.accountsFile, [
            { accountId: '111', displayName: 'One', sessionId: 's1', createdOn: '2026-01-01T00:00:00Z' },
            { accountId: '222', displayName: 'Two', sessionId: 's2', createdOn: '2026-01-02T00:00:00Z' }
        ]);
        nicknames.setNickname('111', 'Main');
        nicknames.setNickname('222', 'Alt');
        return { ops, paths, messageBox, shell, nicknames, log };
    }

    test('deleting an account asks first and removes its nickname', async () => {
        const { ops, paths, messageBox } = setup({ response: 1 });
        await expect(ops.deleteAccount('111')).resolves.toEqual({ ok: true });
        expect(messageBox.mock.calls[0][0]).toMatchObject({ title: 'Delete account?', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0 });
        expect(messageBox.mock.calls[0][0]).not.toHaveProperty('confirmIndex');
        expect(readJsonFile(paths.accountsFile).map((a) => a.accountId)).toEqual(['222']);
        expect(readJsonFile(paths.settingsFile).account_nicknames).toEqual({ 222: 'Alt' });
    });

    test('cancelling a delete changes nothing', async () => {
        const { ops, paths } = setup({ response: 0 });
        await expect(ops.deleteAccount('111')).resolves.toEqual({ ok: false, cancelled: true });
        expect(readJsonFile(paths.accountsFile)).toHaveLength(2);
    });

    test('remove all uses a proper dialog and clears accounts and nicknames', async () => {
        const { ops, paths, messageBox } = setup({ response: 1 });
        await expect(ops.removeAllAccounts()).resolves.toEqual({ ok: true });
        expect(messageBox.mock.calls[0][0].detail).toMatch(/All saved Jagex accounts and their nicknames/);
        expect(fs.existsSync(paths.accountsFile)).toBe(false);
        expect(readJsonFile(paths.settingsFile).account_nicknames).toEqual({});
    });

    test('settings from the UI are normalised and owned keys stay owned', async () => {
        const { ops, paths } = setup();
        expect(ops.setSetting('client_ram', ' 2G ')).toEqual({ ok: true });
        expect(readJsonFile(paths.settingsFile)).toMatchObject({ client_ram: '2g', account_nicknames: { 111: 'Main', 222: 'Alt' } });
        expect(ops.getSettings()).toEqual({ client: '0.0.0', version_pref: '0.0.0', proxyip: '', client_ram: '2g', selected_account: null });
    });

    test('a throwing hiscores lookup becomes "Lookup failed."', async () => {
        const { ops } = setup();
        await expect(ops.lookupHiscores('Iron Wick', false)).resolves.toMatchObject({ status: 'error', message: 'Lookup failed.' });
    });

    test('Client Logs opens the per-launch folder, creating it, and falls back to the logs folder', async () => {
        const { ops, paths, shell } = setup();
        await expect(ops.openLocation('clientLogs')).resolves.toEqual({ ok: true });
        expect(shell.openPath).toHaveBeenCalledWith(paths.clientLogsDir);
        expect(fs.existsSync(paths.clientLogsDir)).toBe(true);
        shell.openPath.mockImplementation(async (target) => (target === paths.clientLogsDir ? 'cannot open' : ''));
        await expect(ops.openLocation('clientLogs')).resolves.toEqual({ ok: true });
        expect(shell.openPath).toHaveBeenLastCalledWith(paths.runeliteLogsDir);
    });

    test('a folder that cannot be opened shows an error dialog', async () => {
        const { ops, shell, messageBox } = setup();
        shell.openPath.mockResolvedValue('No application');
        await expect(ops.openLocation('runelite')).resolves.toMatchObject({ ok: false });
        expect(messageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', title: 'Error' }));
    });

    test('the outdated warning offers skip or latest', async () => {
        const { ops, messageBox } = setup({ response: 0 });
        await expect(ops.confirmOutdated('1.0.0', '2.0.0')).resolves.toBe('skip');
        expect(messageBox.mock.calls[0][0]).toMatchObject({
            title: 'Outdated Version Warning',
            buttons: ['Skip latest version', 'Launch with the latest version'],
            defaultId: 1,
            cancelId: 1
        });
        messageBox.mockResolvedValue({ response: 1 });
        await expect(ops.confirmOutdated('1.0.0', '2.0.0')).resolves.toBe('latest');
    });

    test('only one Jagex sign-in at a time', async () => {
        const home = makeTempDir();
        let release;
        const runJagexLogin = jest.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
        const ops = createOperations({ log: makeLog(), runJagexLogin, paths: createPaths(home) });
        const first = ops.addJagexAccounts();
        await expect(ops.addJagexAccounts()).resolves.toMatchObject({ ok: false });
        release();
        await expect(first).resolves.toEqual({ ok: true });
        expect(runJagexLogin).toHaveBeenCalledTimes(1);
    });
});
