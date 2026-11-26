'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const { scrub } = require('./redact');
const { buildHelperConfig, configFingerprint } = require('./wireguard');

// Per-preset VPN: the bundled helper (wireproxy) runs WireGuard in user space for one config and
// offers it to the client as a SOCKS5 proxy on 127.0.0.1. No VPN app, system change or admin
// rights are needed, and different configs can run side by side. Clients that use the same config
// share one helper, because a WireGuard server keeps only one connection per key.

const READY_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 150;
const TEST_TIMEOUT_MS = 12000;
const TAIL_LINES = 30;
const LOCALHOST = '127.0.0.1';
const HELPER_MISSING = 'The VPN helper is missing from this copy of the launcher, so VPN presets cannot start. '
    + 'Reinstall the launcher from the download page. If you built it yourself, run "npm run fetch-helper" first.';

// Folder names under vendor/wireproxy (development) for each platform's helper. Windows on Arm
// runs the x64 build; the macOS build is universal.
function helperTarget(platform, arch) {
    if (platform === 'win32') {
        return 'win32-x64';
    }
    if (platform === 'linux' && arch === 'x64') {
        return 'linux-x64';
    }
    if (platform === 'darwin') {
        return 'darwin-universal';
    }
    return null;
}

function helperFileName(platform) {
    return platform === 'win32' ? 'wireproxy.exe' : 'wireproxy';
}

// Where the helper should be: in the installed app's resources, or in vendor/ when running from
// source. Returns null when it is not there.
function findHelper({ platform, arch, resourcesPath, appRoot, isPackaged, exists = fs.existsSync }) {
    const name = helperFileName(platform);
    let candidate = null;
    if (isPackaged) {
        candidate = resourcesPath ? path.join(resourcesPath, 'wireproxy', name) : null;
    } else {
        const target = helperTarget(platform, arch);
        candidate = target ? path.join(appRoot, 'vendor', 'wireproxy', target, name) : null;
    }
    return candidate && exists(candidate) ? candidate : null;
}

