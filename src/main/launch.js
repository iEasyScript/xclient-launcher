'use strict';

const fs = require('fs');
const { parseRam } = require('../shared/ram');
const { writeFileAtomic } = require('./fsutil');
const { redactProxy } = require('./redact');
const { readNonJagexProfile } = require('./profiles');

const JAVA_CHECK_TIMEOUT_MS = 5000;
const CREDENTIALS_MODE = 0o600;
const FALLBACK_HEAP = { xms: '512m', xmx: '600m', heapMb: 600 };
const MAC_OPENS = ['--add-opens=java.desktop/sun.awt=ALL-UNNAMED', '--add-opens=java.desktop/com.apple.eawt=ALL-UNNAMED'];

function isDebug(env) {
    return env.DEBUG !== undefined && env.DEBUG !== '';
}

// The --ram launcher argument, as "--ram 2g" or "--ram=2g".
function ramFromArgv(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--ram') {
            return typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
        }
        if (typeof arg === 'string' && arg.startsWith('--ram=')) {
            return arg.slice('--ram='.length) || null;
        }
    }
    return null;
}

// Built from the parsed number so "1.0g" and "01g" both become "1g". The JVM accepts only whole
// numbers, so a decimal such as 1.5g is passed as 1536m.
function heapValue(parsed) {
    return Number.isInteger(parsed.number) ? parsed.number + parsed.unit : Math.floor(parsed.mb) + 'm';
}

function resolveHeap(preference, cliRam, log) {
    const preferred = parseRam(preference);
    if (preferred) {
        const value = heapValue(preferred);
        return { xms: value, xmx: value, heapMb: Math.floor(preferred.mb), source: 'preference' };
    }
    if (preference !== undefined && preference !== null && preference !== '') {
        log.warn('Ignoring an invalid memory preference');
    }
    const fromCli = parseRam(cliRam);
    if (fromCli) {
        const value = heapValue(fromCli);
        return { xms: value, xmx: value, heapMb: Math.floor(fromCli.mb), source: 'command line' };
    }
    return { ...FALLBACK_HEAP, source: 'default' };
}

function softMaxHeapMb(heapMb) {
    return typeof heapMb === 'number' && heapMb > 0 ? Math.min(500, Math.floor(heapMb)) : 500;
}

// Turns the proxy field into the URI form the client accepts.
function buildProxyUri(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) {
        return null;
    }
    if (value.includes('://')) {
        return value;
    }
    const parts = value.split(':');
    if (parts.length === 2) {
        return 'socks5://' + parts[0] + ':' + parts[1];
    }
    if (parts.length >= 4) {
        const user = encodeURIComponent(parts[2]);
        const password = encodeURIComponent(parts.slice(3).join(':'));
        return 'socks5://' + user + ':' + password + '@' + parts[0] + ':' + parts[1];
    }
    return 'socks5://' + value;
}

function buildLaunchArgs({ platform, heap, jarPath, normal, proxyUri, profile }) {
    const args = [];
    if (platform === 'darwin') {
        args.push(...MAC_OPENS);
    }
    args.push('-Xms' + heap.xms, '-Xmx' + heap.xmx);
    args.push(
        '-XX:SoftMaxHeapSize=' + softMaxHeapMb(heap.heapMb) + 'm',
        '-XX:+UseZGC',
        '-XX:+ZUncommit',
        '-XX:ZUncommitDelay=30',
        '-XX:+UseStringDedup',
        '-Xss512k',
        '-XX:+IgnoreUnrecognizedVMOptions'
    );
    args.push('-jar', jarPath);
    if (normal) {
        args.push('-clean-jagex-launcher');
    }
    if (proxyUri) {
        args.push('-proxy=' + proxyUri);
    }
    if (profile) {
        args.push('-profile=' + profile);
    }
    return args;
}

// The game expects this name for a character that has never chosen one.
const UNNAMED_CHARACTER = 'Not set';

function characterName(character) {
    return typeof character.displayName === 'string' && character.displayName.trim() ? character.displayName : UNNAMED_CHARACTER;
}

