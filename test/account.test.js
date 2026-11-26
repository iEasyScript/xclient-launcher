'use strict';

const fs = require('fs');
const path = require('path');
const { createAccountService, EXPIRED_MESSAGE, PAIRING_DEADLINE_MS, pollIntervalMs } = require('../src/main/account');
const { resolveSiteUrl, isSiteUrl } = require('../src/main/site');
const { makeTempDir, cleanupTempDirs, makeLog, makeFetch, jsonResponse, networkError, readJsonFile, writeJsonFile, flush } = require('./helpers');

const SITE = 'https://xclient.dev';
const TOKEN = 'px_FAKE_test_token_value_0000';
const DEVICE = 'device-code-fake-secret-value';

afterEach(cleanupTempDirs);

function setup({ fetch, now, sleep, openExternal } = {}) {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, 'projectx-session.json');
    const log = makeLog();
    const events = [];
    const opened = [];
    const copied = [];
    let clock = 1763215200000;
    const service = createAccountService({
        sessionFile,
        siteUrl: SITE,
        fetch,
        openExternal: openExternal || (async (url) => opened.push(url)),
        copyText: (text) => copied.push(text),
        notify: (payload) => events.push(payload),
        log,
        hostname: 'DESKTOP-TEST',
        platform: 'win32',
        now: now || (() => clock),
        sleep: sleep || (async (ms) => {
            clock += ms;
        })
    });
    return { service, sessionFile, log, events, opened, copied, advance: (ms) => { clock += ms; } };
}

function startResponse(extra = {}) {
    return jsonResponse(200, {
        userCode: 'BCDF-2345',
        deviceCode: DEVICE,
        verificationUrl: 'https://xclient.dev/pair',
        verificationUrlComplete: 'https://xclient.dev/pair?code=BCDF-2345',
        expiresAt: '2026-11-15T15:10:00.000Z',
        pollSeconds: 3,
        ...extra
    });
}

async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) {
            return;
        }
        await flush();
    }
    throw new Error('condition not met');
}

describe('session check', () => {
    test('no session file means signed out, with the site URL', async () => {
        const { service } = setup({ fetch: makeFetch(() => jsonResponse(200, {})) });
        await expect(service.getSession()).resolves.toEqual({ signedIn: false, siteUrl: SITE });
    });

    test('a 200 from /me refreshes and persists the user', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { id: 'u1', name: 'irondev', role: 'DEVELOPER', balance: 5 }));
        const { service, sessionFile } = setup({ fetch });
        writeJsonFile(sessionFile, { token: TOKEN, user: { id: 'u1', name: 'irondev', role: 'USER' }, createdAt: 1 });
        const result = await service.getSession();
        expect(result).toMatchObject({ signedIn: true, stale: false, user: { role: 'DEVELOPER' } });
        expect(fetch.calls[0].url).toBe('https://xclient.dev/api/v1/me');
        expect(fetch.calls[0].options.headers.Authorization).toBe('Bearer ' + TOKEN);
        const saved = readJsonFile(sessionFile);
        expect(saved).toMatchObject({ token: TOKEN, createdAt: 1, user: { role: 'DEVELOPER', balance: 5 } });
        expect(typeof saved.refreshedAt).toBe('number');
        if (process.platform !== 'win32') {
            expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
        }
    });

    test.each([401, 403])('a %i deletes the file and asks to sign in again', async (status) => {
        const { service, sessionFile } = setup({ fetch: makeFetch(() => jsonResponse(status, { error: 'invalid_token' })) });
        writeJsonFile(sessionFile, { token: TOKEN, user: null });
        await expect(service.getSession()).resolves.toEqual({ signedIn: false, message: EXPIRED_MESSAGE, siteUrl: SITE });
        expect(fs.existsSync(sessionFile)).toBe(false);
    });

    test('a network failure keeps the session (stale) and the token', async () => {
        const { service, sessionFile, log } = setup({ fetch: makeFetch(() => { throw networkError(); }) });
        writeJsonFile(sessionFile, { token: TOKEN, user: { name: 'irondev' } });
        await expect(service.getSession()).resolves.toMatchObject({ signedIn: true, stale: true, user: { name: 'irondev' } });
        expect(service.readToken()).toBe(TOKEN);
        expect(log.all()).not.toContain(TOKEN);
    });

    test('a 500 is treated like being offline', async () => {
        const { service, sessionFile } = setup({ fetch: makeFetch(() => jsonResponse(500, {})) });
        writeJsonFile(sessionFile, { token: TOKEN, user: null });
        await expect(service.getSession()).resolves.toMatchObject({ signedIn: true, stale: true });
    });

    test('a corrupt session file means no token and no crash', async () => {
        const { service, sessionFile } = setup({ fetch: makeFetch(() => jsonResponse(200, {})) });
        fs.writeFileSync(sessionFile, '{not json');
        expect(service.readToken()).toBeNull();
        await expect(service.getSession()).resolves.toMatchObject({ signedIn: false });
        writeJsonFile(sessionFile, { token: 42 });
        expect(service.readToken()).toBeNull();
    });
});

