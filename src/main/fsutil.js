'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function tempNameFor(file) {
    return path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
}

// Write to a sibling temp file and rename, so a crash never leaves a half-written file behind.
// Falls back to a direct write when the rename is refused (Windows, file held open by another app).
function writeFileAtomic(file, data, options = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = tempNameFor(file);
    const writeOptions = { encoding: 'utf8' };
    if (options.mode !== undefined) {
        writeOptions.mode = options.mode;
    }
    try {
        fs.writeFileSync(temp, data, writeOptions);
        fs.renameSync(temp, file);
    } catch (err) {
        try {
            fs.unlinkSync(temp);
        } catch (_) {
            // temp may not exist
        }
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
            fs.writeFileSync(file, data, writeOptions);
        } else {
            throw err;
        }
    }
    if (options.mode !== undefined && process.platform !== 'win32') {
        try {
            fs.chmodSync(file, options.mode);
        } catch (_) {
            // best effort; the write itself succeeded
        }
    }
}

function writeJson(file, value, options = {}) {
    const text = options.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    writeFileAtomic(file, text, options);
}

// { status: 'missing' } | { status: 'ok', value } | { status: 'error', error }
function readJson(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return { status: 'missing' };
        }
        return { status: 'error', error: err };
    }
    try {
        return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) };
    } catch (err) {
        return { status: 'error', error: err };
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { writeFileAtomic, writeJson, readJson, isPlainObject };
