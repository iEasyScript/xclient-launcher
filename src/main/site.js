'use strict';

const DEFAULT_SITE_URL = 'https://xclient.dev';
const DOWNLOAD_PAGE = 'https://xclient.dev/download';
const MAC_DOWNLOAD_PAGE = 'https://xclient.dev/download?os=mac';

function resolveSiteUrl(env = process.env) {
    const raw = typeof env.PROJECTX_SITE_URL === 'string' ? env.PROJECTX_SITE_URL.trim() : '';
    if (!raw) {
        return DEFAULT_SITE_URL;
    }
    const trimmed = raw.replace(/\/+$/, '');
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            return trimmed;
        }
    } catch (_) {
        // fall through to the default
    }
    return DEFAULT_SITE_URL;
}

function isLocalHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// A URL from the server is opened only if it is on the configured site. Plain http is accepted
// only when the site itself is a local development server.
function isSiteUrl(candidate, siteUrl) {
    try {
        const url = new URL(candidate);
        const site = new URL(siteUrl);
        if (url.origin !== site.origin) {
            return false;
        }
        return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(site.hostname));
    } catch (_) {
        return false;
    }
}

module.exports = { DEFAULT_SITE_URL, DOWNLOAD_PAGE, MAC_DOWNLOAD_PAGE, resolveSiteUrl, isSiteUrl };
