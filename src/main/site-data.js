'use strict';

const { request } = require('./http');

// What the launcher shows from the site besides the sign-in: recent script and client updates,
// and the scripts the signed-in player can start. Both are cached for a few minutes.

const NEWS_TTL_MS = 10 * 60 * 1000;
const SCRIPTS_TTL_MS = 2 * 60 * 1000;
const MAX_NEWS = 5;
const MAX_TEXT = 160;

function firstLine(text) {
    if (typeof text !== 'string') {
        return '';
    }
    const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '';
    return line.length > MAX_TEXT ? line.slice(0, MAX_TEXT - 1).trimEnd() + '\u2026' : line;
}

function validDate(value) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// The newest script releases from the catalogue, plus the latest client, newest first.
function newsFrom(catalogue, client) {
    const items = [];
    for (const entry of Array.isArray(catalogue) ? catalogue : []) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.version !== 'string' || entry.listed === false) {
            continue;
        }
        const at = validDate(entry.addedAt);
        if (!at) {
            continue;
        }
        items.push({
            kind: 'script',
            title: entry.name + ' ' + entry.version,
            text: firstLine(entry.changelog),
            at
        });
    }
    if (client && typeof client.version === 'string') {
        const at = validDate(client.publishedAt || client.published_at);
        if (at) {
            items.push({ kind: 'client', title: 'Client ' + client.version, text: 'The latest Project X client.', at });
        }
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return items.slice(0, MAX_NEWS);
}

// The player's scripts that can be started now, by name.
function scriptsFrom(body, now = Date.now()) {
    const list = body && Array.isArray(body.entitlements) ? body.entitlements : [];
    const out = [];
    for (const item of list) {
        if (!item || typeof item.internalName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.internalName)) {
            continue;
        }
        const ends = typeof item.expiresAt === 'string' ? Date.parse(item.expiresAt) : NaN;
        if (Number.isFinite(ends) && ends <= now) {
            continue;
        }
        out.push({
            internalName: item.internalName,
            name: typeof item.name === 'string' && item.name ? item.name.slice(0, 80) : item.internalName,
            expiresAt: Number.isFinite(ends) ? new Date(ends).toISOString() : null,
            trial: item.trial === true
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

function shortText(value, max) {
    return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The site's live clients, reduced to what the launcher shows and checked field by field.
function liveFrom(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || !SESSION_ID.test(String(item.id))) {
            continue;
        }
        const state = item.state && typeof item.state === 'object' ? item.state : null;
        out.push({
            id: String(item.id),
            label: shortText(item.label, 80),
            liveness: item.liveness === 'online' || item.liveness === 'stale' ? item.liveness : 'offline',
            remoteControl: item.remoteControl === true,
            stopping: item.stopping === true,
            state: state ? {
                loggedIn: state.loggedIn === true,
                world: finiteOrNull(state.world),
                name: shortText(state.name, 32),
                breakActive: state.breakActive === true,
                breakUntil: finiteOrNull(state.breakUntil),
                scripts: (Array.isArray(state.scripts) ? state.scripts : []).slice(0, 5).map((s) => ({
                    name: shortText(s && s.name, 80) || 'Script',
                    internalName: s && typeof s.internalName === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.internalName) ? s.internalName : null,
                    startedAt: finiteOrNull(s && s.startedAt),
                    status: shortText(s && s.status, 120),
                    xpPerHour: finiteOrNull(s && s.xpPerHour),
                    skill: shortText(s && s.skill, 24)
                }))
            } : null
        });
    }
    return out;
}

function createSiteData({ fetch, siteUrl, readToken, log, now = () => Date.now() }) {
    let news = null;
    let scripts = null;

    async function getJson(path, token) {
        const headers = { Accept: 'application/json' };
        if (token) {
            headers.Authorization = 'Bearer ' + token;
        }
        const response = await request(fetch, siteUrl + path, { headers });
        if (response.status !== 200) {
            throw new Error('HTTP ' + response.status);
        }
        return response.body;
    }

    return {
        async news(force) {
            if (!force && news && now() - news.at < NEWS_TTL_MS) {
                return { ok: true, items: news.items };
            }
            try {
                const [catalogue, client] = await Promise.all([
                    getJson('/api/v1/hub/plugins.json?game=osrs'),
                    getJson('/api/v1/client/latest').catch(() => null)
                ]);
                news = { at: now(), items: newsFrom(catalogue, client) };
                return { ok: true, items: news.items };
            } catch (err) {
                log.info('Could not load the updates feed: ' + err.message);
                return news ? { ok: true, items: news.items, stale: true } : { ok: false, error: 'The updates could not be loaded.', items: [] };
            }
        },
        // The player's running clients and what each is doing, as the site's Control Panel sees
        // them. A membership perk on the site: { ok: false, membersOnly: true } when it isn't theirs.
        async liveClients() {
            const token = readToken();
            if (!token) {
                return { ok: false, error: 'Sign in to see live status.', clients: [] };
            }
            try {
                const response = await request(fetch, siteUrl + '/api/v1/launcher/live', {
                    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }
                });
                if (response.status === 403) {
                    const message = response.body && typeof response.body.message === 'string' ? response.body.message.slice(0, 200) : 'Live status is a membership perk.';
                    return { ok: false, membersOnly: true, error: message, clients: [] };
                }
                if (response.status !== 200 || !response.body || !Array.isArray(response.body.clients)) {
                    throw new Error('HTTP ' + response.status);
                }
                return { ok: true, clients: liveFrom(response.body.clients) };
            } catch (err) {
                log.info('Could not load live client status: ' + err.message);
                return { ok: false, error: 'Live status could not be loaded right now.', clients: [] };
            }
        },
        // Asks a running client, through the site, to stop one script (internalName) or all.
        async stopRemote(sessionId, internalName) {
            const token = readToken();
            if (!token) {
                return { ok: false, error: 'Sign in again to control your clients.' };
            }
            const body = internalName ? { sessionId, type: 'STOP_SCRIPT', internalName } : { sessionId, type: 'STOP_ALL' };
            try {
                const response = await request(fetch, siteUrl + '/api/v1/launcher/live', {
                    method: 'POST',
                    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                    body: JSON.stringify(body)
                });
                const answer = response.body;
                if (answer && answer.ok === true) {
                    return { ok: true };
                }
                return { ok: false, error: answer && typeof answer.error === 'string' ? answer.error.slice(0, 300) : 'The client could not be told to stop (HTTP ' + response.status + ').' };
            } catch (err) {
                log.info('Could not send a stop command: ' + err.message);
                return { ok: false, error: 'The site could not be reached.' };
            }
        },
        async myScripts(force) {
            if (!force && scripts && now() - scripts.at < SCRIPTS_TTL_MS) {
                return { ok: true, scripts: scripts.list };
            }
            const token = readToken();
            if (!token) {
                return { ok: false, error: 'Sign in to see your scripts.', scripts: [] };
            }
            try {
                // peek: looking at what is owned must not start a waiting trial's clock.
                const body = await getJson('/api/v1/entitlements?game=osrs&peek=1', token);
                scripts = { at: now(), list: scriptsFrom(body, now()) };
                return { ok: true, scripts: scripts.list };
            } catch (err) {
                log.info('Could not load your scripts: ' + err.message);
                return scripts ? { ok: true, scripts: scripts.list, stale: true } : { ok: false, error: 'Your scripts could not be loaded.', scripts: [] };
            }
        }
    };
}

module.exports = { newsFrom, scriptsFrom, liveFrom, createSiteData };