describe('pairing', () => {
    test('start returns the code and opens the browser at the approval page', async () => {
        const fetch = makeFetch((url) => (url.endsWith('/pair/start') ? startResponse() : jsonResponse(202, { status: 'pending' })));
        const { service, opened } = setup({ fetch, sleep: () => new Promise(() => {}) });
        const result = await service.startPairing();
        expect(result).toEqual({
            ok: true,
            userCode: 'BCDF-2345',
            verificationUrl: 'https://xclient.dev/pair?code=BCDF-2345',
            expiresAt: '2026-11-15T15:10:00.000Z'
        });
        expect(JSON.stringify(result)).not.toContain(DEVICE);
        expect(JSON.parse(fetch.calls[0].options.body)).toEqual({ label: 'DESKTOP-TEST (win32)' });
        await flush();
        expect(opened).toEqual(['https://xclient.dev/pair?code=BCDF-2345']);
    });

    test('an approval URL on another site is never opened', async () => {
        const fetch = makeFetch(() => startResponse({ verificationUrlComplete: 'https://evil.example/pair' }));
        const { service, opened } = setup({ fetch, sleep: () => new Promise(() => {}) });
        const result = await service.startPairing();
        await flush();
        expect(result.ok).toBe(true);
        expect(opened).toEqual([]);
        expect(service.reopenPairingPage()).toBe(false);
    });

    test('a browser that cannot be opened keeps waiting and offers the link', async () => {
        const fetch = makeFetch((url) => (url.endsWith('/pair/start') ? startResponse() : jsonResponse(202, { status: 'pending' })));
        const openExternal = async () => {
            throw new Error('Failed to open: Application not found (0x800401F5)');
        };
        const { service, events, copied } = setup({ fetch, openExternal, sleep: () => new Promise(() => {}) });
        const result = await service.startPairing();
        expect(result.ok).toBe(true);
        await waitFor(() => events.length > 0);
        expect(events).toEqual([{ type: 'open-failed', url: 'https://xclient.dev/pair?code=BCDF-2345' }]);
        expect(service.copyPairingLink()).toBe(true);
        expect(copied).toEqual(['https://xclient.dev/pair?code=BCDF-2345']);
        service.cancelPairing();
        expect(service.copyPairingLink()).toBe(false);
    });

    test('a refusal surfaces the server message', async () => {
        const { service } = setup({ fetch: makeFetch(() => jsonResponse(400, { message: 'Bad label' })) });
        await expect(service.startPairing()).resolves.toEqual({ ok: false, error: 'Bad label' });
    });

    test('a refusal without a message names the status', async () => {
        const { service } = setup({ fetch: makeFetch(() => jsonResponse(503, {})) });
        const result = await service.startPairing();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('503');
    });

    test('a 200 without a device code is a failure', async () => {
        const { service } = setup({ fetch: makeFetch(() => jsonResponse(200, { userCode: 'X' })) });
        await expect(service.startPairing()).resolves.toMatchObject({ ok: false });
    });

    test('a network failure gives the could-not-reach error', async () => {
        const { service } = setup({ fetch: makeFetch(() => { throw networkError(); }) });
        const result = await service.startPairing();
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/could not reach the Project X site/i);
    });

    test('one pending then approval stores the token and pushes signed-in once, with no polls after', async () => {
        let polls = 0;
        const fetch = makeFetch((url) => {
            if (url.endsWith('/pair/start')) {
                return startResponse();
            }
            polls++;
            return polls === 1
                ? jsonResponse(202, { status: 'pending', pollSeconds: 3 })
                : jsonResponse(200, { status: 'approved', token: TOKEN, user: { id: 'u1', name: 'irondev', role: 'USER' } });
        });
        const { service, events, sessionFile, log } = setup({ fetch });
        await service.startPairing();
        await waitFor(() => events.length > 0);
        await flush();
        await flush();
        expect(events).toEqual([{ type: 'signed-in', user: { id: 'u1', name: 'irondev', role: 'USER' } }]);
        expect(polls).toBe(2);
        expect(JSON.parse(fetch.calls[1].options.body)).toEqual({ deviceCode: DEVICE });
        const saved = readJsonFile(sessionFile);
        expect(saved).toMatchObject({ token: TOKEN, user: { name: 'irondev' } });
        expect(typeof saved.createdAt).toBe('number');
        expect(service.readToken()).toBe(TOKEN);
        expect(log.all()).not.toContain(TOKEN);
        expect(log.all()).not.toContain(DEVICE);
    });

    test('a 410 pushes the server message and stores nothing', async () => {
        const fetch = makeFetch((url) => (url.endsWith('/pair/start') ? startResponse() : jsonResponse(410, { error: 'expired', message: 'This code expired.' })));
        const { service, events, sessionFile } = setup({ fetch });
        await service.startPairing();
        await waitFor(() => events.length > 0);
        expect(events).toEqual([{ type: 'failed', message: 'This code expired.' }]);
        expect(fs.existsSync(sessionFile)).toBe(false);
    });

    test('the ten-minute deadline pushes a timeout', async () => {
        const fetch = makeFetch((url) => (url.endsWith('/pair/start') ? startResponse({ pollSeconds: 60 }) : jsonResponse(202, { status: 'pending' })));
        const { service, events } = setup({ fetch });
        await service.startPairing();
        await waitFor(() => events.length > 0);
        expect(events[0].type).toBe('failed');
        expect(events[0].message).toMatch(/timed out/);
        const polls = fetch.calls.filter((call) => call.url.endsWith('/pair/poll')).length;
        expect(polls).toBe(PAIRING_DEADLINE_MS / 60000 - 1);
    });

    test('network errors keep polling', async () => {
        let polls = 0;
        const fetch = makeFetch((url) => {
            if (url.endsWith('/pair/start')) {
                return startResponse();
            }
            polls++;
            if (polls < 3) {
                throw networkError();
            }
            return jsonResponse(200, { status: 'approved', token: TOKEN, user: null });
        });
        const { service, events } = setup({ fetch });
        await service.startPairing();
        await waitFor(() => events.length > 0);
        expect(events).toEqual([{ type: 'signed-in', user: null }]);
        expect(polls).toBe(3);
    });

    test('cancel stops polling silently', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetch = makeFetch((url) => (url.endsWith('/pair/start') ? startResponse() : jsonResponse(200, { token: TOKEN })));
        const { service, events } = setup({ fetch, sleep: () => gate });
        await service.startPairing();
        service.cancelPairing();
        release();
        await flush();
        await flush();
        expect(events).toEqual([]);
        expect(fetch.calls.filter((call) => call.url.endsWith('/pair/poll'))).toHaveLength(0);
    });

    test('poll interval is at least a second, three when missing', () => {
        expect(pollIntervalMs(3)).toBe(3000);
        expect(pollIntervalMs(0)).toBe(1000);
        expect(pollIntervalMs('5')).toBe(3000);
        expect(pollIntervalMs(undefined)).toBe(3000);
    });

    test('sign out removes the token and cancels a pending pairing', async () => {
        const { service, sessionFile } = setup({ fetch: makeFetch(() => jsonResponse(200, {})) });
        writeJsonFile(sessionFile, { token: TOKEN });
        service.signOut();
        expect(fs.existsSync(sessionFile)).toBe(false);
        expect(service.readToken()).toBeNull();
        expect(() => service.signOut()).not.toThrow();
    });
});

