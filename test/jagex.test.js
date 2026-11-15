'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { mergeCharacters, forDisplay, createAccountsStore, deepEqual } = require('../src/main/jagex/accounts');
const oauth = require('../src/main/jagex/oauth');
const { runJagexLogin, MESSAGES, COMPLETE_PAGE } = require('../src/main/jagex/login');
const { pickBrowser, NO_BROWSER_MESSAGE } = require('../src/main/jagex/browser');
const { makeTempDir, cleanupTempDirs, makeLog, makeFetch, jsonResponse, readJsonFile, writeJsonFile, flush } = require('./helpers');

afterEach(cleanupTempDirs);

const NOW = '2026-11-15T12:00:00.000Z';

describe('merging characters', () => {
    const saved = () => [
        { accountId: '111', displayName: 'Old Name', userHash: 'h1', membership: { tier: 1 }, sessionId: 'sess-a', createdOn: '2026-01-01T00:00:00.000Z', profile: 'Alt' },
        { accountId: '222', displayName: 'Other Login', sessionId: 'sess-b', createdOn: '2026-01-02T00:00:00.000Z' }
    ];

    test('a renamed character takes the new name and keeps profile and createdOn', () => {
        const result = mergeCharacters(saved(), [{ accountId: '111', displayName: 'New Name', userHash: 'h1', membership: { tier: 1 } }], 'sess-a', NOW);
        expect(result.updated).toBe(1);
        expect(result.added).toBe(0);
        expect(result.list[0]).toEqual({ accountId: '111', displayName: 'New Name', userHash: 'h1', membership: { tier: 1 }, sessionId: 'sess-a', createdOn: '2026-01-01T00:00:00.000Z', profile: 'Alt' });
    });

    test('characters from another session are untouched (same object)', () => {
        const existing = saved();
        const result = mergeCharacters(existing, [{ accountId: '111', displayName: 'New Name' }], 'sess-a', NOW);
        expect(result.list[1]).toBe(existing[1]);
    });

    test('a new character is appended with sessionId and createdOn', () => {
        const result = mergeCharacters(saved(), [{ accountId: '333', displayName: 'Fresh', rs3GameMode: 'x' }], 'sess-c', NOW);
        expect(result.added).toBe(1);
        expect(result.list[2]).toEqual({ accountId: '333', displayName: 'Fresh', rs3GameMode: 'x', sessionId: 'sess-c', createdOn: NOW });
    });

    test('nothing changed reports nothing to write, including object-valued fields', () => {
        const result = mergeCharacters(saved(), [{ accountId: '111', displayName: 'Old Name', userHash: 'h1', membership: { tier: 1 } }], 'sess-a', NOW);
        expect(result).toMatchObject({ added: 0, updated: 0 });
        const arrays = mergeCharacters([{ accountId: '1', membership: [{ a: 1, b: 2 }], sessionId: 's' }], [{ accountId: '1', membership: [{ b: 2, a: 1 }] }], 's', NOW);
        expect(arrays.updated).toBe(0);
    });

    test('signing in again moves a character to the new session', () => {
        const result = mergeCharacters(saved(), [{ accountId: '222', displayName: 'Other Login' }], 'sess-new', NOW);
        expect(result.updated).toBe(1);
        expect(result.list[1].sessionId).toBe('sess-new');
    });

    test('deep equality', () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(deepEqual([], {})).toBe(false);
    });
});

describe('display list', () => {
    test('newest first, missing names reported as null, never a session id', () => {
        const list = forDisplay([
            { accountId: '1', displayName: 'Old', createdOn: '2026-01-01T00:00:00.000Z', sessionId: 'secret' },
            { accountId: '2', createdOn: '2026-03-01T00:00:00.000Z', sessionId: 'secret' },
            { accountId: '3', displayName: 'Mid', createdOn: '2026-02-01T00:00:00.000Z', profile: 'Alt', sessionId: 'secret' }
        ]);
        expect(list.map((item) => item.accountId)).toEqual(['2', '3', '1']);
        expect(list[0].displayName).toBeNull();
        expect(list[1]).toEqual({ accountId: '3', displayName: 'Mid', profile: 'Alt', createdOn: '2026-02-01T00:00:00.000Z' });
        expect(JSON.stringify(list)).not.toContain('secret');
    });

    test('characters sharing a display name are all kept; duplicate ids are not', () => {
        const list = forDisplay([
            { accountId: '1', displayName: 'Same', createdOn: '2026-01-01T00:00:00.000Z' },
            { accountId: '2', displayName: 'Same', createdOn: '2026-01-02T00:00:00.000Z' },
            { accountId: '2', displayName: 'Same', createdOn: '2026-01-01T00:00:00.000Z' }
        ]);
        expect(list.map((item) => item.accountId)).toEqual(['2', '1']);
    });
});

