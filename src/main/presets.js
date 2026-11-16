'use strict';

const crypto = require('crypto');
const { readJson, writeJson, isPlainObject } = require('./fsutil');
const { isValidAccountId } = require('./nicknames');
const { isValidProfileName } = require('./profiles');
const { parseRam } = require('../shared/ram');

// Launch presets: what a client does by itself once it opens for an account. Stored in the
// launcher's own folder; the client is handed one preset at launch (see toClientPreset).

const MAX_PRESETS = 50;
const MAX_NAME = 40;
const PRESET_ID = /^[a-z0-9]{8,24}$/;
const INTERNAL_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const WORLD_MODES = ['keep', 'world', 'members', 'free'];
const DELAYS = ['random', 'none'];
const BREAKS = ['keep', 'off', 'normal', 'short'];
const WHEN_STOPPED = ['logout-close', 'logout', 'stay'];
const STOP_AFTER = [0, 60, 120, 180, 240, 360, 480];

// Play/break minute ranges handed to the client for each break choice.
const BREAK_RANGES = {
    normal: { playMinutes: { min: 45, max: 90 }, breakMinutes: { min: 5, max: 15 } },
    short: { playMinutes: { min: 20, max: 40 }, breakMinutes: { min: 2, max: 8 } }
};

const DEFAULT_PRESET = Object.freeze({
    name: 'New preset',
    script: null,
    scriptName: '',
    startAfterLogin: true,
    delay: 'random',
    autoLogin: true,
    world: { mode: 'keep', number: 302 },
    profile: 'default',
    ram: '',
    proxy: '',
    breaks: 'keep',
    stopAfterMinutes: 0,
    whenStopped: 'logout-close'
});

const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g;

function cleanName(value) {
    const text = typeof value === 'string' ? value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim() : '';
    return Array.from(text).slice(0, MAX_NAME).join('').trim() || DEFAULT_PRESET.name;
}

function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function isWorldNumber(value) {
    return Number.isInteger(value) && value >= 301 && value <= 650;
}

function newPresetId() {
    return crypto.randomBytes(8).toString('hex');
}

function isPresetId(value) {
    return typeof value === 'string' && PRESET_ID.test(value) && !FORBIDDEN_IDS.has(value);
}

// Turns anything into a valid preset, keeping what is valid and defaulting the rest.
function normalisePreset(raw, id) {
    const source = isPlainObject(raw) ? raw : {};
    const world = isPlainObject(source.world) ? source.world : {};
    const script = typeof source.script === 'string' && INTERNAL_NAME.test(source.script) ? source.script : null;
    const ram = typeof source.ram === 'string' && source.ram !== '' && parseRam(source.ram) ? source.ram : '';
    return {
        id: isPresetId(id) ? id : isPresetId(source.id) ? source.id : newPresetId(),
        name: cleanName(source.name),
        script,
        scriptName: script && typeof source.scriptName === 'string' ? source.scriptName.replace(INVISIBLE, '').slice(0, 80) : '',
        startAfterLogin: typeof source.startAfterLogin === 'boolean' ? source.startAfterLogin : DEFAULT_PRESET.startAfterLogin,
        delay: pick(source.delay, DELAYS, DEFAULT_PRESET.delay),
        autoLogin: typeof source.autoLogin === 'boolean' ? source.autoLogin : DEFAULT_PRESET.autoLogin,
        world: {
            mode: pick(world.mode, WORLD_MODES, 'keep'),
            number: isWorldNumber(world.number) ? world.number : DEFAULT_PRESET.world.number
        },
        profile: source.profile === 'default' || isValidProfileName(source.profile) ? source.profile : 'default',
        ram,
        proxy: typeof source.proxy === 'string' ? source.proxy.trim().slice(0, 512) : '',
        breaks: pick(source.breaks, BREAKS, DEFAULT_PRESET.breaks),
        stopAfterMinutes: STOP_AFTER.includes(source.stopAfterMinutes) ? source.stopAfterMinutes : 0,
        whenStopped: pick(source.whenStopped, WHEN_STOPPED, DEFAULT_PRESET.whenStopped)
    };
}