// Inherited variables pass through unchanged unless this launch sets its own value. A launch
// without a preset clears any inherited one, so a client never acts on a stale preset.
function buildEnv(baseEnv, token, character, clientPreset) {
    const env = { ...baseEnv };
    delete env.PROJECTX_LAUNCH_PRESET;
    if (clientPreset) {
        env.PROJECTX_LAUNCH_PRESET = JSON.stringify(clientPreset);
    }
    if (token) {
        env.PROJECTX_ACCOUNT_TOKEN = token;
    }
    if (character && character.accountId && character.sessionId) {
        env.JX_CHARACTER_ID = String(character.accountId);
        env.JX_SESSION_ID = String(character.sessionId);
        env.JX_DISPLAY_NAME = characterName(character);
    }
    return env;
}

function oneLine(value) {
    return value === undefined || value === null ? '' : String(value).replace(/[\r\n]/g, '');
}

function credentialsText(character, date = new Date()) {
    return [
        '#Do not share this file with anyone',
        '#' + date.toString(),
        'JX_CHARACTER_ID=' + oneLine(character.accountId),
        'JX_SESSION_ID=' + oneLine(character.sessionId),
        'JX_REFRESH_TOKEN=',
        'JX_DISPLAY_NAME=' + oneLine(characterName(character)),
        'JX_ACCESS_TOKEN='
    ].join('\n') + '\n';
}

function javaDownloadUrl(platform, arch) {
    const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[platform];
    if (!os) {
        return 'https://adoptium.net/temurin/';
    }
    const cpu = arch === 'arm64' ? 'aarch64' : 'x64';
    return 'https://adoptium.net/temurin/releases/?os=' + os + '&arch=' + cpu + '&package=jdk&version=17&mode=filter';
}

// Java counts as installed only if "java -version" exits 0 within five seconds.
function checkJava(spawnFn, timeoutMs = JAVA_CHECK_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            }
        };
        let child;
        const timer = setTimeout(() => {
            try {
                child && child.kill();
            } catch (_) {
                // already gone
            }
            done(false);
        }, timeoutMs);
        try {
            child = spawnFn('java', ['-version'], { stdio: 'ignore', windowsHide: true });
        } catch (_) {
            done(false);
            return;
        }
        child.on('error', () => done(false));
        child.on('exit', (code) => done(code === 0));
    });
}

