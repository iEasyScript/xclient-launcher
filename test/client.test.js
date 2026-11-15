'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    compareVersions,
    listInstalledJars,
    resolveCurrentVersion,
    isVersionString
} = require('../src/main/client-versions');
const { downloadClient, pruneOlderJars, clientJarUrl } = require('../src/main/client-download');
const { createClientService } = require('../src/main/client-service');
const { createSettingsStore } = require('../src/main/settings');
const { createPaths } = require('../src/main/paths');
const { makeTempDir, cleanupTempDirs, makeLog, makeFetch, jsonResponse, networkError, readJsonFile, writeJsonFile } = require('./helpers');

const SITE = 'https://xclient.dev';
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

afterEach(cleanupTempDirs);

function touch(dir, ...names) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
        fs.writeFileSync(path.join(dir, name), 'x');
    }
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function jarResponse(bytes, { checksum, length = true } = {}) {
    const headers = { 'content-type': 'application/java-archive' };
    if (length) {
        headers['content-length'] = String(bytes.length);
    }
    if (checksum) {
        headers['x-checksum-sha256'] = checksum;
    }
    return new Response(bytes, { status: 200, headers });
}

describe('version helpers', () => {
    test('numeric comparison with missing parts as zero', () => {
        expect(compareVersions('1.0.9', '1.0.43')).toBe(-1);
        expect(compareVersions('2.6.22', '2.6.9')).toBe(1);
        expect(compareVersions('2.0', '2.0.0')).toBe(0);
    });

    test('installed list is newest first and needs a digit', () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-1.0.9.jar', 'projectx-1.0.43.jar', 'projectx-2.0.0.jar', 'projectx-.jar', 'other.jar', 'projectx-notes.txt');
        expect(listInstalledJars(dir)).toEqual(['projectx-2.0.0.jar', 'projectx-1.0.43.jar', 'projectx-1.0.9.jar']);
    });

    test('safe version strings only', () => {
        expect(isVersionString('2.0.0')).toBe(true);
        expect(isVersionString('1.2.3-dev')).toBe(true);
        expect(isVersionString('../evil')).toBe(false);
        expect(isVersionString('..')).toBe(false);
        expect(isVersionString('')).toBe(false);
        expect(isVersionString(3)).toBe(false);
    });
});

describe('client version resolution', () => {
    test('uses the site answer with exactly one request and strips a leading v', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { tag_name: 'v2.0.0', version: '2.0.0' }));
        const result = await resolveCurrentVersion({ env: {}, fetch, siteUrl: SITE, dir: makeTempDir(), log: makeLog() });
        expect(result).toEqual({ ok: true, version: '2.0.0', source: 'site' });
        expect(fetch.calls).toHaveLength(1);
        expect(fetch.calls[0].url).toBe('https://xclient.dev/api/v1/client/latest');
    });

    test('uses the published release even when a higher version is installed', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-2.6.22.jar');
        const fetch = makeFetch(() => jsonResponse(200, { tag_name: '1.0.110' }));
        const result = await resolveCurrentVersion({ env: {}, fetch, siteUrl: SITE, dir, log: makeLog() });
        expect(result.version).toBe('1.0.110');
    });

    test('falls back to the newest numeric installed jar when the site fails', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-2.6.9.jar', 'projectx-2.6.22.jar', 'projectx-launcher-9.0.0.jar', 'projectx-1.2.3-dev.jar');
        const log = makeLog();
        const fetch = makeFetch(() => {
            throw networkError();
        });
        const result = await resolveCurrentVersion({ env: {}, fetch, siteUrl: SITE, dir, log });
        expect(result).toEqual({ ok: true, version: '2.6.22', source: 'local' });
        expect(log.all()).toContain('https://xclient.dev/api/v1/client/latest');
    });

    test('a 404 or an empty answer counts as a failure', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-1.0.0.jar');
        for (const response of [jsonResponse(404, { error: 'not_found' }), jsonResponse(200, { tag_name: '' })]) {
            const result = await resolveCurrentVersion({ env: {}, fetch: makeFetch(() => response), siteUrl: SITE, dir, log: makeLog() });
            expect(result.source).toBe('local');
        }
    });

    test('reports an error when there is neither a release nor a local jar', async () => {
        const fetch = makeFetch(() => jsonResponse(500, {}));
        const result = await resolveCurrentVersion({ env: {}, fetch, siteUrl: SITE, dir: makeTempDir(), log: makeLog() });
        expect(result).toEqual({ ok: false, error: 'Could not determine the client version.' });
    });

    test('PROJECTX_CLIENT_VERSION wins with no network call, including non-numeric pins', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { tag_name: '2.0.0' }));
        const result = await resolveCurrentVersion({ env: { PROJECTX_CLIENT_VERSION: ' 1.2.3-dev ' }, fetch, siteUrl: SITE, dir: makeTempDir(), log: makeLog() });
        expect(result).toEqual({ ok: true, version: '1.2.3-dev', source: 'pin' });
        expect(fetch.calls).toHaveLength(0);
    });

    test('honours a different site URL', async () => {
        const fetch = makeFetch(() => jsonResponse(200, { tag_name: '3.0.0' }));
        await resolveCurrentVersion({ env: {}, fetch, siteUrl: 'http://localhost:3000', dir: makeTempDir(), log: makeLog() });
        expect(fetch.calls[0].url).toBe('http://localhost:3000/api/v1/client/latest');
    });
});

