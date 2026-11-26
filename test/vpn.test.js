'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
    HELPER_MISSING,
    findHelper,
    pickFreePort,
    waitForPort,
    helperEnv,
    cleanRunDir,
    startHelper,
    createVpnManager,
    parseTrace,
    traceThroughSocks,
    proxyUriFor
} = require('../src/main/vpn');
const { createVpnStore, isVpnId } = require('../src/main/vpn-store');
const { parseWireGuardConfig } = require('../src/main/wireguard');
const { createPresetStore, toClientPreset } = require('../src/main/presets');
const { createOperations } = require('../src/main/operations');
const { makeTempDir, cleanupTempDirs, makeLog } = require('./helpers');

afterEach(cleanupTempDirs);

const key = () => crypto.randomBytes(32).toString('base64');
const PRIV = key();
const PUB = key();

function configText(privateKey = PRIV) {
    return ['[Interface]', 'PrivateKey = ' + privateKey, 'Address = 10.66.0.2/32', 'DNS = 10.64.0.1', 'PostUp = echo hacked',
        '[Peer]', 'PublicKey = ' + PUB, 'Endpoint = se-1.example.net:51820', 'AllowedIPs = 0.0.0.0/0'].join('\n');
}

// Stands in for Electron's safeStorage: reversible, and obviously not the plain text.
function fakeSecretBox({ available = true } = {}) {
    return {
        available,
        isAvailable() {
            return this.available;
        },
        encrypt: (text) => Buffer.from('enc:' + Buffer.from(text).toString('hex')),
        decrypt: (buffer) => {
            const text = buffer.toString();
            if (!text.startsWith('enc:')) {
                throw new Error('bad data');
            }
            return Buffer.from(text.slice(4), 'hex').toString();
        }
    };
}

function makeStore({ available = true } = {}) {
    const dir = makeTempDir();
    const log = makeLog();
    const secretBox = fakeSecretBox({ available });
    const store = createVpnStore({ dir: path.join(dir, 'vpn'), secretBox, log });
    return { dir, log, store, secretBox, vpnDir: path.join(dir, 'vpn') };
}

