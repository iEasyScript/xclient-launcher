/**
 * Nicknames for saved accounts, and the accounts panel's own settings.
 *
 * Both live in the launcher's settings file (resource_versions.json in
 * .projectx, the one read-properties and write-properties use), under keys
 * this module owns:
 *
 *   account_nicknames  { "<accountId>": "WC account", ... }
 *   accounts_panel     { hidden: false, collapsed: false }
 *
 * Nicknames are keyed by the Jagex character id rather than the display name,
 * so a nickname survives a rename. The renderer writes the rest of that file
 * by reading it, changing a field and writing the whole object back; if a
 * nickname were saved in between, that write would put the old one back. So
 * write-properties keeps whatever is on disk for these keys (see
 * protectOwnedKeys), and only the handlers here change them.
 */

const PROPERTIES_FILE = 'resource_versions.json';
const NICKNAMES_KEY = 'account_nicknames';
const PANEL_KEY = 'accounts_panel';
const OWNED_KEYS = [NICKNAMES_KEY, PANEL_KEY];

const MAX_NICKNAME_LENGTH = 24;

/** Jagex character ids are numeric strings; allow a little more, but not much. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Same as properties.js: what a missing settings file starts as. */
const DEFAULT_PROPERTIES = {
    client: '0.0.0',
    version_pref: '0.0.0',
    proxyip: '',
    client_ram: '1g'
};

const DEFAULT_PANEL_SETTINGS = { hidden: false, collapsed: false };

function isValidAccountId(accountId) {
    return (
        typeof accountId === 'string' &&
        ACCOUNT_ID_PATTERN.test(accountId) &&
        !RESERVED_KEYS.has(accountId)
    );
}

/**
 * A nickname fit to store and show: control characters removed, whitespace
 * collapsed, at most MAX_NICKNAME_LENGTH characters. Empty means "no nickname".
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeNickname(value) {
    if (typeof value !== 'string') {
        return '';
    }
    const cleaned = value
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // By code point, so an emoji is not cut in half.
    return Array.from(cleaned).slice(0, MAX_NICKNAME_LENGTH).join('').trim();
}

/**
 * The nickname map out of a settings object, with anything malformed dropped.
 * @param {object} properties
 * @returns {Record<string, string>}
 */
function readNicknames(properties) {
    const raw = properties && properties[NICKNAMES_KEY];
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return result;
    }
    for (const [accountId, nickname] of Object.entries(raw)) {
        const clean = sanitizeNickname(nickname);
        if (isValidAccountId(accountId) && clean) {
            result[accountId] = clean;
        }
    }
    return result;
}

/**
 * A copy of the map with one nickname set, or removed when it is blank.
 * @param {Record<string, string>} nicknames
 * @param {string} accountId
 * @param {unknown} nickname
 */
function withNickname(nicknames, accountId, nickname) {
    if (!isValidAccountId(accountId)) {
        throw new Error('Invalid account id');
    }
    const next = { ...nicknames };
    const clean = sanitizeNickname(nickname);
    if (clean) {
        next[accountId] = clean;
    } else {
        delete next[accountId];
    }
    return next;
}

function sanitizePanelSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        hidden:
            typeof source.hidden === 'boolean'
                ? source.hidden
                : DEFAULT_PANEL_SETTINGS.hidden,
        collapsed:
            typeof source.collapsed === 'boolean'
                ? source.collapsed
                : DEFAULT_PANEL_SETTINGS.collapsed
    };
}

/**
 * What write-properties should actually write: the renderer's object, but with
 * the keys this module owns taken from disk, so a stale copy cannot undo them.
 * @param {object} incoming what the renderer sent
 * @param {object|null} onDisk what the file holds now
 */
function protectOwnedKeys(incoming, onDisk) {
    const result = { ...(incoming && typeof incoming === 'object' ? incoming : {}) };
    for (const key of OWNED_KEYS) {
        if (onDisk && Object.prototype.hasOwnProperty.call(onDisk, key)) {
            result[key] = onDisk[key];
        } else {
            delete result[key];
        }
    }
    return result;
}

/**
 * Reads and writes the owned keys in the settings file. Synchronous on
 * purpose: the main process runs one handler at a time, so each change is a
 * whole read-modify-write that nothing else in the launcher can interleave.
 * @param {{fs: typeof import('fs'), filePath: string}} options
 */
function createNicknameStore({ fs, filePath }) {
    function readAll() {
        if (!fs.existsSync(filePath)) {
            return { ...DEFAULT_PROPERTIES };
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        // A corrupt file throws here, and nothing is written over it.
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Settings file is not an object');
        }
        return parsed;
    }

    function writeAll(properties) {
        fs.writeFileSync(filePath, JSON.stringify(properties, null, 2), 'utf8');
    }

    return {
        getNicknames() {
            return readNicknames(readAll());
        },
        setNickname(accountId, nickname) {
            const properties = readAll();
            const next = withNickname(readNicknames(properties), accountId, nickname);
            properties[NICKNAMES_KEY] = next;
            writeAll(properties);
            return next;
        },
        getPanelSettings() {
            return sanitizePanelSettings(readAll()[PANEL_KEY]);
        },
        setPanelSettings(patch) {
            const properties = readAll();
            const current = sanitizePanelSettings(properties[PANEL_KEY]);
            const next = sanitizePanelSettings({
                ...current,
                ...(patch && typeof patch === 'object' ? patch : {})
            });
            properties[PANEL_KEY] = next;
            writeAll(properties);
            return next;
        }
    };
}

/**
 * Registers the nickname and panel-settings IPC channels.
 * @param {{ipcMain: import('electron').IpcMain, fs: typeof import('fs'),
 *          path: typeof import('path'), projectxDir: string, log: object}} deps
 */
function registerNicknameHandlers(deps) {
    const { ipcMain, fs, path, projectxDir, log } = deps;
    const store = createNicknameStore({
        fs,
        filePath: path.resolve(projectxDir, PROPERTIES_FILE)
    });

    const guard = (fn) => async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            log.error(`Accounts panel settings: ${error.message}`);
            return { error: error.message };
        }
    };

    ipcMain.handle(
        'nicknames:read',
        guard(async () => ({ nicknames: store.getNicknames() }))
    );

    ipcMain.handle(
        'nicknames:set',
        guard(async (_event, accountId, nickname) => ({
            success: true,
            nicknames: store.setNickname(accountId, nickname)
        }))
    );

    ipcMain.handle(
        'accounts-panel:read',
        guard(async () => ({ settings: store.getPanelSettings() }))
    );

    ipcMain.handle(
        'accounts-panel:write',
        guard(async (_event, patch) => ({
            success: true,
            settings: store.setPanelSettings(patch)
        }))
    );

    return store;
}

module.exports = {
    PROPERTIES_FILE,
    NICKNAMES_KEY,
    PANEL_KEY,
    OWNED_KEYS,
    MAX_NICKNAME_LENGTH,
    DEFAULT_PROPERTIES,
    isValidAccountId,
    sanitizeNickname,
    readNicknames,
    withNickname,
    sanitizePanelSettings,
    protectOwnedKeys,
    createNicknameStore,
    registerNicknameHandlers
};