describe('accounts store', () => {
    function setup(handler) {
        const dir = makeTempDir();
        const file = path.join(dir, 'accounts.json');
        const log = makeLog();
        const fetch = makeFetch(handler || (() => jsonResponse(200, [])));
        const store = createAccountsStore({ file, fetch, log, now: () => new Date(NOW) });
        return { file, log, fetch, store };
    }

    test('fetch-and-merge writes only when something changed', async () => {
        const { file, store, fetch } = setup(() => jsonResponse(200, [{ accountId: '111', displayName: 'Iron Wick' }]));
        await expect(store.fetchAndMerge('sess-a')).resolves.toEqual({ ok: true, added: 1, updated: 0 });
        expect(fetch.calls[0].url).toBe('https://auth.jagex.com/game-session/v1/accounts');
        expect(fetch.calls[0].options.headers.Authorization).toBe('Bearer sess-a');
        const mtime = fs.statSync(file).mtimeMs;
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toContain('\n  {');
        await expect(store.fetchAndMerge('sess-a')).resolves.toEqual({ ok: true, added: 0, updated: 0 });
        expect(fs.statSync(file).mtimeMs).toBe(mtime);
        if (process.platform !== 'win32') {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
    });

    test('an unreadable accounts file is never written over', async () => {
        const { file, store } = setup(() => jsonResponse(200, [{ accountId: '111', displayName: 'Iron Wick' }]));
        fs.writeFileSync(file, '[{ broken');
        await expect(store.fetchAndMerge('sess-a')).resolves.toMatchObject({ ok: false });
        expect(fs.readFileSync(file, 'utf8')).toBe('[{ broken');
    });

    test('errors are logged with the status only, never the body', async () => {
        const { store, log } = setup(() => jsonResponse(401, { error: 'bad', echo: 'sess-a-secret' }));
        await expect(store.fetchAndMerge('sess-a-secret')).resolves.toMatchObject({ ok: false });
        expect(log.all()).toContain('HTTP 401');
        expect(log.all()).not.toContain('sess-a-secret');
    });

    test('refresh asks every distinct session once and returns the re-read list', async () => {
        const { file, store, fetch } = setup((url, options) => {
            const session = options.headers.Authorization.slice('Bearer '.length);
            return jsonResponse(200, session === 'sess-a' ? [{ accountId: '111', displayName: 'Renamed' }] : [{ accountId: '222', displayName: 'Two' }]);
        });
        writeJsonFile(file, [
            { accountId: '111', displayName: 'Old', sessionId: 'sess-a', createdOn: '2026-01-01T00:00:00.000Z' },
            { accountId: '112', displayName: 'Same Login', sessionId: 'sess-a', createdOn: '2026-01-01T00:00:00.000Z' },
            { accountId: '222', displayName: 'Two', sessionId: 'sess-b', createdOn: '2026-01-02T00:00:00.000Z' },
            { accountId: '333', displayName: 'No Session', createdOn: '2026-01-03T00:00:00.000Z' }
        ]);
        const result = await store.refreshAll();
        expect(fetch.calls).toHaveLength(2);
        expect(result.ok).toBe(true);
        expect(result.accounts.find((item) => item.accountId === '111').displayName).toBe('Renamed');
        expect(readJsonFile(file)).toHaveLength(4);
    });

    test('refresh errors', async () => {
        const { file, store } = setup(() => jsonResponse(401, {}));
        await expect(store.refreshAll()).resolves.toEqual({ ok: false, error: 'accounts.json does not exist' });
        fs.writeFileSync(file, 'nope');
        await expect(store.refreshAll()).resolves.toEqual({ ok: false, error: 'Failed to read accounts.json' });
        writeJsonFile(file, []);
        await expect(store.refreshAll()).resolves.toEqual({ ok: false, error: 'No accounts found to refresh' });
        writeJsonFile(file, [{ accountId: '1', displayName: 'x' }]);
        await expect(store.refreshAll()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no jagex session/i) });
        writeJsonFile(file, [{ accountId: '1', displayName: 'x', sessionId: 'dead' }]);
        await expect(store.refreshAll()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Add Accounts') });
    });

    test('delete one', () => {
        const { file, store } = setup();
        expect(store.deleteAccount('')).toEqual({ ok: false, error: 'Invalid account id' });
        expect(store.deleteAccount('111')).toEqual({ ok: false, error: 'Accounts file does not exist' });
        fs.writeFileSync(file, '{bad');
        expect(store.deleteAccount('111')).toEqual({ ok: false, error: 'Accounts file is corrupted or unreadable' });
        writeJsonFile(file, [{ accountId: '111', sessionId: 's' }, { accountId: '222', sessionId: 's' }]);
        expect(store.deleteAccount('999')).toEqual({ ok: false, error: 'Account not found' });
        expect(store.deleteAccount('111')).toEqual({ ok: true });
        expect(readJsonFile(file)).toEqual([{ accountId: '222', sessionId: 's' }]);
    });

    test('remove all deletes the file', () => {
        const { file, store } = setup();
        writeJsonFile(file, [{ accountId: '111' }]);
        expect(store.removeAll()).toEqual({ ok: true });
        expect(fs.existsSync(file)).toBe(false);
        expect(store.removeAll()).toEqual({ ok: true });
    });

    test('set profile and list for display', () => {
        const { file, store } = setup();
        writeJsonFile(file, [{ accountId: '111', displayName: 'A', sessionId: 's', createdOn: NOW }]);
        expect(store.setProfile('111', 'Alt')).toEqual({ ok: true });
        expect(store.setProfile('999', 'Alt')).toEqual({ ok: false, error: 'Account not found' });
        expect(store.listForDisplay()).toEqual({ ok: true, accounts: [{ accountId: '111', displayName: 'A', profile: 'Alt', createdOn: NOW }] });
        writeJsonFile(file, { not: 'a list' });
        expect(store.listForDisplay()).toMatchObject({ ok: false, error: expect.stringMatching(/unexpected format/) });
    });
});

