const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    MAX_NICKNAME_LENGTH,
    NICKNAMES_KEY,
    PANEL_KEY,
    sanitizeNickname,
    readNicknames,
    withNickname,
    isValidAccountId,
    sanitizePanelSettings,
    protectOwnedKeys,
    createNicknameStore,
    registerNicknameHandlers
} = require('../libs/account-nicknames.js');
const propertiesHandler = require('../libs/properties.js');

/**
 * Nicknames live in the launcher settings file next to everything else the
 * renderer reads and writes wholesale, so most of what matters here is that
 * they survive those writes and that nothing odd gets stored.
 */
describe('account nicknames', () => {
    describe('sanitizeNickname', () => {
        test('trims and collapses whitespace', () => {
            expect(sanitizeNickname('   WC    account  ')).toBe('WC account');
        });

        test('strips control and direction characters', () => {
            expect(sanitizeNickname('WC\u0000\u0007 acc\u202Eount\n')).toBe('WC account');
        });

        test('caps the length by character, not byte', () => {
            const long = 'a'.repeat(MAX_NICKNAME_LENGTH + 10);
            expect(sanitizeNickname(long)).toHaveLength(MAX_NICKNAME_LENGTH);

            const emoji = '🪓'.repeat(MAX_NICKNAME_LENGTH + 2);
            expect(Array.from(sanitizeNickname(emoji))).toHaveLength(MAX_NICKNAME_LENGTH);
        });

        test('anything but a string is no nickname', () => {
            expect(sanitizeNickname(undefined)).toBe('');
            expect(sanitizeNickname(42)).toBe('');
            expect(sanitizeNickname({ toString: () => 'x' })).toBe('');
        });
    });

    describe('account ids', () => {
        test('accepts Jagex-style ids', () => {
            expect(isValidAccountId('123456789')).toBe(true);
            expect(isValidAccountId('abc-DEF_1')).toBe(true);
        });

        test('rejects prototype keys, blanks and junk', () => {
            expect(isValidAccountId('__proto__')).toBe(false);
            expect(isValidAccountId('constructor')).toBe(false);
            expect(isValidAccountId('')).toBe(false);
            expect(isValidAccountId('has space')).toBe(false);
            expect(isValidAccountId(123)).toBe(false);
            expect(isValidAccountId('x'.repeat(129))).toBe(false);
        });
    });

    describe('withNickname / readNicknames', () => {
        test('sets, replaces and removes without touching the input', () => {
            const start = { 1: 'Main' };
            const set = withNickname(start, '2', ' WC account ');
            expect(set).toEqual({ 1: 'Main', 2: 'WC account' });
            expect(start).toEqual({ 1: 'Main' });

            expect(withNickname(set, '2', 'Fishing alt')).toEqual({ 1: 'Main', 2: 'Fishing alt' });
            expect(withNickname(set, '2', '   ')).toEqual({ 1: 'Main' });
        });

        test('refuses an invalid account id', () => {
            expect(() => withNickname({}, '__proto__', 'x')).toThrow('Invalid account id');
        });

        test('drops malformed entries when reading', () => {
            const props = {
                [NICKNAMES_KEY]: { 1: 'Main', 2: '', 3: 7, 'bad id': 'x', 4: '  Pures  ' }
            };
            expect(readNicknames(props)).toEqual({ 1: 'Main', 4: 'Pures' });
            expect(readNicknames({ [NICKNAMES_KEY]: ['Main'] })).toEqual({});
            expect(readNicknames({})).toEqual({});
            expect(readNicknames(null)).toEqual({});
        });
    });

    describe('panel settings', () => {
        test('defaults to shown and expanded, and keeps only booleans', () => {
            expect(sanitizePanelSettings(undefined)).toEqual({ hidden: false, collapsed: false });
            expect(sanitizePanelSettings({ hidden: 'yes', collapsed: true, extra: 1 })).toEqual({
                hidden: false,
                collapsed: true
            });
        });
    });

    describe('protectOwnedKeys', () => {
        test('keeps the on-disk nicknames over a stale renderer copy', () => {
            const incoming = {
                client: '1.2.3',
                [NICKNAMES_KEY]: { 1: 'Old' },
                [PANEL_KEY]: { hidden: false }
            };
            const onDisk = {
                client: '1.2.2',
                [NICKNAMES_KEY]: { 1: 'New' },
                [PANEL_KEY]: { hidden: true, collapsed: false }
            };
            expect(protectOwnedKeys(incoming, onDisk)).toEqual({
                client: '1.2.3',
                [NICKNAMES_KEY]: { 1: 'New' },
                [PANEL_KEY]: { hidden: true, collapsed: false }
            });
        });

        test('does not let the renderer invent owned keys', () => {
            const result = protectOwnedKeys({ client: '1', [NICKNAMES_KEY]: { 1: 'x' } }, null);
            expect(result).toEqual({ client: '1' });
        });
    });

    describe('store and IPC', () => {
        let tempDir;
        let filePath;
        let handlers;
        let log;

        beforeEach(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxnick-'));
            filePath = path.join(tempDir, 'resource_versions.json');
            handlers = {};
            log = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        const ipcMain = () => ({
            handle: (channel, fn) => {
                handlers[channel] = fn;
            }
        });

        test('saving a nickname keeps the rest of the settings', () => {
            fs.writeFileSync(
                filePath,
                JSON.stringify({ client: '1.0.40', client_ram: '2g', selected_account: '9' })
            );
            const store = createNicknameStore({ fs, filePath });

            expect(store.setNickname('9', 'WC account')).toEqual({ 9: 'WC account' });

            const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(onDisk).toEqual({
                client: '1.0.40',
                client_ram: '2g',
                selected_account: '9',
                [NICKNAMES_KEY]: { 9: 'WC account' }
            });
            expect(store.getNicknames()).toEqual({ 9: 'WC account' });
        });

        test('a missing settings file starts from the launcher defaults', () => {
            const store = createNicknameStore({ fs, filePath });
            store.setNickname('1', 'Main');
            const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(onDisk.client).toBe('0.0.0');
            expect(onDisk[NICKNAMES_KEY]).toEqual({ 1: 'Main' });
        });

        test('a corrupt settings file is reported, never overwritten', async () => {
            fs.writeFileSync(filePath, '{not json');
            registerNicknameHandlers({ ipcMain: ipcMain(), fs, path, projectxDir: tempDir, log });

            const result = await handlers['nicknames:set']({}, '1', 'Main');
            expect(result.error).toBeDefined();
            expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json');
        });

        test('IPC round trip for nicknames and panel settings', async () => {
            fs.writeFileSync(filePath, JSON.stringify({ client: '1.0.40' }));
            registerNicknameHandlers({ ipcMain: ipcMain(), fs, path, projectxDir: tempDir, log });

            expect(await handlers['nicknames:read']()).toEqual({ nicknames: {} });

            const saved = await handlers['nicknames:set']({}, '5', '  Pure  ');
            expect(saved).toEqual({ success: true, nicknames: { 5: 'Pure' } });
            expect(await handlers['nicknames:read']()).toEqual({ nicknames: { 5: 'Pure' } });

            const rejected = await handlers['nicknames:set']({}, '__proto__', 'x');
            expect(rejected).toEqual({ error: 'Invalid account id' });

            expect(await handlers['accounts-panel:read']()).toEqual({
                settings: { hidden: false, collapsed: false }
            });
            expect(await handlers['accounts-panel:write']({}, { collapsed: true })).toEqual({
                success: true,
                settings: { hidden: false, collapsed: true }
            });
            expect(await handlers['accounts-panel:write']({}, { hidden: true })).toEqual({
                success: true,
                settings: { hidden: true, collapsed: true }
            });
        });

        test('write-properties from the renderer cannot undo a nickname', async () => {
            fs.writeFileSync(filePath, JSON.stringify({ client: '1.0.40', client_ram: '1g' }));
            const deps = { ipcMain: ipcMain(), fs, path, projectxDir: tempDir, log };
            await propertiesHandler(deps);
            registerNicknameHandlers(deps);

            // The renderer reads the settings...
            const stale = await handlers['read-properties']();
            // ...a nickname is saved meanwhile...
            await handlers['nicknames:set']({}, '7', 'WC account');
            // ...and the renderer writes its older copy back with one change.
            await handlers['write-properties']({}, { ...stale, client_ram: '4g' });

            const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(onDisk.client_ram).toBe('4g');
            expect(onDisk[NICKNAMES_KEY]).toEqual({ 7: 'WC account' });
            expect(await handlers['nicknames:read']()).toEqual({ nicknames: { 7: 'WC account' } });
        });
    });
});
