'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, readJson, isPlainObject } = require('./fsutil');
const { parseWireGuardConfig, toWireGuardText, describeConfig, MAX_CONFIG_BYTES } = require('./wireguard');

// Saved WireGuard configs, one file each under the user-data folder, kept apart from the presets
// so a preset never holds a private key. A preset refers to its config by id and keeps only the
// name and endpoint for display.
//
// The config is encrypted with the system key store (secretBox, Electron's safeStorage) when one
// is available. When it is not (some Linux desktops have none), the config is kept unencrypted,
// readable only by this user where the system allows it, and the UI says so.

const VPN_ID = /^[a-f0-9]{16}$/;
const FILE_MODE = 0o600;

function isVpnId(value) {
    return typeof value === 'string' && VPN_ID.test(value);
}

function createVpnStore({ dir, secretBox, log }) {
    // Imported this session but not yet saved in a preset; sweep() keeps these.
    const pending = new Set();

    function fileFor(id) {
        if (!isVpnId(id)) {
            throw new Error('Invalid VPN config id.');
        }
        return path.join(dir, id + '.json');
    }

    function canEncrypt() {
        try {
            return Boolean(secretBox && secretBox.isAvailable());
        } catch (err) {
            log.warn('Could not check the system key store: ' + err.message);
            return false;
        }
    }

    function readRecord(id) {
        const result = readJson(fileFor(id));
        if (result.status !== 'ok' || !isPlainObject(result.value)) {
            return null;
        }
        return result.value;
    }

    function infoOf(id, record) {
        return {
            id,
            name: typeof record.name === 'string' ? record.name : 'WireGuard',
            endpoint: typeof record.endpoint === 'string' ? record.endpoint : '',
            encrypted: record.encrypted === true
        };
    }

    // Saves a config from the text of a .conf file. Returns what the UI may show, never the key.
    function importText(text, fileName) {
        const parsed = parseWireGuardConfig(text);
        if (!parsed.ok) {
            return parsed;
        }
        const clean = toWireGuardText(parsed.config);
        const shown = describeConfig(parsed.config, fileName);
        const encrypted = canEncrypt();
        const record = { v: 1, name: shown.name, endpoint: shown.endpoint, encrypted };
        if (encrypted) {
            record.data = Buffer.from(secretBox.encrypt(clean)).toString('base64');
        } else {
            record.text = clean;
        }
        const id = crypto.randomBytes(8).toString('hex');
        writeFileAtomic(fileFor(id), JSON.stringify(record, null, 2), { mode: FILE_MODE });
        pending.add(id);
        log.info('Saved a WireGuard config (' + (encrypted ? 'encrypted' : 'unencrypted, no system key store') + ')');
        return { ok: true, vpn: infoOf(id, record), warnings: parsed.warnings };
    }

    function importFile(filePath) {
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            return { ok: false, error: 'The file could not be opened: ' + err.message };
        }
        if (!stat.isFile()) {
            return { ok: false, error: 'That is not a file.' };
        }
        if (stat.size > MAX_CONFIG_BYTES) {
            return { ok: false, error: 'The file is too big to be a WireGuard config.' };
        }
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return { ok: false, error: 'The file could not be read: ' + err.message };
        }
        return importText(text, path.basename(filePath));
    }

    return {
        importText,
        importFile,
        info(id) {
            if (!isVpnId(id)) {
                return null;
            }
            const record = readRecord(id);
            return record ? infoOf(id, record) : null;
        },
        // The parsed config, for starting the helper. Throws a message fit for the user.
        load(id) {
            const record = isVpnId(id) ? readRecord(id) : null;
            if (!record) {
                throw new Error('The WireGuard config for this preset is missing. Import it again in the preset.');
            }
            let text;
            if (record.encrypted === true) {
                if (!canEncrypt() || typeof record.data !== 'string') {
                    throw new Error('The saved WireGuard config could not be unlocked on this PC. Import it again in the preset.');
                }
                try {
                    text = secretBox.decrypt(Buffer.from(record.data, 'base64'));
                } catch (_) {
                    throw new Error('The saved WireGuard config could not be unlocked on this PC. Import it again in the preset.');
                }
            } else if (typeof record.text === 'string') {
                text = record.text;
            } else {
                throw new Error('The saved WireGuard config is damaged. Import it again in the preset.');
            }
            const parsed = parseWireGuardConfig(text);
            if (!parsed.ok) {
                throw new Error('The saved WireGuard config is damaged. Import it again in the preset.');
            }
            return parsed.config;
        },
        // A preset now refers to it, so later sweeps judge it by the presets alone.
        settle(id) {
            pending.delete(id);
        },
        remove(id) {
            pending.delete(id);
            try {
                fs.rmSync(fileFor(id), { force: true });
            } catch (err) {
                log.warn('Could not delete a WireGuard config: ' + err.message);
            }
        },
        // Deletes saved configs no preset refers to, except ones imported for a preset being edited.
        sweep(keepIds) {
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch (_) {
                return 0;
            }
            let removed = 0;
            for (const name of names) {
                const match = /^([a-f0-9]{16})\.json$/.exec(name);
                if (match && !keepIds.has(match[1]) && !pending.has(match[1])) {
                    try {
                        fs.rmSync(path.join(dir, name), { force: true });
                        removed++;
                    } catch (err) {
                        log.warn('Could not delete an unused WireGuard config: ' + err.message);
                    }
                }
            }
            return removed;
        },
        canEncrypt
    };
}

module.exports = { isVpnId, createVpnStore };