describe('Jagex OAuth helpers', () => {
    test('fresh PKCE values every time, with a matching S256 challenge', () => {
        const a = oauth.createPkce();
        const b = oauth.createPkce();
        expect(a.verifier).not.toBe(b.verifier);
        expect(a.state).not.toBe(b.state);
        expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{60}$/);
        const expected = require('crypto').createHash('sha256').update(a.verifier).digest('base64url');
        expect(a.challenge).toBe(expected);
        expect(oauth.randomAlphanumeric(48)).toMatch(/^[A-Za-z0-9]{48}$/);
    });

    test('step-one URL has the parameters in order with + for spaces', () => {
        const url = oauth.buildLoginUrl({ challenge: 'CHAL', state: 'STATE1' });
        expect(url).toBe('https://account.jagex.com/oauth2/auth?auth_method=&login_type=&flow=launcher&response_type=code'
            + '&client_id=com_jagex_auth_desktop_launcher'
            + '&redirect_uri=https%3A%2F%2Fsecure.runescape.com%2Fm%3Dweblogin%2Flauncher-redirect'
            + '&code_challenge=CHAL&code_challenge_method=S256&prompt=login'
            + '&scope=openid+offline+gamesso.token.create+user.profile.read&state=STATE1');
    });

    test('step-two URL carries the id_token hint, nonce, same state and the second client id', () => {
        const url = oauth.buildConsentUrl({ idToken: 'IDT', nonce: 'N'.repeat(48), state: 'STATE1' });
        expect(url).toBe('https://account.jagex.com/oauth2/auth?id_token_hint=IDT&nonce=' + 'N'.repeat(48)
            + '&prompt=consent&redirect_uri=http%3A%2F%2Flocalhost&response_type=id_token+code&state=STATE1'
            + '&client_id=1fddee4e-b100-4f4e-b2b0-097f9088f9d2&scope=openid+offline');
    });

    test('navigation classification: id_token first, locale links ignored', () => {
        expect(oauth.classifyNavigation('http://localhost/#code=abc&id_token=IDT&state=S')).toEqual({ type: 'id_token', idToken: 'IDT', state: 'S' });
        expect(oauth.classifyNavigation('https://secure.runescape.com/m=weblogin/launcher-redirect?code=C1&state=S')).toEqual({ type: 'code', code: 'C1', state: 'S' });
        expect(oauth.classifyNavigation('https://account.jagex.com/en-GB/locale?code=fr')).toBeNull();
        expect(oauth.classifyNavigation('https://secure.runescape.com/m=weblogin/launcher-redirect/locale?code=fr')).toBeNull();
        expect(oauth.classifyNavigation('https://example.test/page?code=nope')).toBeNull();
        expect(oauth.classifyNavigation('https://account.jagex.com/login')).toBeNull();
    });

    test('token exchange posts the form and reads id_token', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { id_token: 'IDT' }));
        await expect(oauth.exchangeCode({ fetch, code: 'C1', verifier: 'V1' })).resolves.toBe('IDT');
        const body = new URLSearchParams(fetch.calls[0].options.body);
        expect(fetch.calls[0].url).toBe('https://account.jagex.com/oauth2/token');
        expect(Object.fromEntries(body)).toEqual({
            grant_type: 'authorization_code',
            client_id: 'com_jagex_auth_desktop_launcher',
            code: 'C1',
            code_verifier: 'V1',
            redirect_uri: 'https://secure.runescape.com/m=weblogin/launcher-redirect'
        });
    });

    test('game session posts the id token as JSON', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { sessionId: 'SID' }));
        await expect(oauth.createGameSession({ fetch, idToken: 'IDT' })).resolves.toBe('SID');
        expect(fetch.calls[0].url).toBe('https://auth.jagex.com/game-session/v1/sessions');
        expect(JSON.parse(fetch.calls[0].options.body)).toEqual({ idToken: 'IDT' });
        expect(fetch.calls[0].options.headers['Content-Type']).toBe('application/json');
    });

    test('browser choice prefers Chrome and ignores unsupported browsers', () => {
        expect(pickBrowser([{ browser: 'Firefox', executable: '/ff' }])).toBeNull();
        expect(pickBrowser([
            { browser: 'Brave Browser', executable: '/brave' },
            { browser: 'Google Chrome', executable: '/chrome' }
        ])).toEqual({ name: 'Google Chrome', executablePath: '/chrome' });
        expect(pickBrowser([{ browser: 'Opera', executable: '/opera' }, { browser: 'Safari', executable: '/s' }]).name).toBe('Opera');
        expect(pickBrowser([{ browser: 'Microsoft Edge', executable: 'C:\\Windows\\SystemApps\\Edge\\MicrosoftEdge.exe' }])).toBeNull();
        expect(pickBrowser([{ browser: 'Microsoft Edge', executable: 'C:\\Edge\\Application\\msedge.exe' }]).name).toBe('Microsoft Edge');
    });
});