function normaliseStore(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const presets = [];
    const seen = new Set();
    for (const item of Array.isArray(source.presets) ? source.presets : []) {
        if (presets.length >= MAX_PRESETS) {
            break;
        }
        const preset = normalisePreset(item);
        if (!seen.has(preset.id)) {
            seen.add(preset.id);
            presets.push(preset);
        }
    }
    const assignments = {};
    if (isPlainObject(source.assignments)) {
        for (const [accountId, presetId] of Object.entries(source.assignments)) {
            if (isValidAccountId(accountId) && seen.has(presetId)) {
                assignments[accountId] = presetId;
            }
        }
    }
    return { v: 1, presets, assignments };
}

// What the client receives in PROJECTX_LAUNCH_PRESET. Proxy, memory and the settings profile
// are applied by the launcher itself and are never part of it.
function toClientPreset(preset) {
    const p = normalisePreset(preset, preset && preset.id);
    const breaks = p.breaks === 'normal' || p.breaks === 'short'
        ? { mode: 'on', ...BREAK_RANGES[p.breaks] }
        : { mode: p.breaks };
    return {
        v: 1,
        name: p.name,
        script: p.script,
        startAfterLogin: Boolean(p.script) && p.startAfterLogin,
        startDelaySeconds: p.delay === 'random' ? { min: 10, max: 60 } : { min: 0, max: 0 },
        autoLogin: p.autoLogin,
        world: p.world.mode === 'world' ? { mode: 'world', number: p.world.number } : { mode: p.world.mode },
        breaks,
        stopAfterMinutes: p.stopAfterMinutes,
        whenStopped: p.whenStopped
    };
}

function createPresetStore({ file, log }) {
    function read() {
        const result = readJson(file);
        if (result.status === 'error') {
            log.warn('Could not read the launch presets: ' + result.error.message);
        }
        return normaliseStore(result.status === 'ok' ? result.value : null);
    }

    function write(store) {
        const clean = normaliseStore(store);
        writeJson(file, clean);
        return clean;
    }

    return {
        list() {
            return read();
        },
        save(raw) {
            const store = read();
            const preset = normalisePreset(raw, raw && raw.id);
            const index = store.presets.findIndex((item) => item.id === preset.id);
            if (index >= 0) {
                store.presets[index] = preset;
            } else {
                if (store.presets.length >= MAX_PRESETS) {
                    throw new Error('You can keep up to ' + MAX_PRESETS + ' presets.');
                }
                store.presets.push(preset);
            }
            return { store: write(store), preset };
        },
        remove(presetId) {
            const store = read();
            store.presets = store.presets.filter((item) => item.id !== presetId);
            for (const [accountId, assigned] of Object.entries(store.assignments)) {
                if (assigned === presetId) {
                    delete store.assignments[accountId];
                }
            }
            return write(store);
        },
        assign(accountId, presetId) {
            const store = read();
            if (presetId === null) {
                delete store.assignments[accountId];
            } else if (store.presets.some((item) => item.id === presetId)) {
                store.assignments[accountId] = presetId;
            } else {
                throw new Error('That preset no longer exists.');
            }
            return write(store);
        },
        forAccount(accountId) {
            const store = read();
            const presetId = store.assignments[accountId];
            return presetId ? store.presets.find((item) => item.id === presetId) || null : null;
        },
        // Used when characters are deleted, so their assignments do not linger.
        unassign(accountIds) {
            const store = read();
            const targets = accountIds === 'all' ? Object.keys(store.assignments) : accountIds;
            if (!targets.some((id) => store.assignments[id])) {
                return store;
            }
            for (const id of targets) {
                delete store.assignments[id];
            }
            return write(store);
        }
    };
}

module.exports = {
    MAX_PRESETS,
    WORLD_MODES,
    DELAYS,
    BREAKS,
    WHEN_STOPPED,
    STOP_AFTER,
    DEFAULT_PRESET,
    isPresetId,
    normalisePreset,
    normaliseStore,
    toClientPreset,
    createPresetStore
};