describe('client download', () => {
    const bytes = Buffer.concat([ZIP, Buffer.from('pretend this is a jar file '.repeat(5000))]);

    test('downloads from the site URL, verifies the checksum, and reports monotonic progress ending at 100', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => jarResponse(bytes, { checksum: sha256(bytes).toUpperCase() }));
        const progress = [];
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch, onProgress: (p) => progress.push(p) });
        expect(result).toEqual({ ok: true, path: path.join(dir, 'projectx-2.0.0.jar') });
        expect(fetch.calls[0].url).toBe('https://xclient.dev/api/v1/client/releases/2.0.0/projectx-2.0.0.jar');
        expect(fs.readFileSync(result.path)).toEqual(bytes);
        const percents = progress.map((p) => p.percent);
        expect(percents).toEqual([...percents].sort((a, b) => a - b));
        expect(percents[0]).toBeLessThanOrEqual(10);
        expect(progress[progress.length - 1]).toEqual({ percent: 100, status: 'Completed!' });
        expect(progress.some((p) => /^Downloading client 2\.0\.0\.\.\. \(\d+\.\d{2}%\)$/.test(p.status))).toBe(true);
        expect(fs.readdirSync(dir)).toEqual(['projectx-2.0.0.jar']);
    });

    test('without a content length reports megabytes at 50%', async () => {
        const fetch = makeFetch(() => jarResponse(bytes, { length: false }));
        const progress = [];
        await downloadClient('2.0.0', { dir: makeTempDir(), siteUrl: SITE, env: {}, log: makeLog(), fetch, onProgress: (p) => progress.push(p) });
        expect(progress.some((p) => p.percent === 50 && /\(\d+\.\dMB\)$/.test(p.status))).toBe(true);
    });

    test('a checksum mismatch keeps nothing and reports both hashes', async () => {
        const dir = makeTempDir();
        const wrong = 'a'.repeat(64);
        const fetch = makeFetch(() => jarResponse(bytes, { checksum: wrong }));
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result.ok).toBe(false);
        expect(result.error).toContain(wrong);
        expect(result.error).toContain(sha256(bytes));
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('a failed download reports an error and leaves no file', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => jsonResponse(404, { error: 'not_found' }));
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result).toEqual({ ok: false, error: 'HTTP 404' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('only the site is used for the client', async () => {
        const fetch = makeFetch(() => {
            throw networkError();
        });
        await downloadClient('2.0.0', { dir: makeTempDir(), siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(fetch.calls.map((call) => call.url)).toEqual([clientJarUrl(SITE, '2.0.0')]);
    });

    test('an existing jar succeeds without any request', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-2.0.0.jar');
        const fetch = makeFetch(() => {
            throw new Error('should not be called');
        });
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result.ok).toBe(true);
        expect(fetch.calls).toHaveLength(0);
    });

    test('an interrupted transfer leaves nothing at the final name', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(1000));
                    controller.error(new Error('connection reset'));
                }
            });
            return new Response(stream, { status: 200, headers: { 'content-length': '5000' } });
        });
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result.ok).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('a stalled transfer times out and leaves nothing', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch((url, options) => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(10));
                    options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
                }
            });
            return new Response(stream, { status: 200 });
        });
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch, stallTimeoutMs: 50 });
        expect(result).toEqual({ ok: false, error: 'The download stalled' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('without a checksum, an HTML page is refused and nothing is kept', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => new Response('<html>Not here</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result).toEqual({ ok: false, error: 'The download was not a client jar' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('without a checksum, a file that is not a zip is refused and nothing is kept', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => jarResponse(Buffer.from('definitely not a jar')));
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result).toEqual({ ok: false, error: 'The download was not a client jar' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('without a checksum, a zip arriving in small chunks is accepted', async () => {
        const dir = makeTempDir();
        const fetch = makeFetch(() => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([0x50, 0x4b]));
                    controller.enqueue(new Uint8Array([0x03, 0x04, 0x14]));
                    controller.close();
                }
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'application/java-archive' } });
        });
        const result = await downloadClient('2.0.0', { dir, siteUrl: SITE, env: {}, log: makeLog(), fetch });
        expect(result.ok).toBe(true);
    });

    test('refuses unsafe versions', async () => {
        const result = await downloadClient('../x', { dir: makeTempDir(), siteUrl: SITE, env: {}, log: makeLog(), fetch: makeFetch(() => null) });
        expect(result.ok).toBe(false);
    });
});