function randomToken(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function proxyUriFor({ port, username, password }) {
    return 'socks5://' + username + ':' + password + '@' + LOCALHOST + ':' + port;
}

// A free port on 127.0.0.1, found by letting the system pick one.
function pickFreePort(netImpl = net) {
    return new Promise((resolve, reject) => {
        const server = netImpl.createServer();
        server.unref();
        server.once('error', reject);
        server.listen({ port: 0, host: LOCALHOST, exclusive: true }, () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function canConnect(port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: LOCALHOST });
        const done = (ok) => {
            socket.removeAllListeners();
            socket.on('error', () => {});
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

// Resolves once the port accepts connections. stopped() returns a reason to give up early (the
// helper exited); otherwise this fails after timeoutMs.
async function waitForPort({ port, timeoutMs = READY_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS, stopped = () => null, now = Date.now }) {
    const deadline = now() + timeoutMs;
    for (;;) {
        const reason = stopped();
        if (reason) {
            const err = new Error(reason);
            err.code = 'HELPER_EXITED';
            throw err;
        }
        if (await canConnect(port, Math.min(1000, Math.max(50, deadline - now())))) {
            return;
        }
        if (now() >= deadline) {
            const err = new Error('timed out');
            err.code = 'HELPER_TIMEOUT';
            throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

// The last lines the helper printed, scrubbed of anything key-like.
function createTail(limit = TAIL_LINES) {
    const lines = [];
    let partial = '';
    return {
        push(text) {
            const parts = (partial + text).split(/\r?\n/);
            partial = parts.pop().slice(-2000);
            for (const line of parts) {
                if (line.trim()) {
                    lines.push(scrub(line.slice(0, 500)));
                    if (lines.length > limit) {
                        lines.shift();
                    }
                }
            }
        },
        text(count = 8) {
            const all = partial.trim() ? lines.concat(scrub(partial.slice(0, 500))) : lines;
            return all.slice(-count).join('\n');
        }
    };
}

// The helper gets the launcher's environment minus anything of ours.
function helperEnv(baseEnv) {
    const env = {};
    for (const [key, value] of Object.entries(baseEnv || {})) {
        if (!/^(PROJECTX_|JX_)/i.test(key)) {
            env[key] = value;
        }
    }
    return env;
}

function removeQuietly(file) {
    try {
        fs.rmSync(file, { force: true });
    } catch (_) {
        // already gone, or held open; the next start-up sweep removes it
    }
}

// Deletes helper configs left behind by a launcher that did not shut down cleanly.
function cleanRunDir(runDir) {
    let names;
    try {
        names = fs.readdirSync(runDir);
    } catch (_) {
        return;
    }
    for (const name of names) {
        if (/^wg-[a-f0-9]+\.conf$/.test(name)) {
            removeQuietly(path.join(runDir, name));
        }
    }
}

const PORT_TAKEN = /address already in use|only one usage of each socket address/i;

// Starts one helper for a parsed config and waits until its SOCKS5 port is open. The helper's
// config holds the private key, so it is written owner-only and deleted as soon as the helper has
// read it (the port opens only after that), or when the helper stops.
async function startHelper({ binary, config, runDir, spawn, env, timeoutMs = READY_TIMEOUT_MS, pickPort = pickFreePort, attempts = 2 }) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const port = await pickPort();
        const username = randomToken(8);
        const password = randomToken(16);
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const configPath = path.join(runDir, 'wg-' + randomToken(8) + '.conf');
        fs.writeFileSync(configPath, buildHelperConfig(config, { port, username, password }), { mode: 0o600, flag: 'wx' });

        const tail = createTail();
        let exit = null;
        let child;
        try {
            child = spawn(binary, ['-c', configPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                detached: false,
                shell: false,
                env: helperEnv(env)
            });
        } catch (err) {
            removeQuietly(configPath);
            throw new Error('The VPN helper could not be started: ' + err.message);
        }
        for (const stream of [child.stdout, child.stderr]) {
            if (stream) {
                stream.setEncoding('utf8');
                stream.on('data', (text) => tail.push(text));
            }
        }
        child.once('exit', (code, signal) => {
            exit = exit || { code, signal };
            removeQuietly(configPath);
        });
        child.once('error', (err) => {
            exit = exit || { error: err };
            removeQuietly(configPath);
        });

        try {
            await waitForPort({
                port,
                timeoutMs,
                stopped: () => (exit ? 'exited' : null)
            });
        } catch (err) {
            try {
                child.kill();
            } catch (_) {
                // already gone
            }
            removeQuietly(configPath);
            // Give a just-exited helper a moment to flush what it printed.
            await new Promise((resolve) => setTimeout(resolve, 50));
            const printed = tail.text();
            if (exit && exit.error && exit.error.code === 'ENOENT') {
                throw new Error(HELPER_MISSING);
            }
            if (err.code === 'HELPER_EXITED' && PORT_TAKEN.test(printed) && attempt + 1 < attempts) {
                lastError = err;
                continue;
            }
            const reason = err.code === 'HELPER_TIMEOUT'
                ? 'The VPN did not start within ' + Math.max(1, Math.round(timeoutMs / 1000)) + ' seconds.'
                : 'The VPN helper stopped while connecting' + (exit && exit.error ? ': ' + exit.error.message : '') + '.';
            throw new Error(reason + (printed ? '\n\nThe helper said:\n' + printed : ''));
        }
        removeQuietly(configPath);
        return {
            child,
            port,
            proxyUri: proxyUriFor({ port, username, password }),
            credentials: { username, password },
            tail,
            exited: () => exit
        };
    }
    throw lastError || new Error('The VPN helper could not be started.');
}

// Runs helpers for VPN presets and ties each one to the clients using it.
// onDisconnect(names) is called when a helper stops by itself while clients still use it; those
// clients are closed, since they are pinned to the dead local proxy and cannot play.
function createVpnManager({ store, findHelperPath, spawn, runDir, env = process.env, log, onDisconnect = () => {}, timeoutMs = READY_TIMEOUT_MS, pickPort = pickFreePort }) {
    const tunnels = new Map();

    function killChild(child, what) {
        try {
            child.kill();
        } catch (err) {
            log.warn('Could not stop ' + what + ': ' + err.message);
        }
    }

    function stopTunnel(tunnel) {
        if (tunnel.stopping) {
            return;
        }
        tunnel.stopping = true;
        if (tunnels.get(tunnel.fingerprint) === tunnel) {
            tunnels.delete(tunnel.fingerprint);
        }
        if (tunnel.helper) {
            killChild(tunnel.helper.child, 'the VPN helper');
            log.info('VPN for ' + tunnel.label + ' stopped');
        }
    }

    function release(tunnel, lease) {
        if (lease.released) {
            return;
        }
        lease.released = true;
        tunnel.leases.delete(lease);
        if (tunnel.leases.size === 0) {
            stopTunnel(tunnel);
        }
    }

    function helperExited(tunnel) {
        if (tunnels.get(tunnel.fingerprint) === tunnel) {
            tunnels.delete(tunnel.fingerprint);
        }
        tunnel.dead = true;
        if (tunnel.stopping) {
            return;
        }
        const printed = tunnel.helper ? tunnel.helper.tail.text(4) : '';
        log.warn('VPN for ' + tunnel.label + ' disconnected: the helper stopped' + (printed ? '\n' + printed : ''));
        const names = new Set();
        for (const lease of tunnel.leases) {
            lease.released = true;
            if (lease.child) {
                names.add(lease.owner);
                killChild(lease.child, 'a client whose VPN disconnected');
            }
        }
        tunnel.leases.clear();
        if (names.size) {
            try {
                onDisconnect([...names]);
            } catch (err) {
                log.warn('Could not report a VPN disconnection: ' + err.message);
            }
        }
    }

    function openTunnel(fingerprint, binary, config, label) {
        const tunnel = { fingerprint, label, leases: new Set(), helper: null, stopping: false, dead: false };
        tunnel.ready = startHelper({ binary, config, runDir, spawn, env, timeoutMs, pickPort }).then((helper) => {
            tunnel.helper = helper;
            if (tunnel.stopping) {
                killChild(helper.child, 'the VPN helper');
                return helper;
            }
            if (helper.exited()) {
                helperExited(tunnel);
            } else {
                helper.child.once('exit', () => helperExited(tunnel));
                log.info('VPN for ' + label + ' ready on ' + LOCALHOST + ':' + helper.port);
            }
            return helper;
        }, (err) => {
            if (tunnels.get(fingerprint) === tunnel) {
                tunnels.delete(fingerprint);
            }
            tunnel.dead = true;
            throw err;
        });
        tunnels.set(fingerprint, tunnel);
        return tunnel;
    }

    // A running helper for the saved config (starting one if needed) and a lease on it. owner is
    // the preset name, used in messages.
    async function acquire(vpnId, owner) {
        const binary = findHelperPath();
        if (!binary) {
            return { ok: false, error: HELPER_MISSING };
        }
        let config;
        try {
            config = store.load(vpnId);
        } catch (err) {
            return { ok: false, error: err.message };
        }
        const fingerprint = configFingerprint(config);
        let tunnel = tunnels.get(fingerprint);
        if (!tunnel || tunnel.stopping || tunnel.dead) {
            log.info('Starting the VPN for ' + owner);
            tunnel = openTunnel(fingerprint, binary, config, owner);
        }
        const lease = { owner, child: null, released: false };
        tunnel.leases.add(lease);
        let helper;
        try {
            helper = await tunnel.ready;
        } catch (err) {
            tunnel.leases.delete(lease);
            log.warn('The VPN for ' + owner + ' did not start: ' + err.message.split('\n')[0]);
            return { ok: false, error: err.message };
        }
        if (tunnel.dead || tunnel.stopping || lease.released) {
            tunnel.leases.delete(lease);
            return { ok: false, error: 'The VPN disconnected while starting. Try again.' };
        }
        return {
            ok: true,
            lease: {
                port: helper.port,
                proxyUri: helper.proxyUri,
                credentials: helper.credentials,
                attach(child) {
                    lease.child = child;
                    if (lease.released) {
                        killChild(child, 'a client whose VPN disconnected');
                        return;
                    }
                    child.once('exit', () => release(tunnel, lease));
                    child.once('error', () => release(tunnel, lease));
                },
                release: () => release(tunnel, lease)
            }
        };
    }

    // Starts the VPN (or uses the one already running), makes one HTTPS request through it and
    // reports the address the internet sees.
    async function test(vpnId, owner, request = traceThroughSocks) {
        const acquired = await acquire(vpnId, owner || 'a connection test');
        if (!acquired.ok) {
            return acquired;
        }
        try {
            const result = await request({ port: acquired.lease.port, ...acquired.lease.credentials });
            return { ok: true, ...result };
        } catch (err) {
            return { ok: false, error: 'The VPN started, but nothing came back through it (' + err.message + '). Check the config, or try another server from your provider.' };
        } finally {
            acquired.lease.release();
        }
    }

    // Stops every helper. With closeClients, the clients using them are closed too, since they
    // cannot play once their VPN is gone.
    function stopAll({ closeClients = false } = {}) {
        for (const tunnel of [...tunnels.values()]) {
            const clients = [...tunnel.leases].map((lease) => lease.child).filter(Boolean);
            stopTunnel(tunnel);
            if (closeClients) {
                for (const child of clients) {
                    killChild(child, 'a client using a VPN');
                }
            }
        }
        cleanRunDir(runDir);
    }

    function activeClientCount() {
        let count = 0;
        for (const tunnel of tunnels.values()) {
            for (const lease of tunnel.leases) {
                if (lease.child) {
                    count++;
                }
            }
        }
        return count;
    }

    return { acquire, test, stopAll, activeClientCount, tunnelCount: () => tunnels.size };
}

// ---- Test connection: one HTTPS request through the SOCKS5 port ----

function createReader(socket) {
    let buffer = Buffer.alloc(0);
    let waiting = null;
    let failure = null;
    function pump() {
        if (!waiting) {
            return;
        }
        if (buffer.length >= waiting.size) {
            const out = buffer.subarray(0, waiting.size);
            buffer = buffer.subarray(waiting.size);
            const { resolve } = waiting;
            waiting = null;
            resolve(out);
        } else if (failure) {
            const { reject } = waiting;
            waiting = null;
            reject(failure);
        }
    }
    const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        pump();
    };
    const onError = (err) => {
        failure = failure || err;
        pump();
    };
    const onClose = () => onError(new Error('the connection closed'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    return {
        read(size) {
            return new Promise((resolve, reject) => {
                waiting = { size, resolve, reject };
                pump();
            });
        },
        detach() {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
        }
    };
}

const SOCKS_ERRORS = {
    1: 'general failure',
    2: 'not allowed',
    3: 'network unreachable',
    4: 'host unreachable',
    5: 'connection refused',
    6: 'timed out',
    7: 'command not supported',
    8: 'address type not supported'
};

// Opens a TCP connection to host:port through a local SOCKS5 proxy with a user name and password.
// The host name is sent to the proxy, so the lookup happens at the far end of the VPN.
async function socksConnect({ port, username, password, host, targetPort, connect = net.connect, onSocket = () => {} }) {
    const socket = connect({ port, host: LOCALHOST });
    onSocket(socket);
    const reader = createReader(socket);
    try {
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.write(Buffer.from([5, 1, 2]));
        const choice = await reader.read(2);
        if (choice[0] !== 5 || choice[1] !== 2) {
            throw new Error('the proxy refused the sign-in method');
        }
        const user = Buffer.from(username);
        const pass = Buffer.from(password);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        const auth = await reader.read(2);
        if (auth[1] !== 0) {
            throw new Error('the proxy refused the sign-in');
        }
        const name = Buffer.from(host);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
        const head = await reader.read(4);
        if (head[1] !== 0) {
            throw new Error('the VPN could not reach ' + host + ' (' + (SOCKS_ERRORS[head[1]] || 'error ' + head[1]) + ')');
        }
        const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await reader.read(1))[0];
        await reader.read(addressLength + 2);
        reader.detach();
        return socket;
    } catch (err) {
        reader.detach();
        socket.destroy();
        throw err;
    }
}

// GET over the opened connection. HTTP/1.0, so the reply is never chunked.
function httpGet(socket, host, requestPath, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        socket.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                socket.destroy();
                reject(new Error('the reply was too long'));
                return;
            }
            chunks.push(chunk);
        });
        socket.once('error', reject);
        socket.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const split = text.indexOf('\r\n\r\n');
            const status = /^HTTP\/\d\.\d (\d{3})/.exec(text);
            if (!status || split < 0) {
                reject(new Error('the reply was not HTTP'));
                return;
            }
            resolve({ status: Number(status[1]), body: text.slice(split + 4) });
        });
        socket.write('GET ' + requestPath + ' HTTP/1.0\r\nHost: ' + host + '\r\nUser-Agent: ProjectXLauncher\r\nAccept: */*\r\nConnection: close\r\n\r\n');
    });
}

