'use strict';

const fs = require('fs');
const path = require('path');
const { createSettingsStore, applyOwnership, DEFAULT_SETTINGS } = require('../src/main/settings');
const {
    isValidAccountId,
    sanitizeNickname,
    normaliseNicknames,
    withNickname,
    normalisePanel,
    mergePanel,
    createNicknameStore
} = require('../src/main/nicknames');
const { makeTempDir, cleanupTempDirs, makeLog, readJsonFile, writeJsonFile } = require('./helpers');

afterEach(cleanupTempDirs);

function setup() {
    const dir = makeTempDir();
    const file = path.join(dir, 'resource_versions.json');
    const log = makeLog();
    const settings = createSettingsStore({ file, log });
    const nicknames = createNicknameStore({ settings });
    return { file, log, settings, nicknames };
}

describe('nickname sanitising', () => {
    test('trims and collapses whitespace', () => {
        expect(sanitizeNickname('   WC    account  ')).toBe('WC account');
    });

    test('strips control, zero-width and bidi characters', () => {
        expect(sanitizeNickname('W\u0000C\u0007 \u200Bacc\u202Eount\u2066')).toBe('WC account');
        expect(sanitizeNickname('a\u0085b\u009Fc')).toBe('abc');
    });

    test('caps at 24 code points without splitting emoji', () => {
        const long = 'abcdefghijklmnopqrstuvw\uD83D\uDE00\uD83D\uDE00';
        const result = sanitizeNickname(long);
        expect(Array.from(result)).toHaveLength(24);
        expect(result.endsWith('\uD83D\uDE00')).toBe(true);
        expect(sanitizeNickname('x'.repeat(23) + ' yz')).toBe('x'.repeat(23));
    });

    test.each([null, undefined, 5, {}, []])('non-strings mean no nickname (%p)', (value) => {
        expect(sanitizeNickname(value)).toBe('');
    });
});

describe('account ids', () => {
    test.each(['418273645', 'abc_DEF.1:2-3', 'a'.repeat(128)])('accepts %p', (id) => {
        expect(isValidAccountId(id)).toBe(true);
    });

    test.each(['__proto__', 'constructor', 'prototype', '', '   ', 'a'.repeat(129), 'bad id', 'x/y', '<script>', 42, null])('rejects %p', (id) => {
        expect(isValidAccountId(id)).toBe(false);
    });
});

describe('nickname maps', () => {
    test('set, replace and remove without mutating the input', () => {
        const original = { 111: 'Old' };
        const replaced = withNickname(original, '111', 'New');
        const added = withNickname(replaced, '222', 'Second');
        const removed = withNickname(added, '111', '   ');
        expect(original).toEqual({ 111: 'Old' });
        expect(replaced).toEqual({ 111: 'New' });
        expect(added).toEqual({ 111: 'New', 222: 'Second' });
        expect(removed).toEqual({ 222: 'Second' });
        expect(() => withNickname({}, '__proto__', 'x')).toThrow('Invalid account id');
    });

    test('malformed entries are dropped on read', () => {
        expect(normaliseNicknames({ 111: 'Fine', 'bad id': 'x', 222: 42, 333: '   ', constructor: 'no' })).toEqual({ 111: 'Fine' });
        expect(normaliseNicknames(['x'])).toEqual({});
        expect(normaliseNicknames(null)).toEqual({});
    });
});

describe('panel settings', () => {
    test('default to shown and expanded, keeping only booleans', () => {
        expect(normalisePanel(undefined)).toEqual({ hidden: false, collapsed: false });
        expect(normalisePanel({ hidden: 'yes', collapsed: true, extra: 1 })).toEqual({ hidden: false, collapsed: true });
    });

    test('updates merge onto current values', () => {
        expect(mergePanel({ hidden: true, collapsed: false }, { collapsed: true })).toEqual({ hidden: true, collapsed: true });
        expect(mergePanel({ hidden: true }, { hidden: 'no' })).toEqual({ hidden: true, collapsed: false });
    });
});

