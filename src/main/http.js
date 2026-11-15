'use strict';

const DEFAULT_TIMEOUT_MS = 15000;

function timeoutError() {
    return new Error('Request timed out');
}

// Performs a request and reads the whole body ('json', 'text' or 'none') under one timeout, so a
// server that sends headers and then stalls cannot hang the caller. Resolves
// { status, ok, headers, body }; for 'json' an unparsable body is null.
async function request(fetchImpl, url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, read = 'json' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        let body = null;
        if (read === 'json' || read === 'text') {
            const text = await response.text();
            if (read === 'text') {
                body = text;
            } else {
                try {
                    body = text ? JSON.parse(text) : null;
                } catch (_) {
                    body = null;
                }
            }
        } else if (response.body && typeof response.body.cancel === 'function') {
            response.body.cancel().catch(() => {});
        }
        return { status: response.status, ok: response.ok, headers: response.headers, body };
    } catch (err) {
        if (controller.signal.aborted) {
            throw controller.signal.reason instanceof Error ? controller.signal.reason : timeoutError();
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Adds our User-Agent to requests for which applies(url) is true and that do not set one already.
function withUserAgent(fetchImpl, userAgent, applies) {
    return (url, options = {}) => {
        if (!applies(String(url))) {
            return fetchImpl(url, options);
        }
        const headers = new Headers(options.headers || {});
        if (!headers.has('User-Agent')) {
            headers.set('User-Agent', userAgent);
        }
        return fetchImpl(url, { ...options, headers });
    };
}

// Inside Electron, requests go through Chromium's network stack so the system proxy settings
// apply; no cookies are kept and nothing is served from the HTTP cache. Plain Node (the tests)
// uses the global fetch. Our User-Agent goes on requests for which isOwnUrl(url) is true.
function createAppFetch({ net, userAgent, isOwnUrl }) {
    const base = net && typeof net.fetch === 'function'
        ? (url, options = {}) => net.fetch(url, { cache: 'no-store', credentials: 'omit', ...options })
        : (url, options) => globalThis.fetch(url, options);
    return withUserAgent(base, userAgent, isOwnUrl);
}

function errorMessage(err) {
    if (!err) {
        return 'Unknown error';
    }
    if (err.cause && err.cause.code) {
        return (err.message || 'Request failed') + ' (' + err.cause.code + ')';
    }
    return err.message || String(err);
}

module.exports = { DEFAULT_TIMEOUT_MS, request, withUserAgent, createAppFetch, errorMessage };
