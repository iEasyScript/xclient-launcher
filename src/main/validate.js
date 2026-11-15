'use strict';

const { isVersionString } = require('./client-versions');
const { isValidAccountId } = require('./nicknames');
const { isValidProfileName } = require('./profiles');
const { parseRam } = require('../shared/ram');
const { LOCATION_KEYS } = require('./locations');

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
    const allowed = requireAccount ? ['accountId', 'version', 'ram', 'proxy'] : ['version', 'ram', 'proxy'];
    if (!hasOnlyKeys(value, allowed)) {
        return false;
    }
    if (requireAccount && !isValidAccountId(value.accountId)) {
        return false;
    }
    return isVersion(value.version)
        && (value.ram === undefined || isString(value.ram, 16))
        && (value.proxy === undefined || isString(value.proxy, 512));
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
    isPanelPatch,
    isAccountId: isValidAccountId,
    isLocationKey: (value) => LOCATION_KEYS.includes(value),
    isLogLevel: (value) => LOG_LEVELS.includes(value)
};