function createLauncher(deps) {
    const {
        paths,
        log,
        spawn,
        dialog,
        openExternal,
        readToken,
        accounts,
        presets = null,
        toClientPreset = null,
        running = null,
        env = process.env,
        argv = process.argv,
        platform = process.platform,
        arch = process.arch,
        now = () => new Date()
    } = deps;

    const debug = isDebug(env);

    async function promptForJava() {
        try {
            const { response } = await dialog.showMessageBox({
                type: 'error',
                title: 'Java Not Found',
                message: 'A Java Development Kit (JDK) is required to run Project X.',
                detail: 'Would you like to download it now?',
                buttons: ['Yes, Download JDK', 'Cancel'],
                defaultId: 0,
                cancelId: 1
            });
            if (response === 0) {
                await openExternal(javaDownloadUrl(platform, arch));
            }
        } catch (err) {
            log.warn('Could not show the Java prompt: ' + err.message);
        }
    }

    function spawnClient(args, childEnv) {
        const executable = platform === 'win32' ? 'javaw' : 'java';
        const child = spawn(executable, args, {
            detached: true,
            stdio: debug ? ['ignore', 'pipe', 'pipe'] : 'ignore',
            windowsHide: !debug,
            env: childEnv
        });
        child.on('error', (err) => {
            log.error('Error running jar: ' + err.message);
            try {
                dialog.showErrorBox('Error running jar!', err.message);
            } catch (_) {
                // no UI available
            }
        });
        child.on('exit', (code) => log.info('Client exited with code ' + code));
        if (debug) {
            for (const stream of [child.stdout, child.stderr]) {
                if (stream) {
                    stream.setEncoding('utf8');
                    stream.on('data', (text) => {
                        for (const line of text.split(/\r?\n/)) {
                            if (line) {
                                log.info('[client] ' + line);
                            }
                        }
                    });
                }
            }
        }
        child.unref();
        return child;
    }

    async function start({ version, ram, proxy, normal, character, profile, preset = null, label = null }) {
        const jarPath = paths.jarPath(version);
        if (!fs.existsSync(jarPath)) {
            return { ok: false, error: 'Client ' + version + ' is not installed.' };
        }
        if (character) {
            try {
                writeFileAtomic(paths.credentialsFile, credentialsText(character, now()), { mode: CREDENTIALS_MODE });
            } catch (err) {
                log.error('Could not write credentials.properties: ' + err.message);
                return { ok: false, error: 'Could not write the Jagex login for the client: ' + err.message };
            }
        }
        const heap = resolveHeap(ram, ramFromArgv(argv), log);
        log.info('Client memory from ' + heap.source + ': ' + heap.xmx);
        const proxyUri = buildProxyUri(proxy);
        const args = buildLaunchArgs({ platform, heap, jarPath, normal, proxyUri, profile });

        const javaFound = await checkJava(spawn);
        log.info('Java check: ' + (javaFound ? 'found' : 'not found'));
        if (!javaFound) {
            await promptForJava();
            return { ok: false, silent: true, error: 'Java was not found.' };
        }

        const token = readToken();
        if (token) {
            log.info('Launching client signed in to Project X');
        }
        const printable = args.map((arg) => (arg.startsWith('-proxy=') ? '-proxy=' + redactProxy(proxyUri) : arg));
        log.info('Launching: ' + (platform === 'win32' ? 'javaw ' : 'java ') + printable.join(' '));
        const clientPreset = preset && toClientPreset ? toClientPreset(preset) : null;
        if (clientPreset) {
            log.info('Launch preset "' + clientPreset.name + '": ' + (clientPreset.startAfterLogin ? 'starts ' + clientPreset.script : 'no script to start'));
        }
        try {
            const child = spawnClient(args, buildEnv(env, token, character, clientPreset));
            if (running) {
                running.add(child, {
                    label: label || (character ? characterName(character) : 'Normal account'),
                    accountId: character ? String(character.accountId) : null,
                    presetName: preset ? preset.name : null,
                    scriptName: preset && preset.script ? preset.scriptName || preset.script : null
                });
            }
        } catch (err) {
            log.error('Error running jar: ' + err.message);
            dialog.showErrorBox('Error running jar!', err.message);
            return { ok: false, silent: true, error: err.message };
        }
        return { ok: true };
    }

    // An account's preset, if it has one; its memory, proxy and settings profile take the place of
    // the launcher-wide ones wherever the preset sets them.
    function presetFor(accountId) {
        if (!presets) {
            return null;
        }
        try {
            return presets.forAccount(accountId);
        } catch (err) {
            log.warn('Could not read the launch preset: ' + err.message);
            return null;
        }
    }

    async function launchJagex({ accountId, version, ram, proxy, label }) {
        const character = accounts.findById(accountId);
        if (!character) {
            return { ok: false, error: 'That Jagex account could not be found. Pick an account and try again.' };
        }
        if (!character.sessionId) {
            return { ok: false, error: 'That Jagex account has no saved sign-in. Use "Add Accounts" to sign in again.' };
        }
        const preset = presetFor(accountId);
        const savedProfile = typeof character.profile === 'string' && character.profile ? character.profile : null;
        const presetProfile = preset && preset.profile && preset.profile !== 'default' ? preset.profile : null;
        return start({
            version,
            ram: preset && preset.ram ? preset.ram : ram,
            proxy: preset && preset.proxy ? preset.proxy : proxy,
            normal: false,
            character,
            profile: presetProfile || savedProfile,
            preset,
            label
        });
    }

    async function launchNormal({ version, ram, proxy }) {
        const saved = readNonJagexProfile(paths.nonJagexProfileFile, log);
        const profile = saved && saved !== 'default' ? saved : null;
        return start({ version, ram, proxy, normal: true, character: null, profile });
    }

    return { launchJagex, launchNormal };
}

module.exports = {
    FALLBACK_HEAP,
    UNNAMED_CHARACTER,
    heapValue,
    MAC_OPENS,
    isDebug,
    ramFromArgv,
    resolveHeap,
    softMaxHeapMb,
    buildProxyUri,
    buildLaunchArgs,
    buildEnv,
    credentialsText,
    javaDownloadUrl,
    checkJava,
    createLauncher
};