describe('Jagex sign-in flow', () => {
    const SECRETS = ['CODE-SECRET-1', 'IDTOKEN-ONE', 'IDTOKEN-TWO', 'SESSION-SECRET'];

    function fakeBrowser() {
        const page = new EventEmitter();
        const mainFrame = { url: () => page.currentUrl };
        page.currentUrl = 'about:blank';
        page.gotos = [];
        page.routes = [];
        page.goto = jest.fn(async (url) => {
            page.gotos.push(url);
        });
        page.route = jest.fn(async (matcher, handler) => {
            page.routes.push({ matcher, handler });
        });
        page.navigate = (url) => {
            page.currentUrl = url;
            page.emit('framenavigated', mainFrame);
        };
        const browser = new EventEmitter();
        browser.close = jest.fn(async () => {});
        return { browser, page };
    }

    function setup({ fetchHandler, pkce, accountsResult } = {}) {
        const { browser, page } = fakeBrowser();
        const log = makeLog();
        const fetch = makeFetch(fetchHandler || ((url) => {
            if (url === oauth.TOKEN_URL) {
                return jsonResponse(200, { id_token: 'IDTOKEN-ONE' });
            }
            if (url === oauth.SESSIONS_URL) {
                return jsonResponse(200, { sessionId: 'SESSION-SECRET' });
            }
            return jsonResponse(404, {});
        }));
        const accounts = { fetchAndMerge: jest.fn(async () => accountsResult || { ok: true, added: 2, updated: 0 }) };
        const promise = runJagexLogin({
            findBrowser: async () => ({ name: 'Google Chrome', executablePath: '/chrome' }),
            launchBrowser: async () => ({ browser, page }),
            fetch,
            accounts,
            log,
            createPkce: () => pkce || { verifier: 'VERIFIER-SECRET', challenge: 'CHALLENGE', state: 'STATE123' }
        });
        return { promise, page, browser, log, fetch, accounts };
    }

    async function ready(page) {
        for (let i = 0; i < 50 && page.gotos.length === 0; i++) {
            await flush();
        }
    }

    test('completes the two-step exchange and merges the characters', async () => {
        const { promise, page, browser, log, fetch, accounts } = setup();
        await ready(page);
        expect(page.gotos[0]).toBe(oauth.buildLoginUrl({ challenge: 'CHALLENGE', state: 'STATE123' }));
        page.navigate('https://account.jagex.com/en-GB/locale?code=fr');
        page.navigate('https://secure.runescape.com/m=weblogin/launcher-redirect?code=CODE-SECRET-1&state=STATE123');
        for (let i = 0; i < 20 && page.gotos.length < 2; i++) {
            await flush();
        }
        const consent = new URL(page.gotos[1]);
        expect(consent.searchParams.get('id_token_hint')).toBe('IDTOKEN-ONE');
        expect(consent.searchParams.get('state')).toBe('STATE123');
        expect(consent.searchParams.get('client_id')).toBe('1fddee4e-b100-4f4e-b2b0-097f9088f9d2');
        expect(consent.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9]{48}$/);
        page.navigate('http://localhost/#code=ignored&id_token=IDTOKEN-TWO&state=STATE123');
        await expect(promise).resolves.toEqual({ ok: true, added: 2, updated: 0 });
        expect(accounts.fetchAndMerge).toHaveBeenCalledWith('SESSION-SECRET');
        expect(JSON.parse(fetch.calls[1].options.body)).toEqual({ idToken: 'IDTOKEN-TWO' });
        expect(browser.close).toHaveBeenCalled();
        const logged = log.all();
        for (const secret of [...SECRETS, 'VERIFIER-SECRET']) {
            expect(logged).not.toContain(secret);
        }
    });

    test('localhost requests are answered with the completion page', async () => {
        const { page, browser } = setup();
        await ready(page);
        const { matcher, handler } = page.routes[0];
        expect(matcher(new URL('http://localhost/'))).toBe(true);
        expect(matcher(new URL('https://account.jagex.com/'))).toBe(false);
        const route = { fulfill: jest.fn() };
        handler(route);
        expect(route.fulfill).toHaveBeenCalledWith({ status: 200, contentType: 'text/html', body: COMPLETE_PAGE });
        expect(COMPLETE_PAGE).toContain('Authentication Complete');
        browser.emit('disconnected');
    });

    test('a state mismatch fails', async () => {
        const { promise, page, fetch } = setup();
        await ready(page);
        page.navigate('https://secure.runescape.com/m=weblogin/launcher-redirect?code=CODE-SECRET-1&state=WRONG');
        await expect(promise).resolves.toEqual({ ok: false, error: MESSAGES.state });
        expect(fetch.calls).toHaveLength(0);
    });

    test('closing the page fails with the right message', async () => {
        const { promise, page } = setup();
        await ready(page);
        page.emit('close');
        await expect(promise).resolves.toEqual({ ok: false, error: 'The browser was closed before authentication completed.' });
    });

    test('a failed token exchange is reported and the browser closed', async () => {
        const { promise, page, browser, log } = setup({ fetchHandler: () => jsonResponse(400, { error: 'invalid_grant', code: 'CODE-SECRET-1' }) });
        await ready(page);
        page.navigate('https://secure.runescape.com/m=weblogin/launcher-redirect?code=CODE-SECRET-1&state=STATE123');
        const result = await promise;
        expect(result.ok).toBe(false);
        expect(browser.close).toHaveBeenCalled();
        expect(log.all()).toContain('HTTP 400');
        expect(log.all()).not.toContain('CODE-SECRET-1');
    });

    test('a failed session or account fetch is reported', async () => {
        const failing = setup({ fetchHandler: (url) => (url === oauth.SESSIONS_URL ? jsonResponse(500, {}) : jsonResponse(200, {})) });
        await ready(failing.page);
        failing.page.navigate('http://localhost/#id_token=IDTOKEN-TWO');
        await expect(failing.promise).resolves.toMatchObject({ ok: false });

        const noAccounts = setup({ accountsResult: { ok: false, error: 'Jagex did not return the accounts for this sign-in.' } });
        await ready(noAccounts.page);
        noAccounts.page.navigate('http://localhost/#id_token=IDTOKEN-TWO');
        await expect(noAccounts.promise).resolves.toEqual({ ok: false, error: 'Jagex did not return the accounts for this sign-in.' });
    });

    test('no supported browser', async () => {
        const result = await runJagexLogin({
            findBrowser: async () => null,
            launchBrowser: jest.fn(),
            fetch: jest.fn(),
            accounts: {},
            log: makeLog()
        });
        expect(result).toEqual({ ok: false, error: NO_BROWSER_MESSAGE });
    });

    test('the whole flow times out and closes the browser', async () => {
        const { browser, page } = fakeBrowser();
        const result = await runJagexLogin({
            findBrowser: async () => ({ name: 'Chromium', executablePath: '/c' }),
            launchBrowser: async () => ({ browser, page }),
            fetch: jest.fn(),
            accounts: {},
            log: makeLog(),
            timeoutMs: 20
        });
        expect(result).toEqual({ ok: false, error: MESSAGES.timeout });
        expect(browser.close).toHaveBeenCalled();
    });
});