describe('site URL', () => {
    test('PROJECTX_SITE_URL is honoured and trailing slashes are stripped', () => {
        expect(resolveSiteUrl({})).toBe('https://xclient.dev');
        expect(resolveSiteUrl({ PROJECTX_SITE_URL: 'https://staging.example.test///' })).toBe('https://staging.example.test');
        expect(resolveSiteUrl({ PROJECTX_SITE_URL: '  ' })).toBe('https://xclient.dev');
        expect(resolveSiteUrl({ PROJECTX_SITE_URL: 'javascript:alert(1)' })).toBe('https://xclient.dev');
    });

    test('the account calls go to the configured site', async () => {
        const fetch = makeFetch(() => jsonResponse(200, {}));
        const dir = makeTempDir();
        const service = createAccountService({
            sessionFile: path.join(dir, 's.json'),
            siteUrl: resolveSiteUrl({ PROJECTX_SITE_URL: 'http://localhost:3000/' }),
            fetch,
            openExternal: async () => {},
            notify: () => {},
            log: makeLog()
        });
        await service.startPairing();
        expect(fetch.calls[0].url).toBe('http://localhost:3000/api/v1/pair/start');
    });

    test('only https links on the site, or http on a local dev site, may be opened', () => {
        expect(isSiteUrl('https://xclient.dev/pair?code=X', 'https://xclient.dev')).toBe(true);
        expect(isSiteUrl('http://xclient.dev/pair', 'https://xclient.dev')).toBe(false);
        expect(isSiteUrl('https://xclient.dev.evil.example/pair', 'https://xclient.dev')).toBe(false);
        expect(isSiteUrl('file:///etc/passwd', 'https://xclient.dev')).toBe(false);
        expect(isSiteUrl('http://localhost:3000/pair', 'http://localhost:3000')).toBe(true);
        expect(isSiteUrl('not a url', 'https://xclient.dev')).toBe(false);
    });
});