describe('settings file', () => {
    test('a missing file is created with exactly the four defaults', () => {
        const { file, settings } = setup();
        expect(settings.read()).toEqual(DEFAULT_SETTINGS);
        expect(readJsonFile(file)).toEqual({ client: '0.0.0', version_pref: '0.0.0', proxyip: '', client_ram: '1g' });
        expect(fs.readFileSync(file, 'utf8')).toContain('\n  "client"');
    });

    test('targeted updates keep unknown keys and remove keys set to null', () => {
        const { file, settings } = setup();
        writeJsonFile(file, { client: '2.0.0', legacy: { a: 1 }, selected_account: '111' });
        settings.update('proxyip', 'host:1080');
        settings.update('selected_account', null);
        expect(readJsonFile(file)).toEqual({ client: '2.0.0', legacy: { a: 1 }, proxyip: 'host:1080' });
    });

    test('owned keys cannot be written through a targeted update', () => {
        const { settings } = setup();
        expect(() => settings.update('account_nicknames', {})).toThrow();
    });

    test('ownership: a whole-settings write keeps the on-disk nicknames and panel and cannot invent them', () => {
        expect(applyOwnership({ client: '1', account_nicknames: { 1: 'stale' } }, { account_nicknames: { 1: 'fresh' }, accounts_panel: { hidden: true } }))
            .toEqual({ client: '1', account_nicknames: { 1: 'fresh' }, accounts_panel: { hidden: true } });
        expect(applyOwnership({ client: '1', account_nicknames: { 1: 'invented' }, accounts_panel: {} }, { client: '0' }))
            .toEqual({ client: '1' });

        const { file, settings } = setup();
        writeJsonFile(file, { client: '1.0.0', account_nicknames: { 111: 'Fresh' } });
        settings.save({ client: '2.0.0', account_nicknames: { 111: 'Stale' }, accounts_panel: { hidden: true } });
        expect(readJsonFile(file)).toEqual({ client: '2.0.0', account_nicknames: { 111: 'Fresh' } });
    });

    test('a corrupt file is backed up, defaults are used, and writes start fresh', () => {
        const { file, settings, log } = setup();
        fs.writeFileSync(file, '{ broken');
        expect(settings.read()).toEqual(DEFAULT_SETTINGS);
        expect(fs.readFileSync(file + '.bak', 'utf8')).toBe('{ broken');
        expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
        settings.update('client_ram', '2g');
        expect(readJsonFile(file)).toEqual({ ...DEFAULT_SETTINGS, client_ram: '2g' });
    });
});

describe('nickname store', () => {
    test('saving a nickname keeps every other setting', () => {
        const { file, nicknames } = setup();
        writeJsonFile(file, { client: '2.0.0', version_pref: '2.0.0', proxyip: 'p', client_ram: '4g', legacy: true });
        expect(nicknames.setNickname('111', '  WC   account ')).toEqual({ 111: 'WC account' });
        expect(readJsonFile(file)).toEqual({
            client: '2.0.0', version_pref: '2.0.0', proxyip: 'p', client_ram: '4g', legacy: true, account_nicknames: { 111: 'WC account' }
        });
    });

    test('a missing file starts from the four defaults', () => {
        const { file, nicknames } = setup();
        nicknames.setNickname('111', 'Main');
        expect(readJsonFile(file)).toEqual({ ...DEFAULT_SETTINGS, account_nicknames: { 111: 'Main' } });
    });

    test.each(['{ broken', '[1,2,3]', '"text"'])('a corrupt file (%p) is reported and never overwritten', (content) => {
        const { file, nicknames } = setup();
        fs.writeFileSync(file, content);
        expect(() => nicknames.setNickname('111', 'Main')).toThrow();
        expect(() => nicknames.setPanel({ hidden: true })).toThrow();
        expect(() => nicknames.getNicknames()).toThrow();
        expect(fs.readFileSync(file, 'utf8')).toBe(content);
    });

    test('invalid ids are refused', () => {
        const { nicknames } = setup();
        expect(() => nicknames.setNickname('__proto__', 'x')).toThrow('Invalid account id');
    });

    test('removing nicknames for deleted characters', () => {
        const { nicknames } = setup();
        nicknames.setNickname('111', 'One');
        nicknames.setNickname('222', 'Two');
        expect(nicknames.removeNicknames(['111'])).toEqual({ 222: 'Two' });
        expect(nicknames.removeNicknames('all')).toEqual({});
    });

    test('panel settings round trip', () => {
        const { file, nicknames } = setup();
        expect(nicknames.getPanel()).toEqual({ hidden: false, collapsed: false });
        expect(nicknames.setPanel({ collapsed: true })).toEqual({ hidden: false, collapsed: true });
        expect(nicknames.setPanel({ hidden: true })).toEqual({ hidden: true, collapsed: true });
        expect(readJsonFile(file).accounts_panel).toEqual({ hidden: true, collapsed: true });
    });
});
