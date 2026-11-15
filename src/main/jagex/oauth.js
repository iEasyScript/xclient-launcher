'use strict';

const crypto = require('crypto');
const { request } = require('../http');

const AUTH_URL = 'https://account.jagex.com/oauth2/auth';
const TOKEN_URL = 'https://account.jagex.com/oauth2/token';
const LAUNCHER_CLIENT_ID = 'com_jagex_auth_desktop_launcher';
const LAUNCHER_REDIRECT = 'https://secure.runescape.com/m=weblogin/launcher-redirect';
const LAUNCHER_SCOPES = 'openid offline gamesso.token.create user.profile.read';
const GAME_CLIENT_ID = '1fddee4e-b100-4f4e-b2b0-097f9088f9d2';
const GAME_REDIRECT = 'http://localhost';
const GAME_SCOPES = 'openid offline';
const SESSIONS_URL = 'https://auth.jagex.com/game-session/v1/sessions';
const ACCOUNTS_URL = 'https://auth.jagex.com/game-session/v1/accounts';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomAlphanumeric(length) {
    let result = '';
    while (result.length < length) {
        for (const byte of crypto.randomBytes(length * 2)) {
            // 248 is the largest multiple of 62 below 256; skipping above it keeps the choice unbiased.
            if (byte < 248 && result.length < length) {
                result += ALPHANUMERIC[byte % ALPHANUMERIC.length];
            }
        }
    }
    return result;
}

// A fresh verifier, challenge and state for every sign-in attempt.
function createPkce() {
    const verifier = base64url(crypto.randomBytes(45));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge, state: randomAlphanumeric(16) };
}

// URLSearchParams encodes spaces as '+', which is what Jagex expects for scope.
function buildQuery(pairs) {
    return new URLSearchParams(pairs).toString();
}

function buildLoginUrl({ challenge, state }) {
    return AUTH_URL + '?' + buildQuery([
        ['auth_method', ''],
        ['login_type', ''],
        ['flow', 'launcher'],
        ['response_type', 'code'],
        ['client_id', LAUNCHER_CLIENT_ID],
        ['redirect_uri', LAUNCHER_REDIRECT],
        ['code_challenge', challenge],
        ['code_challenge_method', 'S256'],
        ['prompt', 'login'],
        ['scope', LAUNCHER_SCOPES],
        ['state', state]
    ]);
}

function buildConsentUrl({ idToken, nonce, state }) {
    return AUTH_URL + '?' + buildQuery([
        ['id_token_hint', idToken],
        ['nonce', nonce],
        ['prompt', 'consent'],
        ['redirect_uri', GAME_REDIRECT],
        ['response_type', 'id_token code'],
        ['state', state],
        ['client_id', GAME_CLIENT_ID],
        ['scope', GAME_SCOPES]
    ]);
}

function isLauncherRedirect(url) {
    try {
        const parsed = new URL(url);
        const expected = new URL(LAUNCHER_REDIRECT);
        return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
    } catch (_) {
        return false;
    }
}

// Decide what a browser navigation means. The id_token test must come first: the final
// localhost URL also carries a code parameter.
function classifyNavigation(url) {
    if (typeof url !== 'string') {
        return null;
    }
    if (url.includes('id_token=')) {
        const hash = url.indexOf('#');
        const params = new URLSearchParams(hash >= 0 ? url.slice(hash + 1) : '');
        const idToken = params.get('id_token');
        return idToken ? { type: 'id_token', idToken, state: params.get('state') } : null;
    }
    // Jagex's language switcher also carries a code parameter.
    if (url.includes('code=') && !url.includes('locale?') && isLauncherRedirect(url)) {
        const params = new URL(url).searchParams;
        const code = params.get('code');
        return code ? { type: 'code', code, state: params.get('state') } : null;
    }
    return null;
}

class JagexError extends Error {}

async function exchangeCode({ fetch: fetchImpl, code, verifier }) {
    const response = await request(fetchImpl, TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: LAUNCHER_CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: LAUNCHER_REDIRECT
        }).toString()
    });
    if (!response.ok) {
        throw new JagexError('Jagex token exchange failed (HTTP ' + response.status + ')');
    }
    const body = response.body;
    if (!body || typeof body.id_token !== 'string' || !body.id_token) {
        throw new JagexError('Jagex token exchange returned no identity token');
    }
    return body.id_token;
}

async function createGameSession({ fetch: fetchImpl, idToken }) {
    const response = await request(fetchImpl, SESSIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ idToken })
    });
    if (!response.ok) {
        throw new JagexError('Jagex game session could not be created (HTTP ' + response.status + ')');
    }
    const body = response.body;
    if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
        throw new JagexError('Jagex returned no game session');
    }
    return body.sessionId;
}

async function fetchCharacters({ fetch: fetchImpl, sessionId }) {
    const response = await request(fetchImpl, ACCOUNTS_URL, {
        headers: { Authorization: 'Bearer ' + sessionId, Accept: 'application/json' }
    });
    if (!response.ok) {
        throw new JagexError('Jagex accounts request failed (HTTP ' + response.status + ')');
    }
    const body = response.body;
    if (!Array.isArray(body)) {
        throw new JagexError('Jagex accounts response was not a list');
    }
    return body.filter((item) => item && typeof item === 'object' && (typeof item.accountId === 'string' || typeof item.accountId === 'number'));
}

module.exports = {
    AUTH_URL,
    TOKEN_URL,
    LAUNCHER_CLIENT_ID,
    LAUNCHER_REDIRECT,
    GAME_CLIENT_ID,
    GAME_REDIRECT,
    SESSIONS_URL,
    ACCOUNTS_URL,
    JagexError,
    base64url,
    randomAlphanumeric,
    createPkce,
    buildLoginUrl,
    buildConsentUrl,
    classifyNavigation,
    exchangeCode,
    createGameSession,
    fetchCharacters
};
