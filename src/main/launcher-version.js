'use strict';

const { request, errorMessage } = require('./http');

const LAUNCHER_FEED_URL = 'https://xclient.dev/api/v1/launcher/osrs/';
const LAUNCHER_LATEST_JSON = LAUNCHER_FEED_URL + 'latest.json';
const GITHUB_OWNER = 'iEasyScript';
const GITHUB_REPO = 'xclient-launcher';
const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';

function cleanVersion(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const version = value.trim().replace(/^v/i, '');
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

// The newest published launcher version: xclient.dev first, the public GitHub releases only if that fails.
async function fetchLatestLauncherVersion({ fetch: fetchImpl, log }) {
    try {
        const response = await request(fetchImpl, LAUNCHER_LATEST_JSON, { headers: { Accept: 'application/json' } });
        if (response.ok) {
            const body = response.body;
            const version = cleanVersion(body && body.version);
            if (version) {
                return { ok: true, version, source: 'site' };
            }
            log.warn('Launcher version lookup returned no usable version: ' + LAUNCHER_LATEST_JSON);
        } else {
            log.warn('Launcher version lookup failed with HTTP ' + response.status + ': ' + LAUNCHER_LATEST_JSON);
        }
    } catch (err) {
        log.warn('Launcher version lookup failed (' + errorMessage(err) + '): ' + LAUNCHER_LATEST_JSON);
    }
    try {
        const response = await request(fetchImpl, GITHUB_LATEST_RELEASE, { headers: { Accept: 'application/vnd.github+json' } });
        if (response.ok) {
            const body = response.body;
            const version = cleanVersion(body && body.tag_name);
            if (version) {
                return { ok: true, version, source: 'github' };
            }
        } else {
            log.warn('Launcher version fallback failed with HTTP ' + response.status);
        }
    } catch (err) {
        log.warn('Launcher version fallback failed (' + errorMessage(err) + ')');
    }
    return { ok: false };
}

module.exports = {
    LAUNCHER_FEED_URL,
    LAUNCHER_LATEST_JSON,
    GITHUB_OWNER,
    GITHUB_REPO,
    GITHUB_LATEST_RELEASE,
    cleanVersion,
    fetchLatestLauncherVersion
};
