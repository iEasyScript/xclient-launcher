'use strict';

const fs = require('fs');
const { readJson, writeJson, isPlainObject } = require('../fsutil');
const { fetchCharacters } = require('./oauth');
const { errorMessage } = require('../http');

// accounts.json holds Jagex session ids, so it is kept private to the user on POSIX systems.
const ACCOUNTS_MODE = 0o600;

function deepEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a)) {
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
        return false;
    }
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function idOf(account) {
    return account && account.accountId !== undefined && account.accountId !== null ? String(account.accountId) : '';
}

// Merge what one Jagex session reported into the saved list. Pure: returns a new list.
function mergeCharacters(existing, returned, sessionId, nowIso) {
    const list = existing.slice();
    const indexById = new Map();
    list.forEach((account, index) => indexById.set(idOf(account), index));
    let added = 0;
    let updated = 0;
    for (const character of returned) {
        const id = idOf(character);
        if (!id) {
            continue;
        }
        const incoming = { ...character, sessionId };
        if (indexById.has(id)) {
            const index = indexById.get(id);
            const saved = list[index];
            const changed = Object.keys(incoming).some((key) => !deepEqual(saved[key], incoming[key]));
            if (changed) {
                list[index] = { ...saved, ...incoming };
                updated++;
            }
        } else {
            list.push({ ...incoming, createdOn: nowIso });
            indexById.set(id, list.length - 1);
            added++;
        }
    }
    return { list, added, updated };
}

function createdTime(account) {
    const time = Date.parse(account && account.createdOn);
    return Number.isNaN(time) ? 0 : time;
}

// What the renderer is allowed to see: never the session id or other Jagex fields.
function toPublic(account) {
    const name = typeof account.displayName === 'string' && account.displayName.trim() ? account.displayName : null;
    return {
        accountId: idOf(account),
        displayName: name,
        profile: typeof account.profile === 'string' ? account.profile : null,
        createdOn: typeof account.createdOn === 'string' ? account.createdOn : null
    };
}

// Newest first, one entry per accountId. Characters sharing a display name are all kept.
function forDisplay(list) {
    const seen = new Set();
    const result = [];
    const sorted = list.filter(isPlainObject).slice().sort((a, b) => createdTime(b) - createdTime(a));
    for (const account of sorted) {
        const id = idOf(account);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        result.push(toPublic(account));
    }
    return result;
}

