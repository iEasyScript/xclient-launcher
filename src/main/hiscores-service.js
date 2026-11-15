'use strict';

const { readJson, writeJson, isPlainObject } = require('./fsutil');
const { request } = require('./http');
const { normaliseName, parseHiscores, summarise } = require('./hiscores');

const HISCORES_URL = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=';
const MINUTE = 60 * 1000;
const TTL = { ok: 30 * MINUTE, 'not-found': 30 * MINUTE, error: 2 * MINUTE };
const FORCE_TTL = 2 * MINUTE;
const SPACING_MS = 1500;
const BACKOFF_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const DISK_MAX_AGE = 24 * 60 * MINUTE;
const MAX_ENTRIES = 300;

function createHiscoresService(options) {
    const {
        fetch: fetchImpl,
        cacheFile,
        log,
        userAgent = 'Project X Launcher',
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    } = options;

    const cache = new Map();
    const inFlight = new Map();
    let queue = Promise.resolve();
    let lastStart = -Infinity;
    let backoffUntil = 0;

    function loadDisk() {
        if (!cacheFile) {
            return;
        }
        const result = readJson(cacheFile);
        if (result.status === 'missing') {
            return;
        }
        if (result.status !== 'ok' || !isPlainObject(result.value) || !isPlainObject(result.value.entries)) {
            log.warn('Ignoring an unreadable hiscores cache');
            return;
        }
        const entries = Object.entries(result.value.entries)
            .filter(([key, entry]) => isPlainObject(entry)
                && (entry.status === 'ok' || entry.status === 'not-found')
                && typeof entry.fetchedAt === 'number'
                && now() - entry.fetchedAt < DISK_MAX_AGE
                && typeof entry.name === 'string'
                && normaliseName(entry.name) !== null
                && key === normaliseName(entry.name).toLowerCase())
            .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
            .slice(-MAX_ENTRIES);
        for (const [key, entry] of entries) {
            cache.set(key, entry);
        }
    }

    function saveDisk() {
        if (!cacheFile) {
            return;
        }
        const entries = {};
        for (const [key, entry] of cache) {
            if (entry.status === 'ok' || entry.status === 'not-found') {
                entries[key] = entry;
            }
        }
        try {
            writeJson(cacheFile, { version: 1, entries }, { compact: true });
        } catch (err) {
            log.warn('Could not save the hiscores cache: ' + err.message);
        }
    }

    function store(key, entry) {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > MAX_ENTRIES) {
            cache.delete(cache.keys().next().value);
        }
        saveDisk();
    }

    async function fetchEntry(name) {
        let response;
        try {
            response = await request(fetchImpl, HISCORES_URL + encodeURIComponent(name), {
                headers: { 'User-Agent': userAgent }
            }, { timeoutMs: REQUEST_TIMEOUT_MS, read: 'text' });
        } catch (_) {
            log.info('Hiscores could not be reached');
            return { status: 'error', message: 'The hiscores could not be reached.' };
        }
        if (response.status === 200) {
            const text = response.body;
            const rows = parseHiscores(text);
            if (!rows) {
                log.warn('Hiscores sent an unexpected page');
                return { status: 'error', message: 'The hiscores sent something unexpected.' };
            }
            return { status: 'ok', data: summarise(rows) };
        }
        if (response.status === 404) {
            return { status: 'not-found' };
        }
        if (response.status === 429 || response.status === 503) {
            backoffUntil = now() + BACKOFF_MS;
            log.warn('Hiscores are busy (HTTP ' + response.status + '); waiting a minute');
            return { status: 'error', message: 'The hiscores are busy. Trying again shortly.' };
        }
        log.warn('Hiscores returned HTTP ' + response.status);
        return { status: 'error', message: 'The hiscores returned HTTP ' + response.status + '.' };
    }

    function enqueue(task) {
        const run = queue.then(async () => {
            const wait = Math.max(lastStart + SPACING_MS, backoffUntil) - now();
            if (wait > 0) {
                await sleep(wait);
            }
            lastStart = now();
            return task();
        });
        queue = run.catch(() => {});
        return run;
    }

    function isFresh(entry, force) {
        const ttl = TTL[entry.status] || 0;
        return now() - entry.fetchedAt < (force ? Math.min(ttl, FORCE_TTL) : ttl);
    }

    async function lookup(rawName, force = false) {
        const name = normaliseName(rawName);
        if (!name) {
            return { status: 'invalid', name: typeof rawName === 'string' ? rawName : '', cached: false };
        }
        const key = name.toLowerCase();
        const cached = cache.get(key);
        if (cached && isFresh(cached, force)) {
            return { ...cached, cached: true };
        }
        if (inFlight.has(key)) {
            return inFlight.get(key);
        }
        const pending = enqueue(async () => {
            const outcome = await fetchEntry(name);
            const entry = { status: outcome.status, name, fetchedAt: now() };
            if (outcome.data) {
                entry.data = outcome.data;
            }
            if (outcome.message) {
                entry.message = outcome.message;
            }
            store(key, entry);
            return { ...entry, cached: false };
        })
            .catch((err) => {
                log.warn('Hiscores lookup failed: ' + (err && err.message ? err.message : 'unknown error'));
                return { status: 'error', name, message: 'Lookup failed.', fetchedAt: now(), cached: false };
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
        return pending;
    }

    loadDisk();

    return { lookup, _cache: cache };
}

module.exports = { createHiscoresService, HISCORES_URL, TTL, SPACING_MS, BACKOFF_MS, MAX_ENTRIES };
