'use strict';

const fs = require('fs');
const path = require('path');
const { request, errorMessage } = require('./http');

const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/;
const STRICT_JAR = /^projectx-(\d+(?:\.\d+)*)\.jar$/;
const VERSION_STRING = /^[A-Za-z0-9._-]{1,64}$/;

function isNumericVersion(version) {
    return typeof version === 'string' && NUMERIC_VERSION.test(version);
}

// Versions that are safe to put into a file name and a URL path.
function isVersionString(version) {
    return typeof version === 'string' && VERSION_STRING.test(version) && version !== '.' && version !== '..';
}

function versionParts(version) {
    return String(version)
        .split('.')
        .map((part) => {
            const n = parseInt(part, 10);
            return Number.isNaN(n) ? 0 : n;
        });
}

// Numeric comparison of dotted parts; missing parts count as 0, so 1.0.9 < 1.0.43.
function compareVersions(a, b) {
    const left = versionParts(a);
    const right = versionParts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) {
            return diff < 0 ? -1 : 1;
        }
    }
    return 0;
}

function jarName(version) {
    return 'projectx-' + version + '.jar';
}

function versionFromJarName(name) {
    return name.slice('projectx-'.length, -'.jar'.length);
}

function readDir(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (_) {
        return [];
    }
}

// Every projectx-*.jar containing a digit, newest first.
function listInstalledJars(dir) {
    return readDir(dir)
        .filter((name) => name.startsWith('projectx-') && name.endsWith('.jar') && /\d/.test(name))
        .sort((a, b) => compareVersions(versionFromJarName(b), versionFromJarName(a)));
}

function listNumericJars(dir) {
    return readDir(dir)
        .map((name) => {
            const match = STRICT_JAR.exec(name);
            return match ? { name, version: match[1] } : null;
        })
        .filter(Boolean)
        .sort((a, b) => compareVersions(b.version, a.version));
}

function isJarInstalled(dir, version) {
    return isVersionString(version) && fs.existsSync(path.join(dir, jarName(version)));
}

function pinnedVersion(env) {
    const pin = typeof env.PROJECTX_CLIENT_VERSION === 'string' ? env.PROJECTX_CLIENT_VERSION.trim() : '';
    return pin || null;
}

// The published release is authoritative; a local jar is only used when the site cannot be reached.
async function resolveCurrentVersion({ env = process.env, fetch: fetchImpl, siteUrl, dir, log }) {
    const pin = pinnedVersion(env);
    if (pin) {
        log.info('Client version pinned by PROJECTX_CLIENT_VERSION: ' + pin);
        return { ok: true, version: pin, source: 'pin' };
    }
    const url = siteUrl + '/api/v1/client/latest';
    try {
        const response = await request(fetchImpl, url, { headers: { Accept: 'application/json' } });
        if (response.ok) {
            const body = response.body;
            const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim().replace(/^v/, '') : '';
            if (tag && isVersionString(tag)) {
                log.info('Current client version: ' + tag);
                return { ok: true, version: tag, source: 'site' };
            }
            log.warn('Client version lookup returned no usable version: ' + url);
        } else {
            log.warn('Client version lookup failed with HTTP ' + response.status + ': ' + url);
        }
    } catch (err) {
        log.warn('Client version lookup failed (' + errorMessage(err) + '): ' + url);
    }
    const newest = listNumericJars(dir)[0];
    if (newest) {
        log.info('Using the newest installed client as a fallback: ' + newest.version);
        return { ok: true, version: newest.version, source: 'local' };
    }
    return { ok: false, error: 'Could not determine the client version.' };
}

module.exports = {
    isNumericVersion,
    isVersionString,
    compareVersions,
    jarName,
    versionFromJarName,
    listInstalledJars,
    listNumericJars,
    isJarInstalled,
    pinnedVersion,
    resolveCurrentVersion
};
