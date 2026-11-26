'use strict';

const { isVersionString } = require('./client-versions');
const { isValidAccountId } = require('./nicknames');
const { isValidProfileName } = require('./profiles');
const { parseRam } = require('../shared/ram');
const { LOCATION_KEYS } = require('./locations');
const { isPresetId } = require('./presets');
const { isVpnId } = require('./vpn-store');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function isString(value, max) {
    return typeof value === 'string' && value.length <= max;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}

function isVersion(value) {
    return isVersionString(value);
}

function isProfile(value) {
    return value === 'default' || isValidProfileName(value);
}

// Settings the renderer may change, each with its own rule. Nicknames and panel settings have
// their own operations and are deliberately absent.
const SETTING_RULES = {
    client: (value) => isVersion(value),
    version_pref: (value) => isVersion(value),
    proxyip: (value) => isString(value, 512),
    client_ram: (value) => typeof value === 'string' && parseRam(value) !== null,
    selected_account: (value) => value === null || isValidAccountId(value)
};

function isSettingUpdate(key, value) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTING_RULES, key) && SETTING_RULES[key](value);
}

function isLaunchOptions(value, requireAccount) {
    if (!isPlainObject(value)) {
        return false;
    }
    const allowed = requireAccount ? ['accountId', 'version', 'ram', 'proxy', 'label'] : ['version', 'ram', 'proxy'];
    if (!hasOnlyKeys(value, allowed)) {
        return false;
    }
    if (requireAccount && !isValidAccountId(value.accountId)) {
        return false;
    }
    return isVersion(value.version)
        && (value.ram === undefined || isString(value.ram, 16))
        && (value.proxy === undefined || isString(value.proxy, 512))
        && (value.label === undefined || isString(value.label, 64));
}

const PRESET_KEYS = ['id', 'name', 'script', 'scriptName', 'startAfterLogin', 'delay', 'autoLogin', 'world', 'profile',
    'ram', 'proxy', 'connection', 'vpn', 'breaks', 'stopAfterMinutes', 'whenStopped'];

// A preset from the renderer: the right shape and sizes. presets.js normalises the values.
function isPresetInput(value) {
    if (!isPlainObject(value) || !hasOnlyKeys(value, PRESET_KEYS)) {
        return false;
    }
    const strings = { name: 80, scriptName: 120, delay: 16, profile: 128, ram: 16, proxy: 512, connection: 16, breaks: 16, whenStopped: 16 };
    for (const [key, max] of Object.entries(strings)) {
        if (value[key] !== undefined && !isString(value[key], max)) {
            return false;
        }
    }
    if (value.id !== undefined && !isPresetId(value.id)) {
        return false;
    }
    if (value.script !== undefined && value.script !== null && !isString(value.script, 80)) {
        return false;
    }
    for (const key of ['startAfterLogin', 'autoLogin']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') {
            return false;
        }
    }
    if (value.stopAfterMinutes !== undefined && !Number.isInteger(value.stopAfterMinutes)) {
        return false;
    }
    // Only a reference to a saved config; the main process fills in what is shown from the store.
    if (value.vpn !== undefined && value.vpn !== null) {
        const vpn = value.vpn;
        if (!isPlainObject(vpn) || !hasOnlyKeys(vpn, ['id', 'name', 'endpoint', 'encrypted']) || !isVpnId(vpn.id)) {
            return false;
        }
        if ((vpn.name !== undefined && !isString(vpn.name, 120)) || (vpn.endpoint !== undefined && !isString(vpn.endpoint, 300))
            || (vpn.encrypted !== undefined && typeof vpn.encrypted !== 'boolean')) {
            return false;
        }
    }
    if (value.world !== undefined) {
        const world = value.world;
        if (!isPlainObject(world) || !hasOnlyKeys(world, ['mode', 'number'])) {
            return false;
        }
        if (world.mode !== undefined && !isString(world.mode, 16)) {
            return false;
        }
        if (world.number !== undefined && !Number.isInteger(world.number)) {
            return false;
        }
    }
    return true;
}

function isPanelPatch(value) {
    return isPlainObject(value)
        && hasOnlyKeys(value, ['hidden', 'collapsed'])
        && Object.values(value).every((item) => typeof item === 'boolean');
}

module.exports = {
    LOG_LEVELS,
    SETTING_RULES,
    isString,
    isPlainObject,
    isVersion,
    isProfile,
    isSettingUpdate,
    isLaunchOptions,
    isPresetInput,
    isPresetId,
    isVpnId,
    isSessionId: (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value),
    isInternalName: (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value),
    isPanelPatch,
    isAccountId: isValidAccountId,
    isLocationKey: (value) => LOCATION_KEYS.includes(value),
    isLogLevel: (value) => LOG_LEVELS.includes(value)
};