describe('VPN config store', () => {
    test('saves the cleaned config encrypted and hands back only what the UI shows', () => {
        const { store, vpnDir, log } = makeStore();
        const result = store.importText(configText(), 'se-sto-001.conf');
        expect(result.ok).toBe(true);
        expect(isVpnId(result.vpn.id)).toBe(true);
        expect(result.vpn).toEqual({ id: result.vpn.id, name: 'se-sto-001', endpoint: 'se-1.example.net:51820', encrypted: true });
        expect(result.warnings.join(' ')).toContain('PostUp');
        expect(JSON.stringify(result)).not.toContain(PRIV);

        const raw = fs.readFileSync(path.join(vpnDir, result.vpn.id + '.json'), 'utf8');
        expect(raw).not.toContain(PRIV);
        expect(raw).not.toContain('PrivateKey');
        expect(JSON.parse(raw)).toMatchObject({ v: 1, encrypted: true, data: expect.any(String) });
        expect(JSON.parse(raw)).not.toHaveProperty('text');

        const config = store.load(result.vpn.id);
        expect(config.interface.privateKey).toBe(PRIV);
        expect(store.info(result.vpn.id)).toEqual(result.vpn);
        expect(log.all()).not.toContain(PRIV);
        expect(log.all()).toContain('encrypted');
    });

    test('without a system key store the config is kept unencrypted and says so', () => {
        const { store, vpnDir } = makeStore({ available: false });
        const result = store.importText(configText(), 'home.conf');
        expect(result.vpn.encrypted).toBe(false);
        const record = JSON.parse(fs.readFileSync(path.join(vpnDir, result.vpn.id + '.json'), 'utf8'));
        expect(record.encrypted).toBe(false);
        expect(record.text).toContain('PrivateKey = ' + PRIV);
        expect(record.text).not.toContain('PostUp');
        expect(store.load(result.vpn.id).interface.privateKey).toBe(PRIV);
    });

    test('the saved file is private on POSIX systems', () => {
        if (process.platform === 'win32') {
            return;
        }
        const { store, vpnDir } = makeStore();
        const { vpn } = store.importText(configText(), 'a.conf');
        expect(fs.statSync(path.join(vpnDir, vpn.id + '.json')).mode & 0o777).toBe(0o600);
    });

    test('an encrypted config that can no longer be unlocked asks for a new import', () => {
        const { store, secretBox, vpnDir } = makeStore();
        const { vpn } = store.importText(configText(), 'a.conf');
        secretBox.available = false;
        expect(() => store.load(vpn.id)).toThrow('could not be unlocked');
        secretBox.available = true;
        const file = path.join(vpnDir, vpn.id + '.json');
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...record, data: Buffer.from('garbage').toString('base64') }));
        expect(() => store.load(vpn.id)).toThrow('could not be unlocked');
        expect(() => store.load('0123456789abcdef')).toThrow('missing');
        expect(() => store.load('../../etc')).toThrow('missing');
    });

    test('bad configs are refused and nothing is saved', () => {
        const { store, vpnDir } = makeStore();
        expect(store.importText('[Interface]\nPrivateKey = nope', 'x.conf')).toMatchObject({ ok: false, error: expect.stringContaining('PrivateKey') });
        expect(fs.existsSync(vpnDir) ? fs.readdirSync(vpnDir) : []).toEqual([]);
    });

    test('importFile reads a .conf and refuses folders and huge files', () => {
        const { store, dir } = makeStore();
        const file = path.join(dir, 'Work VPN.conf');
        fs.writeFileSync(file, configText());
        expect(store.importFile(file)).toMatchObject({ ok: true, vpn: { name: 'Work VPN' } });
        expect(store.importFile(dir)).toMatchObject({ ok: false, error: 'That is not a file.' });
        const big = path.join(dir, 'big.conf');
        fs.writeFileSync(big, 'x'.repeat(70 * 1024));
        expect(store.importFile(big)).toMatchObject({ ok: false, error: expect.stringContaining('too big') });
        expect(store.importFile(path.join(dir, 'missing.conf')).ok).toBe(false);
    });

    test('sweep deletes configs no preset uses, but keeps ones being edited', () => {
        const { store, vpnDir } = makeStore();
        const a = store.importText(configText(), 'a.conf').vpn.id;
        const b = store.importText(configText(key()), 'b.conf').vpn.id;
        const c = store.importText(configText(key()), 'c.conf').vpn.id;
        store.settle(a);
        store.settle(b);
        expect(store.sweep(new Set([a]))).toBe(1);
        expect(fs.readdirSync(vpnDir).sort()).toEqual([a + '.json', c + '.json'].sort());
        store.remove(c);
        expect(fs.readdirSync(vpnDir)).toEqual([a + '.json']);
    });
});

describe('ports', () => {
    test('picks a free localhost port', async () => {
        const port = await pickFreePort();
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
        const server = net.createServer();
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
        await new Promise((resolve) => server.close(resolve));
    });

    test('two picks in a row give different ports while the first is taken', async () => {
        const first = await pickFreePort();
        const server = net.createServer();
        await new Promise((resolve) => server.listen(first, '127.0.0.1', resolve));
        const second = await pickFreePort();
        expect(second).not.toBe(first);
        await new Promise((resolve) => server.close(resolve));
    });

    test('waitForPort resolves once something listens', async () => {
        const port = await pickFreePort();
        const server = net.createServer();
        setTimeout(() => server.listen(port, '127.0.0.1'), 120);
        await expect(waitForPort({ port, timeoutMs: 3000, intervalMs: 30 })).resolves.toBeUndefined();
        await new Promise((resolve) => server.close(resolve));
    });

    test('waitForPort times out, or stops early when told', async () => {
        const port = await pickFreePort();
        await expect(waitForPort({ port, timeoutMs: 150, intervalMs: 30 })).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' });
        let calls = 0;
        await expect(waitForPort({ port, timeoutMs: 5000, intervalMs: 10, stopped: () => (++calls > 2 ? 'exited' : null) })).rejects.toMatchObject({ code: 'HELPER_EXITED' });
    });
});