function countryName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || null;
    } catch (_) {
        return null;
    }
}

// Cloudflare's trace page: key=value lines, including ip and loc (the country code).
function parseTrace(body) {
    const values = {};
    for (const line of String(body).split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
    }
    const ip = net.isIP(values.ip || '') ? values.ip : null;
    const code = /^[A-Z]{2}$/.test(values.loc || '') && values.loc !== 'XX' ? values.loc : null;
    return { ip, countryCode: code, country: code ? countryName(code) : null };
}

const ECHO_ENDPOINTS = [
    { host: 'www.cloudflare.com', path: '/cdn-cgi/trace', parse: parseTrace },
    { host: 'api.ipify.org', path: '/', parse: (body) => ({ ip: net.isIP(body.trim()) ? body.trim() : null, countryCode: null, country: null }) }
];

async function requestOnce({ port, username, password, endpoint, timeoutMs, secure, connect, tlsConnect }) {
    let socket = null;
    let handle = null;
    const timer = new Promise((_, reject) => {
        handle = setTimeout(() => {
            if (socket) {
                socket.destroy();
            }
            const err = new Error('no answer within ' + Math.round(timeoutMs / 1000) + ' seconds');
            err.code = 'TIMEOUT';
            reject(err);
        }, timeoutMs);
    });
    const work = (async () => {
        const raw = await socksConnect({
            port,
            username,
            password,
            host: endpoint.host,
            targetPort: secure ? 443 : 80,
            connect,
            onSocket: (opened) => {
                socket = opened;
            }
        });
        if (secure) {
            socket = tlsConnect({ socket: raw, servername: endpoint.host });
            await new Promise((resolve, reject) => {
                socket.once('secureConnect', resolve);
                socket.once('error', reject);
            });
        }
        const reply = await httpGet(socket, endpoint.host, endpoint.path);
        socket.destroy();
        if (reply.status !== 200) {
            throw new Error(endpoint.host + ' answered HTTP ' + reply.status);
        }
        const parsed = endpoint.parse(reply.body);
        if (!parsed.ip) {
            throw new Error(endpoint.host + ' did not report an address');
        }
        return parsed;
    })();
    work.catch(() => {});
    try {
        return await Promise.race([work, timer]);
    } finally {
        clearTimeout(handle);
        if (socket) {
            socket.destroy();
        }
    }
}

// The exit address (and country, when known) as seen through the proxy.
async function traceThroughSocks({ port, username, password, timeoutMs = TEST_TIMEOUT_MS, endpoints = ECHO_ENDPOINTS, secure = true, connect = net.connect, tlsConnect = tls.connect }) {
    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            return await requestOnce({ port, username, password, endpoint, timeoutMs, secure, connect, tlsConnect });
        } catch (err) {
            lastError = err;
            // Silence means the tunnel carries nothing; another service would only wait as long.
            if (err.code === 'TIMEOUT') {
                break;
            }
        }
    }
    throw lastError || new Error('no address service answered');
}

module.exports = {
    READY_TIMEOUT_MS,
    HELPER_MISSING,
    helperTarget,
    helperFileName,
    findHelper,
    proxyUriFor,
    pickFreePort,
    waitForPort,
    createTail,
    helperEnv,
    cleanRunDir,
    startHelper,
    createVpnManager,
    socksConnect,
    parseTrace,
    traceThroughSocks
};
