'use strict';

const { request, withUserAgent, createAppFetch } = require('../src/main/http');
const { resolveCurrentVersion } = require('../src/main/client-versions');
const { createHiscoresService } = require('../src/main/hiscores-service');
const { makeFetch, makeLog, makeTempDir, cleanupTempDirs } = require('./helpers');

afterEach(cleanupTempDirs);

// Sends headers straight away, then never sends the body (until the request is aborted).
function stallingResponse(options, status = 200) {
    const stream = new ReadableStream({
        start(controller) {
            options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
        }
    });
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
}

describe('request', () => {
    test('reads JSON, text or nothing', async () => {
        const fetch = makeFetch(() => new Response('{"a":1}', { status: 201 }));
        await expect(request(fetch, 'https://x.test/a')).resolves.toMatchObject({ status: 201, ok: true, body: { a: 1 } });
        await expect(request(fetch, 'https://x.test/a', {}, { read: 'text' })).resolves.toMatchObject({ body: '{"a":1}' });
        await expect(request(fetch, 'https://x.test/a', {}, { read: 'none' })).resolves.toMatchObject({ body: null });
    });

    test('an unparsable JSON body is null, not an error', async () => {
        const fetch = makeFetch(() => new Response('<html>', { status: 502 }));
        await expect(request(fetch, 'https://x.test/a')).resolves.toMatchObject({ status: 502, ok: false, body: null });
    });

    test('the timeout covers the body: headers then silence ends in a timeout', async () => {
        const fetch = makeFetch((url, options) => stallingResponse(options));
        const started = Date.now();
        await expect(request(fetch, 'https://x.test/slow', {}, { timeoutMs: 50 })).rejects.toThrow('Request timed out');
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('the timeout covers waiting for headers too', async () => {
        const fetch = makeFetch((url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }));
        await expect(request(fetch, 'https://x.test/slow', {}, { timeoutMs: 30 })).rejects.toThrow('Request timed out');
    });

    test('a stalled client-version lookup falls back instead of hanging', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
        try {
            const fetch = makeFetch((url, options) => stallingResponse(options));
            const pending = resolveCurrentVersion({ env: {}, fetch, siteUrl: 'https://xclient.dev', dir: makeTempDir(), log: makeLog() });
            await jest.advanceTimersByTimeAsync(16000);
            await expect(pending).resolves.toEqual({ ok: false, error: 'Could not determine the client version.' });
        } finally {
            jest.useRealTimers();
        }
    });

    test('a stalled hiscores page does not hold up the queue', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
        try {
            let calls = 0;
            const fetch = makeFetch((url, options) => {
                calls++;
                return calls === 1 ? stallingResponse(options) : new Response('', { status: 404 });
            });
            const service = createHiscoresService({ fetch, log: makeLog(), sleep: async () => {} });
            const first = service.lookup('Alpha', false);
            const second = service.lookup('Bravo', false);
            await jest.advanceTimersByTimeAsync(11000);
            await expect(first).resolves.toMatchObject({ status: 'error' });
            await expect(second).resolves.toMatchObject({ status: 'not-found' });
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('User-Agent', () => {
    test('added only where it applies, and never replaces one already set', async () => {
        const inner = makeFetch(() => new Response('ok'));
        const fetch = withUserAgent(inner, 'ProjectXLauncher/2.0.0', (url) => url.startsWith('https://xclient.dev/'));
        await fetch('https://xclient.dev/api/v1/me', { headers: { Authorization: 'Bearer x' } });
        await fetch('https://auth.jagex.com/game-session/v1/accounts', { headers: { Accept: 'application/json' } });
        await fetch('https://xclient.dev/api/v1/client/latest', { headers: { 'User-Agent': 'Custom' } });
        const [site, jagex, custom] = inner.calls;
        expect(site.options.headers.get('User-Agent')).toBe('ProjectXLauncher/2.0.0');
        expect(site.options.headers.get('Authorization')).toBe('Bearer x');
        expect(jagex.options.headers).toEqual({ Accept: 'application/json' });
        expect(custom.options.headers.get('User-Agent')).toBe('Custom');
    });

    test('inside Electron requests go through net.fetch without cookies or the HTTP cache', async () => {
        const net = { fetch: jest.fn(async () => new Response('ok')) };
        const fetch = createAppFetch({ net, userAgent: 'ProjectXLauncher/2.0.0', isOwnUrl: (url) => url.startsWith('https://xclient.dev/') });
        await fetch('https://xclient.dev/api/v1/client/latest', { headers: { Accept: 'application/json' } });
        await fetch('https://auth.jagex.com/game-session/v1/accounts', { method: 'GET' });
        const [own, jagex] = net.fetch.mock.calls;
        expect(own[1]).toMatchObject({ cache: 'no-store', credentials: 'omit' });
        expect(own[1].headers.get('User-Agent')).toBe('ProjectXLauncher/2.0.0');
        expect(jagex[1]).toEqual({ cache: 'no-store', credentials: 'omit', method: 'GET' });
    });

    test('outside Electron the global fetch is used', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = jest.fn(async () => new Response('ok'));
        try {
            const fetch = createAppFetch({ net: undefined, userAgent: 'UA', isOwnUrl: () => false });
            await fetch('https://example.test/');
            expect(globalThis.fetch).toHaveBeenCalledWith('https://example.test/', {});
        } finally {
            globalThis.fetch = original;
        }
    });

    test('the hiscores request carries the configured agent', async () => {
        const fetch = makeFetch(() => new Response('', { status: 404 }));
        const service = createHiscoresService({ fetch, log: makeLog(), userAgent: 'ProjectXLauncher/2.0.0', sleep: async () => {} });
        await service.lookup('Alpha', false);
        expect(fetch.calls[0].options.headers['User-Agent']).toBe('ProjectXLauncher/2.0.0');
    });
});
