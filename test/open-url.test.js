'use strict';

const { EventEmitter } = require('events');
const { createUrlOpener, pickFallbackBrowser } = require('../src/main/open-url');
const { makeLog } = require('./helpers');

const URL = 'https://xclient.dev/pair?code=BCDF-2345';
const NOT_FOUND = new Error('Failed to open: Application not found (0x800401F5)');

function fakeSpawn({ fail = false } = {}) {
    const calls = [];
    const spawn = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = jest.fn();
        setImmediate(() => (fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
        return child;
    };
    spawn.calls = calls;
    return spawn;
}

describe('opening web pages', () => {
    test('the default browser is used when it works', async () => {
        const openExternal = jest.fn(async () => {});
        const spawn = fakeSpawn();
        const detect = jest.fn(async () => []);
        await createUrlOpener({ openExternal, detect, spawn, log: makeLog() })(URL);
        expect(openExternal).toHaveBeenCalledWith(URL);
        expect(detect).not.toHaveBeenCalled();
        expect(spawn.calls).toEqual([]);
    });

    test('without a default browser an installed one is started with the page', async () => {
        const spawn = fakeSpawn();
        const detect = async () => [
            { browser: 'Internet Explorer', executable: 'C:\\Program Files\\Internet Explorer\\iexplore.exe' },
            { browser: 'Microsoft Edge', executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }
        ];
        const openExternal = async () => {
            throw NOT_FOUND;
        };
        await createUrlOpener({ openExternal, detect, spawn, log: makeLog() })(URL);
        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].command).toMatch(/msedge\.exe$/);
        expect(spawn.calls[0].args).toEqual([URL]);
        expect(spawn.calls[0].options).toMatchObject({ detached: true, stdio: 'ignore' });
    });

    test('the original error comes back when no browser can be started', async () => {
        const openExternal = async () => {
            throw NOT_FOUND;
        };
        await expect(createUrlOpener({ openExternal, detect: async () => [], spawn: fakeSpawn(), log: makeLog() })(URL)).rejects.toBe(NOT_FOUND);
        const found = async () => [{ browser: 'Firefox', executable: 'C:\\missing\\firefox.exe' }];
        await expect(createUrlOpener({ openExternal, detect: found, spawn: fakeSpawn({ fail: true }), log: makeLog() })(URL)).rejects.toBe(NOT_FOUND);
        const broken = async () => {
            throw new Error('registry unavailable');
        };
        await expect(createUrlOpener({ openExternal, detect: broken, spawn: fakeSpawn(), log: makeLog() })(URL)).rejects.toBe(NOT_FOUND);
    });

    test('browsers are preferred in a fixed order and old Edge is skipped', () => {
        expect(pickFallbackBrowser([
            { browser: 'Firefox', executable: '/f' },
            { browser: 'Google Chrome', executable: '/c' }
        ])).toBe('/c');
        expect(pickFallbackBrowser([
            { browser: 'Microsoft Edge', executable: 'C:\\Windows\\SystemApps\\MicrosoftEdge.exe' },
            { browser: 'Firefox Nightly', executable: '/n' }
        ])).toBe('/n');
        expect(pickFallbackBrowser(null)).toBeNull();
    });
});