describe('pruning old jars', () => {
    async function downloadInto(dir, version, env = {}) {
        const fetch = makeFetch(() => jarResponse(Buffer.concat([ZIP, Buffer.from('jar')])));
        return downloadClient(version, { dir, siteUrl: SITE, env, log: makeLog(), fetch });
    }

    test('older numeric jars go, newer ones and unrelated files stay', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-1.0.9.jar', 'projectx-1.0.43.jar', 'projectx-3.0.0.jar', 'projectx-1.2.3-dev.jar',
            'projectx-launcher-1.0.0.jar', 'accounts.json', 'scripts.dat');
        await downloadInto(dir, '2.0.0');
        expect(fs.readdirSync(dir).sort()).toEqual([
            'accounts.json', 'projectx-1.2.3-dev.jar', 'projectx-2.0.0.jar', 'projectx-3.0.0.jar', 'projectx-launcher-1.0.0.jar', 'scripts.dat'
        ]);
    });

    test('nothing is pruned when the version is pinned or not numeric', async () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-1.0.0.jar');
        await downloadInto(dir, '2.0.0', { PROJECTX_CLIENT_VERSION: '2.0.0' });
        await downloadInto(dir, '9.9.9-dev');
        expect(fs.readdirSync(dir)).toContain('projectx-1.0.0.jar');
    });

    test('a jar that cannot be deleted is skipped without failing', () => {
        const dir = makeTempDir();
        touch(dir, 'projectx-1.0.0.jar', 'projectx-1.5.0.jar', 'projectx-2.0.0.jar');
        const log = makeLog();
        const realUnlink = fs.unlinkSync;
        const spy = jest.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
            if (String(file).endsWith('projectx-1.0.0.jar')) {
                const err = new Error('busy');
                err.code = 'EBUSY';
                throw err;
            }
            return realUnlink(file);
        });
        try {
            const removed = pruneOlderJars({ dir, version: '2.0.0', env: {}, log });
            expect(removed).toEqual(['projectx-1.5.0.jar']);
            expect(log.lines.some((line) => line.level === 'warn' && line.text.includes('projectx-1.0.0.jar'))).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('client update check', () => {
    function setup({ installed = [], client = '0.0.0', latest = '2.0.0' } = {}) {
        const home = makeTempDir();
        const paths = createPaths(home);
        touch(paths.projectxDir, ...installed);
        writeJsonFile(paths.settingsFile, { client, version_pref: '0.0.0', proxyip: '', client_ram: '1g', legacy_key: 'kept' });
        const log = makeLog();
        const settings = createSettingsStore({ file: paths.settingsFile, log });
        const fetch = makeFetch(() => (latest ? jsonResponse(200, { tag_name: latest }) : jsonResponse(500, {})));
        const service = createClientService({ paths, settings, siteUrl: SITE, fetch, env: {}, log });
        return { service, paths };
    }

    test('an installed latest fixes the client setting and shows no banner', async () => {
        const { service, paths } = setup({ installed: ['projectx-2.0.0.jar'], client: '1.0.0' });
        await expect(service.checkForUpdate()).resolves.toEqual({ ok: true, needsUpdate: false, latest: '2.0.0' });
        expect(readJsonFile(paths.settingsFile)).toMatchObject({ client: '2.0.0', legacy_key: 'kept' });
    });

    test('a missing latest shows the banner and repairs a stale client setting', async () => {
        const { service, paths } = setup({ installed: ['projectx-1.0.10.jar'], client: '2.0.0' });
        await expect(service.checkForUpdate()).resolves.toMatchObject({ needsUpdate: true, latest: '2.0.0' });
        expect(readJsonFile(paths.settingsFile).client).toBe('1.0.10');
    });

    test('matches exact file names: 1.0.1 is not 1.0.10', async () => {
        const { service, paths } = setup({ installed: ['projectx-1.0.10.jar'], client: '1.0.10', latest: '1.0.1' });
        await expect(service.checkForUpdate()).resolves.toMatchObject({ needsUpdate: true, latest: '1.0.1' });
        expect(readJsonFile(paths.settingsFile).client).toBe('1.0.10');
    });

    test('no jars at all resets client to 0.0.0', async () => {
        const { service, paths } = setup({ installed: [], client: '2.0.0' });
        await service.checkForUpdate();
        expect(readJsonFile(paths.settingsFile).client).toBe('0.0.0');
    });

    test('a failed lookup does nothing', async () => {
        const { service, paths } = setup({ installed: [], client: '1.0.0', latest: null });
        await expect(service.checkForUpdate()).resolves.toMatchObject({ ok: false });
        expect(readJsonFile(paths.settingsFile).client).toBe('1.0.0');
    });
});