describe('finding the helper', () => {
    test('installed app: resources/wireproxy; from source: vendor/wireproxy/<target>', () => {
        const exists = (file) => true;
        expect(findHelper({ platform: 'win32', arch: 'x64', resourcesPath: 'C:\\App\\resources', isPackaged: true, exists }))
            .toBe(path.join('C:\\App\\resources', 'wireproxy', 'wireproxy.exe'));
        expect(findHelper({ platform: 'darwin', arch: 'arm64', appRoot: '/src/launcher', isPackaged: false, exists }))
            .toBe(path.join('/src/launcher', 'vendor', 'wireproxy', 'darwin-universal', 'wireproxy'));
        expect(findHelper({ platform: 'linux', arch: 'x64', appRoot: '/src', isPackaged: false, exists }))
            .toBe(path.join('/src', 'vendor', 'wireproxy', 'linux-x64', 'wireproxy'));
    });

    test('null when it is not there or the platform has none', () => {
        expect(findHelper({ platform: 'win32', arch: 'x64', resourcesPath: '/r', isPackaged: true, exists: () => false })).toBeNull();
        expect(findHelper({ platform: 'linux', arch: 'arm64', appRoot: '/src', isPackaged: false, exists: () => true })).toBeNull();
    });

    test('the helper gets the environment without our variables', () => {
        expect(helperEnv({ PATH: '/bin', PROJECTX_ACCOUNT_TOKEN: 'px_x', JX_SESSION_ID: 's', SystemRoot: 'C:\\Windows' }))
            .toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows' });
    });
});

// A stand-in for wireproxy. It reads the config the launcher wrote, like the real one, then acts
// out the given behaviour: listen on the SOCKS port, stay silent, or crash.
function fakeHelpers(behaviour = 'ready') {
    const spawned = [];
    const spawn = jest.fn((command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const configPath = args[1];
        const text = fs.readFileSync(configPath, 'utf8');
        const port = Number(/BindAddress = 127\.0\.0\.1:(\d+)/.exec(text)[1]);
        const record = { child, command, args, options, text, configPath, port, server: null };
        spawned.push(record);
        child.kill = jest.fn(() => {
            if (record.server) {
                record.server.close();
            }
            setImmediate(() => child.emit('exit', null, 'SIGTERM'));
            return true;
        });
        const mode = typeof behaviour === 'function' ? behaviour(spawned.length) : behaviour;
        setImmediate(() => {
            if (mode === 'ready') {
                child.stderr.write('DEBUG: peer(abcd) - Starting\n');
                record.server = net.createServer((socket) => socket.destroy());
                record.server.listen(port, '127.0.0.1');
                record.server.unref();
            } else if (mode === 'crash') {
                child.stderr.write('2026/11/26 bad config: invalid base64 string: ' + PRIV + '\n');
                child.stderr.write('fatal: could not start\n');
                setTimeout(() => child.emit('exit', 1, null), 20);
            } else if (mode === 'enoent') {
                const err = new Error('spawn wireproxy ENOENT');
                err.code = 'ENOENT';
                child.emit('error', err);
            }
        });
        return child;
    });
    return { spawn, spawned };
}

function fakeClient() {
    const child = new EventEmitter();
    child.kill = jest.fn(() => {
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
        return true;
    });
    return child;
}

function makeManager({ behaviour = 'ready', timeoutMs = 3000, helperPath = '/app/wireproxy' } = {}) {
    const { store, dir, log } = makeStore();
    const runDir = path.join(dir, 'vpn-run');
    const helpers = fakeHelpers(behaviour);
    const onDisconnect = jest.fn();
    const manager = createVpnManager({
        store,
        findHelperPath: () => helperPath,
        spawn: helpers.spawn,
        runDir,
        env: { PATH: '/bin', PROJECTX_ACCOUNT_TOKEN: 'px_secret' },
        log,
        onDisconnect,
        timeoutMs
    });
    const vpnId = store.importText(configText(), 'se.conf').vpn.id;
    return { manager, store, helpers, onDisconnect, log, runDir, vpnId };
}