function createAccountsStore({ file, fetch: fetchImpl, log, now = () => new Date() }) {
    function read() {
        const result = readJson(file);
        if (result.status === 'ok' && !Array.isArray(result.value)) {
            return { status: 'invalid' };
        }
        return result;
    }

    function write(list) {
        writeJson(file, list, { mode: ACCOUNTS_MODE });
    }

    function listForDisplay() {
        const result = read();
        if (result.status === 'missing') {
            log.info('No saved Jagex accounts yet');
            return { ok: true, accounts: [] };
        }
        if (result.status === 'invalid') {
            return { ok: false, error: 'The accounts data is in an unexpected format.' };
        }
        if (result.status === 'error') {
            log.error('Could not read accounts.json: ' + result.error.message);
            return { ok: false, error: 'Failed to load accounts: ' + result.error.message };
        }
        return { ok: true, accounts: forDisplay(result.value) };
    }

    function findById(accountId) {
        const result = read();
        if (result.status !== 'ok') {
            return null;
        }
        return result.value.find((account) => isPlainObject(account) && idOf(account) === accountId) || null;
    }

    function fileState() {
        try {
            const stat = fs.statSync(file);
            return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch (_) {
            return { exists: false, mtimeMs: 0, size: 0 };
        }
    }

    // Fetch the characters for one game session and merge them in. Refuses to write over a file it cannot read.
    async function fetchAndMerge(sessionId) {
        let characters;
        try {
            characters = await fetchCharacters({ fetch: fetchImpl, sessionId });
        } catch (err) {
            log.warn(errorMessage(err));
            return { ok: false, error: 'Jagex did not return the accounts for this sign-in.' };
        }
        const result = read();
        let existing;
        if (result.status === 'ok') {
            existing = result.value;
        } else if (result.status === 'missing') {
            existing = [];
        } else {
            log.error('accounts.json is unreadable, so the new accounts were not saved over it');
            return { ok: false, error: 'accounts.json is unreadable, so it was left untouched.' };
        }
        const merged = mergeCharacters(existing, characters, sessionId, now().toISOString());
        if (merged.added === 0 && merged.updated === 0) {
            log.info('Jagex accounts already up to date');
            return { ok: true, added: 0, updated: 0 };
        }
        write(merged.list);
        log.info('Jagex accounts: ' + merged.added + ' added, ' + merged.updated + ' updated');
        return { ok: true, added: merged.added, updated: merged.updated };
    }

    async function refreshAll() {
        const result = read();
        if (result.status === 'missing') {
            return { ok: false, error: 'accounts.json does not exist' };
        }
        if (result.status === 'error') {
            return { ok: false, error: 'Failed to read accounts.json' };
        }
        if (result.status === 'invalid' || result.value.length === 0) {
            return { ok: false, error: 'No accounts found to refresh' };
        }
        const sessions = [...new Set(result.value
            .filter(isPlainObject)
            .map((account) => account.sessionId)
            .filter((id) => typeof id === 'string' && id))];
        if (sessions.length === 0) {
            return { ok: false, error: 'No Jagex session was found on the saved accounts.' };
        }
        let successes = 0;
        for (const sessionId of sessions) {
            const merged = await fetchAndMerge(sessionId);
            if (merged.ok) {
                successes++;
            }
        }
        log.info('Refreshed Jagex accounts: ' + successes + ' of ' + sessions.length + ' sign-ins answered');
        if (successes === 0) {
            return {
                ok: false,
                error: 'Jagex could not refresh your accounts. Your sign-in may have expired; use "Add Accounts" to sign in again.'
            };
        }
        const listed = listForDisplay();
        return listed.ok ? { ok: true, accounts: listed.accounts } : { ok: true };
    }

    function deleteAccount(accountId) {
        if (typeof accountId !== 'string' || !accountId) {
            return { ok: false, error: 'Invalid account id' };
        }
        const result = read();
        if (result.status === 'missing') {
            return { ok: false, error: 'Accounts file does not exist' };
        }
        if (result.status !== 'ok') {
            return { ok: false, error: 'Accounts file is corrupted or unreadable' };
        }
        const remaining = result.value.filter((account) => !(isPlainObject(account) && idOf(account) === accountId));
        if (remaining.length === result.value.length) {
            return { ok: false, error: 'Account not found' };
        }
        write(remaining);
        log.info('Deleted a saved Jagex account');
        return { ok: true };
    }

    function removeAll() {
        try {
            fs.unlinkSync(file);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                return { ok: false, error: err.message };
            }
        }
        log.info('Removed all saved Jagex accounts');
        return { ok: true };
    }

    function setProfile(accountId, profile) {
        const result = read();
        if (result.status !== 'ok') {
            return { ok: false, error: 'Account not found' };
        }
        const index = result.value.findIndex((account) => isPlainObject(account) && idOf(account) === accountId);
        if (index < 0) {
            return { ok: false, error: 'Account not found' };
        }
        if (result.value[index].profile === profile) {
            return { ok: true };
        }
        const list = result.value.slice();
        list[index] = { ...list[index], profile };
        write(list);
        return { ok: true };
    }

    return { read, listForDisplay, findById, fileState, fetchAndMerge, refreshAll, deleteAccount, removeAll, setProfile };
}

module.exports = { deepEqual, mergeCharacters, forDisplay, toPublic, createAccountsStore, ACCOUNTS_MODE };
