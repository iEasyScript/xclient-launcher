'use strict';

const fs = require('fs');
const { readJson, writeJson, isPlainObject } = require('./fsutil');

const DEFAULT_SETTINGS = Object.freeze({
    client: '0.0.0',
    version_pref: '0.0.0',
    proxyip: '',
    client_ram: '1g'
});

// Only the nickname and panel operations may change these; every other write copies them from disk.
const OWNED_KEYS = ['account_nicknames', 'accounts_panel'];

class SettingsCorruptError extends Error {
    constructor(message) {
        super(message || 'The settings file is not valid JSON');
        this.name = 'SettingsCorruptError';
    }
}

function defaults() {
    return { ...DEFAULT_SETTINGS };
}

// Takes the owned keys from what is on disk. If the disk copy has no such key, the incoming one is dropped.
function applyOwnership(incoming, onDisk) {
    const result = { ...incoming };
    for (const key of OWNED_KEYS) {
        if (onDisk && Object.prototype.hasOwnProperty.call(onDisk, key)) {
            result[key] = onDisk[key];
        } else {
            delete result[key];
        }
    }
    return result;
}

function createSettingsStore({ file, log }) {
    let backedUp = false;

    function readDisk() {
        const result = readJson(file);
        if (result.status === 'ok' && !isPlainObject(result.value)) {
            return { status: 'error', error: new Error('settings file is not a JSON object') };
        }
        return result;
    }

    function backupCorrupt(error) {
        if (backedUp) {
            return;
        }
        backedUp = true;
        try {
            fs.copyFileSync(file, file + '.bak');
            log.warn('Settings file could not be read (' + error.message + '); a copy was saved as resource_versions.json.bak');
        } catch (err) {
            log.warn('Settings file could not be read and could not be backed up: ' + err.message);
        }
    }

    function write(settings) {
        writeJson(file, settings);
    }

    // Missing file: created with the four defaults. Corrupt file: backed up and defaults used in memory.
    function read() {
        const result = readDisk();
        if (result.status === 'ok') {
            return result.value;
        }
        if (result.status === 'missing') {
            const created = defaults();
            try {
                write(created);
            } catch (err) {
                log.error('Could not create the settings file: ' + err.message);
            }
            return created;
        }
        backupCorrupt(result.error);
        return defaults();
    }

    function baseForWrite() {
        const result = readDisk();
        if (result.status === 'ok') {
            return { base: result.value, disk: result.value };
        }
        if (result.status === 'error') {
            backupCorrupt(result.error);
        }
        return { base: defaults(), disk: null };
    }

    // Targeted update of one key; undefined or null removes the key.
    function update(key, value) {
        if (OWNED_KEYS.includes(key)) {
            throw new Error('Key ' + key + ' can only be changed through its own operation');
        }
        const { base } = baseForWrite();
        const next = { ...base };
        if (value === undefined || value === null) {
            delete next[key];
        } else {
            next[key] = value;
        }
        write(next);
        return next;
    }

    // Whole-object save, honouring the ownership rule for nicknames and panel settings.
    function save(incoming) {
        const { disk } = baseForWrite();
        const next = applyOwnership(isPlainObject(incoming) ? incoming : {}, disk);
        write(next);
        return next;
    }

    // Synchronous read-modify-write used by the nickname and panel operations.
    // Never writes over a file that exists but cannot be parsed.
    function mutateOwned(mutator) {
        const result = readDisk();
        let current;
        if (result.status === 'ok') {
            current = result.value;
        } else if (result.status === 'missing') {
            current = defaults();
        } else {
            throw new SettingsCorruptError('The settings file is unreadable, so it was left untouched');
        }
        const next = mutator({ ...current });
        write(next);
        return next;
    }

    function readOwned() {
        const result = readDisk();
        if (result.status === 'ok') {
            return result.value;
        }
        if (result.status === 'missing') {
            return defaults();
        }
        throw new SettingsCorruptError('The settings file is unreadable');
    }

    return { read, update, save, mutateOwned, readOwned, file };
}

module.exports = { DEFAULT_SETTINGS, OWNED_KEYS, applyOwnership, createSettingsStore, SettingsCorruptError };