const until = async (check, ms = 2000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('condition not met');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe('helper lifecycle', () => {
    test('ready: spawned without a shell, hidden, with an owner-only temp config deleted once read', async () => {
        const { manager, helpers, vpnId, runDir, log } = makeManager();
        const result = await manager.acquire(vpnId, 'Sweden');
        expect(result.ok).toBe(true);
        const [helper] = helpers.spawned;
        expect(helper.command).toBe('/app/wireproxy');
        expect(helper.args).toEqual(['-c', helper.configPath]);
        expect(helper.options).toMatchObject({ windowsHide: true, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        expect(helper.options.env).toEqual({ PATH: '/bin' });
        expect(path.dirname(helper.configPath)).toBe(runDir);
        expect(fs.existsSync(helper.configPath)).toBe(false);
        expect(helper.text).toContain('PrivateKey = ' + PRIV);
        expect(helper.text).toMatch(/\[Socks5\]\nBindAddress = 127\.0\.0\.1:\d+\nUsername = [a-f0-9]{16}\nPassword = [a-f0-9]{32}\n$/);
        expect(helper.text).not.toContain('PostUp');
        const { username, password } = result.lease.credentials;
        expect(result.lease.proxyUri).toBe('socks5://' + username + ':' + password + '@127.0.0.1:' + helper.port);
        expect(result.lease.proxyUri).toBe(proxyUriFor({ port: helper.port, username, password }));
        expect(log.all()).not.toContain(PRIV);
        expect(log.all()).not.toContain(password);
        result.lease.release();
        expect(helper.child.kill).toHaveBeenCalled();
    });

    test('the temp config is written owner-only on POSIX systems', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { manager, helpers, vpnId } = makeManager();
        let mode = null;
        helpers.spawn.mockImplementationOnce(((original) => (command, args, options) => {
            mode = fs.statSync(args[1]).mode & 0o777;
            return original(command, args, options);
        })(helpers.spawn.getMockImplementation()));
        const result = await manager.acquire(vpnId, 'Sweden');
        expect(mode).toBe(0o600);
        result.lease.release();
    });

    test('timeout: a clear error with the helper output, and the helper is stopped', async () => {
        const { manager, helpers, vpnId } = makeManager({ behaviour: 'silent', timeoutMs: 300 });
        helpers.spawn.mockImplementationOnce(((original) => (command, args, options) => {
            const child = original(command, args, options);
            setImmediate(() => child.stderr.write('Handshake did not complete after 5 seconds\n'));
            return child;
        })(helpers.spawn.getMockImplementation()));
        const result = await manager.acquire(vpnId, 'Sweden');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('did not start within 1 seconds');
        expect(result.error).toContain('Handshake did not complete');
        const [helper] = helpers.spawned;
        expect(helper.child.kill).toHaveBeenCalled();
        expect(fs.existsSync(helper.configPath)).toBe(false);
        expect(manager.tunnelCount()).toBe(0);
    });

    test('a helper that exits while connecting reports its (scrubbed) output', async () => {
        const { manager, helpers, vpnId } = makeManager({ behaviour: 'crash' });
        const result = await manager.acquire(vpnId, 'Sweden');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('stopped while connecting');
        expect(result.error).toContain('fatal: could not start');
        expect(result.error).not.toContain(PRIV);
        expect(fs.existsSync(helpers.spawned[0].configPath)).toBe(false);
    });

    test('a missing helper is a clear error, found before or at spawn', async () => {
        const before = makeManager({ helperPath: null });
        await expect(before.manager.acquire(before.vpnId, 'Sweden')).resolves.toEqual({ ok: false, error: HELPER_MISSING });
        expect(before.helpers.spawn).not.toHaveBeenCalled();
        const during = makeManager({ behaviour: 'enoent' });
        await expect(during.manager.acquire(during.vpnId, 'Sweden')).resolves.toEqual({ ok: false, error: HELPER_MISSING });
        expect(HELPER_MISSING).toContain('npm run fetch-helper');
    });

    test('a missing config is a clear error', async () => {
        const { manager } = makeManager();
        await expect(manager.acquire('0123456789abcdef', 'Sweden')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Import it again') });
    });

    test('cleanup on client exit: the helper stops with its last client', async () => {
        const { manager, helpers, vpnId, onDisconnect } = makeManager();
        const result = await manager.acquire(vpnId, 'Sweden');
        const client = fakeClient();
        result.lease.attach(client);
        expect(manager.activeClientCount()).toBe(1);
        client.emit('exit', 0);
        const [helper] = helpers.spawned;
        expect(helper.child.kill).toHaveBeenCalledTimes(1);
        expect(manager.tunnelCount()).toBe(0);
        expect(manager.activeClientCount()).toBe(0);
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    test('clients with the same config share one helper until the last one exits', async () => {
        const { manager, helpers, vpnId } = makeManager();
        const [a, b] = await Promise.all([manager.acquire(vpnId, 'Sweden'), manager.acquire(vpnId, 'Sweden alt')]);
        expect(helpers.spawn).toHaveBeenCalledTimes(1);
        expect(a.lease.proxyUri).toBe(b.lease.proxyUri);
        const first = fakeClient();
        const second = fakeClient();
        a.lease.attach(first);
        b.lease.attach(second);
        first.emit('exit', 0);
        expect(helpers.spawned[0].child.kill).not.toHaveBeenCalled();
        second.emit('exit', 0);
        expect(helpers.spawned[0].child.kill).toHaveBeenCalledTimes(1);
    });

    test('different configs run side by side on different ports', async () => {
        const { manager, helpers, store, vpnId } = makeManager();
        const otherId = store.importText(configText(key()), 'us.conf').vpn.id;
        const [a, b] = await Promise.all([manager.acquire(vpnId, 'Sweden'), manager.acquire(otherId, 'USA')]);
        expect(helpers.spawn).toHaveBeenCalledTimes(2);
        expect(a.lease.port).not.toBe(b.lease.port);
        a.lease.release();
        b.lease.release();
    });

    test('exit while running: the client is closed and the user is told which VPN dropped', async () => {
        const { manager, helpers, vpnId, onDisconnect, log } = makeManager();
        const result = await manager.acquire(vpnId, 'Sweden');
        const client = fakeClient();
        result.lease.attach(client);
        const [helper] = helpers.spawned;
        helper.server.close();
        helper.child.emit('exit', 2, null);
        expect(client.kill).toHaveBeenCalled();
        expect(onDisconnect).toHaveBeenCalledWith(['Sweden']);
        expect(log.all()).toContain('VPN for Sweden disconnected');
        expect(manager.tunnelCount()).toBe(0);
        // The next launch starts a fresh helper.
        const again = await manager.acquire(vpnId, 'Sweden');
        expect(again.ok).toBe(true);
        expect(helpers.spawn).toHaveBeenCalledTimes(2);
        again.lease.release();
    });

    test('a stop the launcher asked for is not reported as a disconnection', async () => {
        const { manager, helpers, vpnId, onDisconnect } = makeManager();
        const result = await manager.acquire(vpnId, 'Sweden');
        result.lease.release();
        await until(() => helpers.spawned[0].child.kill.mock.calls.length > 0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    test('quitting stops every helper and closes their clients, without a disconnect message', async () => {
        const { manager, helpers, store, vpnId, onDisconnect, runDir } = makeManager();
        const otherId = store.importText(configText(key()), 'us.conf').vpn.id;
        const a = await manager.acquire(vpnId, 'Sweden');
        const b = await manager.acquire(otherId, 'USA');
        const clients = [fakeClient(), fakeClient()];
        a.lease.attach(clients[0]);
        b.lease.attach(clients[1]);
        fs.writeFileSync(path.join(runDir, 'wg-deadbeef.conf'), 'left over');
        expect(manager.activeClientCount()).toBe(2);
        manager.stopAll({ closeClients: true });
        for (const helper of helpers.spawned) {
            expect(helper.child.kill).toHaveBeenCalled();
        }
        for (const client of clients) {
            expect(client.kill).toHaveBeenCalled();
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(fs.readdirSync(runDir)).toEqual([]);
        expect(manager.tunnelCount()).toBe(0);
    });

    test('test connection reports the exit address and stops a helper it started', async () => {
        const { manager, helpers, vpnId } = makeManager();
        const request = jest.fn(async ({ port, username, password }) => {
            expect(port).toBe(helpers.spawned[0].port);
            expect(username).toMatch(/^[a-f0-9]{16}$/);
            expect(password).toMatch(/^[a-f0-9]{32}$/);
            return { ip: '185.65.135.10', countryCode: 'SE', country: 'Sweden' };
        });
        await expect(manager.test(vpnId, 'a test', request)).resolves.toEqual({ ok: true, ip: '185.65.135.10', countryCode: 'SE', country: 'Sweden' });
        expect(helpers.spawned[0].child.kill).toHaveBeenCalled();
        request.mockRejectedValueOnce(new Error('no answer within 12 seconds'));
        await expect(manager.test(vpnId, 'a test', request)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('nothing came back') });
    });

    test('testing a config a client is using reuses its helper and leaves it running', async () => {
        const { manager, helpers, vpnId } = makeManager();
        const running = await manager.acquire(vpnId, 'Sweden');
        running.lease.attach(fakeClient());
        await manager.test(vpnId, 'a test', async () => ({ ip: '185.65.135.10', countryCode: null, country: null }));
        expect(helpers.spawn).toHaveBeenCalledTimes(1);
        expect(helpers.spawned[0].child.kill).not.toHaveBeenCalled();
        manager.stopAll({ closeClients: true });
        expect(helpers.spawned[0].child.kill).toHaveBeenCalled();
    });

    test('a port taken in the moment before the helper binds is retried on a new port', async () => {
        const { store, dir, log } = makeStore();
        const config = store.load(store.importText(configText(), 'a.conf').vpn.id);
        const helpers = fakeHelpers((count) => (count === 1 ? 'taken' : 'ready'));
        helpers.spawn.mockImplementationOnce(((original) => (command, args, options) => {
            const child = original(command, args, options);
            setImmediate(() => {
                child.stderr.write('listen tcp 127.0.0.1:1234: bind: address already in use\n');
                child.emit('exit', 1, null);
            });
            return child;
        })(helpers.spawn.getMockImplementation()));
        const helper = await startHelper({ binary: '/w', config, runDir: path.join(dir, 'run'), spawn: helpers.spawn, env: {}, timeoutMs: 2000 });
        expect(helpers.spawn).toHaveBeenCalledTimes(2);
        expect(helper.port).toBe(helpers.spawned[1].port);
        helper.child.kill();
        expect(log.lines).toBeDefined();
    });

    test('cleanRunDir removes only leftover helper configs', () => {
        const dir = makeTempDir();
        fs.writeFileSync(path.join(dir, 'wg-abc123.conf'), 'x');
        fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
        cleanRunDir(dir);
        expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
        expect(() => cleanRunDir(path.join(dir, 'missing'))).not.toThrow();
    });
});

// A small SOCKS5 server with a user name and password, forwarding to a fake web server.
function fakeSocks({ username, password, reply }) {
    const seen = { hosts: [], auth: [] };
    const server = net.createServer((socket) => {
        let stage = 'greeting';
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting' && buffer.length >= 3) {
                const methods = [...buffer.subarray(2, 2 + buffer[1])];
                buffer = buffer.subarray(2 + buffer[1]);
                socket.write(Buffer.from([5, methods.includes(2) ? 2 : 0xff]));
                stage = 'auth';
            }
            if (stage === 'auth' && buffer.length >= 2) {
                const ulen = buffer[1];
                const plen = buffer[2 + ulen];
                const user = buffer.subarray(2, 2 + ulen).toString();
                const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
                buffer = buffer.subarray(3 + ulen + plen);
                seen.auth.push(user + ':' + pass);
                const ok = user === username && pass === password;
                socket.write(Buffer.from([1, ok ? 0 : 1]));
                if (!ok) {
                    socket.end();
                    return;
                }
                stage = 'connect';
            }
            if (stage === 'connect' && buffer.length >= 5) {
                const length = buffer[4];
                seen.hosts.push({ atyp: buffer[3], host: buffer.subarray(5, 5 + length).toString(), port: buffer.readUInt16BE(5 + length) });
                buffer = Buffer.alloc(0);
                socket.write(Buffer.from([5, 0, 0, 1, 10, 0, 0, 1, 0, 80]));
                stage = 'http';
                return;
            }
            if (stage === 'http' && buffer.toString().includes('\r\n\r\n')) {
                seen.request = buffer.toString();
                socket.end(reply);
            }
        });
        socket.on('error', () => {});
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

describe('test connection request', () => {
    const TRACE = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nfl=1\nh=www.cloudflare.com\nip=185.65.135.10\nts=1\nloc=SE\nwarp=off\n';
    const endpoint = { host: 'trace.example', path: '/cdn-cgi/trace', parse: parseTrace };

    test('goes through SOCKS5 with the login, sends the host name and reads the exit address', async () => {
        const { server, port, seen } = await fakeSocks({ username: 'user1234', password: 'pass5678', reply: TRACE });
        const result = await traceThroughSocks({ port, username: 'user1234', password: 'pass5678', secure: false, endpoints: [endpoint], timeoutMs: 3000 });
        server.close();
        expect(result).toEqual({ ip: '185.65.135.10', countryCode: 'SE', country: expect.any(String) });
        expect(seen.auth).toEqual(['user1234:pass5678']);
        // atyp 3: a domain name, so the lookup happens at the far end of the VPN.
        expect(seen.hosts).toEqual([{ atyp: 3, host: 'trace.example', port: 80 }]);
        expect(seen.request.startsWith('GET /cdn-cgi/trace HTTP/1.0\r\nHost: trace.example\r\n')).toBe(true);
    });

    test('a wrong login or a bad reply fails with a reason', async () => {
        const { server, port } = await fakeSocks({ username: 'user1234', password: 'pass5678', reply: 'HTTP/1.1 503 Busy\r\n\r\n' });
        await expect(traceThroughSocks({ port, username: 'user1234', password: 'wrong', secure: false, endpoints: [endpoint], timeoutMs: 3000 }))
            .rejects.toThrow('refused the sign-in');
        await expect(traceThroughSocks({ port, username: 'user1234', password: 'pass5678', secure: false, endpoints: [endpoint], timeoutMs: 3000 }))
            .rejects.toThrow('HTTP 503');
        server.close();
    });

    test('times out when nothing answers', async () => {
        const silent = net.createServer(() => {});
        await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
        const started = Date.now();
        await expect(traceThroughSocks({ port: silent.address().port, username: 'user1234', password: 'pass5678', secure: false, endpoints: [endpoint, endpoint], timeoutMs: 200 }))
            .rejects.toThrow('no answer within');
        // A silent tunnel is not tried again with the second service.
        expect(Date.now() - started).toBeLessThan(380);
        silent.close();
    });

    test('parseTrace reads ip and country and ignores junk', () => {
        expect(parseTrace('ip=2001:db8::5\nloc=DE\n')).toMatchObject({ ip: '2001:db8::5', countryCode: 'DE' });
        expect(parseTrace('ip=not-an-ip\nloc=XX')).toEqual({ ip: null, countryCode: null, country: null });
        expect(parseTrace('<html>')).toEqual({ ip: null, countryCode: null, country: null });
    });
});

describe('VPN operations', () => {
    function setup({ available = true } = {}) {
        const dir = makeTempDir();
        const log = makeLog();
        const presets = createPresetStore({ file: path.join(dir, 'launch-presets.json'), log });
        const vpnStore = createVpnStore({ dir: path.join(dir, 'vpn'), secretBox: fakeSecretBox({ available }), log });
        const confFile = path.join(dir, 'se-sto-001.conf');
        fs.writeFileSync(confFile, configText());
        const picked = { file: confFile };
        const vpn = { test: jest.fn(async () => ({ ok: true, ip: '185.65.135.10', country: 'Sweden' })) };
        const ops = createOperations({
            log,
            messageBox: jest.fn(async () => ({ response: 1 })),
            presets,
            vpnStore,
            vpn,
            pickConfigFile: async () => picked.file
        });
        return { dir, log, presets, vpnStore, ops, picked, vpn };
    }

    test('import returns the name, server and warnings, never the key', async () => {
        const { ops, log } = setup();
        const result = await ops.importVpnConfig();
        expect(result).toMatchObject({ ok: true, vpn: { name: 'se-sto-001', endpoint: 'se-1.example.net:51820', encrypted: true } });
        expect(result.warnings.join(' ')).toContain('PostUp');
        expect(JSON.stringify(result)).not.toContain(PRIV);
        expect(log.all()).not.toContain(PRIV);
    });

    test('cancelling the picker or picking a bad file', async () => {
        const { ops, picked, dir } = setup();
        picked.file = null;
        await expect(ops.importVpnConfig()).resolves.toEqual({ ok: false, cancelled: true });
        picked.file = path.join(dir, 'bad.conf');
        fs.writeFileSync(picked.file, '[Interface]\nPostUp = calc.exe\n');
        await expect(ops.importVpnConfig()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('PrivateKey') });
    });

    test('a VPN preset is saved with the stored details, not the page\u2019s, and needs a config', async () => {
        const { ops } = setup();
        const imported = await ops.importVpnConfig();
        const missing = ops.savePreset({ name: 'Sweden', connection: 'vpn', vpn: null });
        expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('Import a WireGuard config') });
        const unknown = ops.savePreset({ name: 'Sweden', connection: 'vpn', vpn: { id: 'ffffffffffffffff' } });
        expect(unknown.ok).toBe(false);
        const saved = ops.savePreset({ name: 'Sweden', connection: 'vpn', vpn: { id: imported.vpn.id, name: 'spoofed', endpoint: 'evil:1', encrypted: true } });
        expect(saved.ok).toBe(true);
        expect(saved.preset.connection).toBe('vpn');
        expect(saved.preset.vpn).toEqual(imported.vpn);
    });

    test('presets export without keys: the presets file and every preset view hold no key', async () => {
        const { ops, dir } = setup();
        const imported = await ops.importVpnConfig();
        const saved = ops.savePreset({ name: 'Sweden', connection: 'vpn', vpn: { id: imported.vpn.id } });
        const fileText = fs.readFileSync(path.join(dir, 'launch-presets.json'), 'utf8');
        const listed = JSON.stringify(ops.getPresets());
        const forClient = JSON.stringify(toClientPreset(saved.preset));
        for (const text of [fileText, listed, forClient, JSON.stringify(saved)]) {
            expect(text).not.toContain(PRIV);
            expect(text).not.toMatch(/PrivateKey|PresharedKey/i);
        }
        expect(JSON.parse(fileText).presets[0].vpn).toEqual(imported.vpn);
        expect(forClient).not.toContain('vpn');
        expect(forClient).not.toContain(imported.vpn.id);
    });

    test('configs no preset uses are deleted when presets change, but not one being edited', async () => {
        const { ops, dir, picked } = setup();
        const first = await ops.importVpnConfig();
        const saved = ops.savePreset({ name: 'Sweden', connection: 'vpn', vpn: { id: first.vpn.id } });
        const vpnDir = path.join(dir, 'vpn');
        fs.writeFileSync(picked.file, configText(key()));
        const second = await ops.importVpnConfig();
        // Saving another preset meanwhile keeps the config imported for the one being edited.
        ops.savePreset({ name: 'Other' });
        expect(fs.readdirSync(vpnDir).sort()).toEqual([first.vpn.id + '.json', second.vpn.id + '.json'].sort());
        // Switching the preset to the new config deletes the old one.
        ops.savePreset({ ...saved.preset, vpn: { id: second.vpn.id } });
        expect(fs.readdirSync(vpnDir)).toEqual([second.vpn.id + '.json']);
        // Switching to Direct, then deleting, leaves nothing behind.
        const direct = ops.savePreset({ ...saved.preset, connection: 'direct', vpn: null });
        expect(direct.preset.vpn).toBeNull();
        expect(fs.readdirSync(vpnDir)).toEqual([]);
        await ops.deletePreset(saved.preset.id);
    });

    test('test connection passes the id through', async () => {
        const { ops, vpn } = setup();
        await expect(ops.testVpnConfig('0123456789abcdef')).resolves.toMatchObject({ ok: true, ip: '185.65.135.10' });
        expect(vpn.test).toHaveBeenCalledWith('0123456789abcdef', 'a connection test');
    });

    test('parsed configs from the store match what was imported', () => {
        const { vpnStore } = setup();
        const { vpn } = vpnStore.importText(configText(), 'x.conf');
        expect(vpnStore.load(vpn.id)).toEqual(parseWireGuardConfig(configText()).config);
    });
});
