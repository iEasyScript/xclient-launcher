'use strict';

const { isPlainObject } = require('./fsutil');

const MAX_NICKNAME = 24;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g;

function isValidAccountId(id) {
    return typeof id === 'string' && ACCOUNT_ID.test(id) && !FORBIDDEN_IDS.has(id);
}

// Returns the cleaned nickname, or '' meaning "no nickname".
function sanitizeNickname(value) {
    if (typeof value !== 'string') {
        return '';
    }
    const cleaned = value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    return Array.from(cleaned).slice(0, MAX_NICKNAME).join('').trim();
}

function normaliseNicknames(raw) {
    const result = {};
    if (!isPlainObject(raw)) {
        return result;
    }
    for (const id of Object.keys(raw)) {
        if (!isValidAccountId(id)) {
            continue;
        }
        const nickname = sanitizeNickname(raw[id]);
        if (nickname) {
            result[id] = nickname;
        }
    }
    return result;
}

// Returns a new map; the input is never changed.
function withNickname(map, accountId, text) {
    if (!isValidAccountId(accountId)) {
        throw new Error('Invalid account id');
    }
    const next = normaliseNicknames(map);
    const nickname = sanitizeNickname(text);
    if (nickname) {
        next[accountId] = nickname;
    } else {
        delete next[accountId];
    }
    return next;
}

function normalisePanel(raw) {
    const source = isPlainObject(raw) ? raw : {};
    return {
        hidden: typeof source.hidden === 'boolean' ? source.hidden : false,
        collapsed: typeof source.collapsed === 'boolean' ? source.collapsed : false
    };
}

function mergePanel(current, patch) {
    const next = normalisePanel(current);
    const changes = isPlainObject(patch) ? patch : {};
    for (const key of ['hidden', 'collapsed']) {
        if (typeof changes[key] === 'boolean') {
            next[key] = changes[key];
        }
    }
    return next;
}

function createNicknameStore({ settings }) {
    return {
        getNicknames() {
            return normaliseNicknames(settings.readOwned().account_nicknames);
        },
        setNickname(accountId, text) {
            if (!isValidAccountId(accountId)) {
                throw new Error('Invalid account id');
            }
            const written = settings.mutateOwned((current) => {
                current.account_nicknames = withNickname(current.account_nicknames, accountId, text);
                return current;
            });
            return written.account_nicknames;
        },
        // Used when characters are deleted, so their nicknames do not linger.
        removeNicknames(accountIds) {
            const current = settings.readOwned();
            const existing = normaliseNicknames(current.account_nicknames);
            const targets = accountIds === 'all' ? Object.keys(existing) : accountIds.filter((id) => existing[id]);
            if (targets.length === 0) {
                return existing;
            }
            const written = settings.mutateOwned((latest) => {
                const map = normaliseNicknames(latest.account_nicknames);
                for (const id of targets) {
                    delete map[id];
                }
                latest.account_nicknames = map;
                return latest;
            });
            return written.account_nicknames;
        },
        getPanel() {
            return normalisePanel(settings.readOwned().accounts_panel);
        },
        setPanel(patch) {
            const written = settings.mutateOwned((current) => {
                current.accounts_panel = mergePanel(current.accounts_panel, patch);
                return current;
            });
            return written.accounts_panel;
        }
    };
}

module.exports = {
    MAX_NICKNAME,
    isValidAccountId,
    sanitizeNickname,
    normaliseNicknames,
    withNickname,
    normalisePanel,
    mergePanel,
    createNicknameStore
};
