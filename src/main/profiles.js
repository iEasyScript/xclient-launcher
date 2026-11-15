'use strict';

const { readJson, writeJson, isPlainObject } = require('./fsutil');

const PROFILE_NAME_MAX = 128;

function isValidProfileName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= PROFILE_NAME_MAX && !/[\u0000-\u001F\u007F]/.test(name);
}

// The client's own profiles, minus its internal entries; "default" is offered separately by the UI.
function readClientProfiles(file, log) {
    const result = readJson(file);
    if (result.status !== 'ok') {
        if (result.status === 'error') {
            log.warn('Could not read the client profiles: ' + result.error.message);
        }
        return [];
    }
    const list = isPlainObject(result.value) && Array.isArray(result.value.profiles) ? result.value.profiles : [];
    const names = [];
    for (const profile of list) {
        if (isPlainObject(profile) && typeof profile.id === 'number' && profile.id > 0
            && isValidProfileName(profile.name) && profile.name !== 'default' && !names.includes(profile.name)) {
            names.push(profile.name);
        }
    }
    return names;
}

function readNonJagexProfile(file, log) {
    const result = readJson(file);
    if (result.status === 'ok' && isPlainObject(result.value) && isValidProfileName(result.value.profile)) {
        return result.value.profile;
    }
    if (result.status === 'error') {
        log.warn('Could not read the normal-account profile preference: ' + result.error.message);
    }
    return null;
}

function writeNonJagexProfile(file, profile) {
    writeJson(file, { profile });
}

module.exports = { isValidProfileName, readClientProfiles, readNonJagexProfile, writeNonJagexProfile };
