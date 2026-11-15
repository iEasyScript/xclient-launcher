'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    buildLaunchArgs,
    buildProxyUri,
    buildEnv,
    credentialsText,
    javaDownloadUrl,
    checkJava,
    createLauncher
} = require('../src/main/launch');
const { redactProxy } = require('../src/main/redact');
const { createPaths } = require('../src/main/paths');
const { createAccountsStore } = require('../src/main/jagex/accounts');
const { makeTempDir, cleanupTempDirs, makeLog, writeJsonFile } = require('./helpers');

afterEach(cleanupTempDirs);

const GC = [
    '-XX:SoftMaxHeapSize=500m',
    '-XX:+UseZGC',
    '-XX:+ZUncommit',
    '-XX:ZUncommitDelay=30',
    '-XX:+UseStringDedup',
    '-Xss512k',
    '-XX:+IgnoreUnrecognizedVMOptions'
];
const HEAP_2G = { xms: '2g', xmx: '2g', heapMb: 2048 };

describe('launch arguments', () => {
    test('Jagex launch with proxy and profile, in the exact order', () => {
        const args = buildLaunchArgs({
            platform: 'win32',
            heap: HEAP_2G,
            jarPath: 'C:\\Users\\Ana\\.projectx\\projectx-2.0.0.jar',
            normal: false,
            proxyUri: 'socks5://bob:p%40ss@203.0.113.7:1080',
            profile: 'Woodcutting alt'
        });
        expect(args).toEqual([
            '-Xms2g', '-Xmx2g', ...GC,
            '-jar', 'C:\\Users\\Ana\\.projectx\\projectx-2.0.0.jar',
            '-proxy=socks5://bob:p%40ss@203.0.113.7:1080',
            '-profile=Woodcutting alt'
        ]);
    });

    test('normal launch adds -clean-jagex-launcher before the proxy', () => {
        const args = buildLaunchArgs({ platform: 'linux', heap: HEAP_2G, jarPath: '/j.jar', normal: true, proxyUri: 'socks5://h:1', profile: null });
        expect(args).toEqual(['-Xms2g', '-Xmx2g', ...GC, '-jar', '/j.jar', '-clean-jagex-launcher', '-proxy=socks5://h:1']);
    });

    test('macOS puts the add-opens flags first', () => {
        const args = buildLaunchArgs({ platform: 'darwin', heap: HEAP_2G, jarPath: '/j.jar', normal: false, proxyUri: null, profile: null });
        expect(args.slice(0, 3)).toEqual([
            '--add-opens=java.desktop/sun.awt=ALL-UNNAMED',
            '--add-opens=java.desktop/com.apple.eawt=ALL-UNNAMED',
            '-Xms2g'
        ]);
        expect(args.slice(-2)).toEqual(['-jar', '/j.jar']);
    });

    test('the fallback heap keeps SoftMaxHeapSize under -Xmx', () => {
        const args = buildLaunchArgs({ platform: 'linux', heap: { xms: '512m', xmx: '600m', heapMb: 600 }, jarPath: '/j.jar', normal: true });
        expect(args.slice(0, 3)).toEqual(['-Xms512m', '-Xmx600m', '-XX:SoftMaxHeapSize=500m']);
    });
});

describe('proxy conversion', () => {
    test.each([
        ['', null],
        ['   ', null],
        ['203.0.113.7:1080', 'socks5://203.0.113.7:1080'],
        ['host:1080:bob:p@ss', 'socks5://bob:p%40ss@host:1080'],
        ['host:1080:bob:pa:ss:word', 'socks5://bob:pa%3Ass%3Aword@host:1080'],
        ['socks5://user:pass@host:1080', 'socks5://user:pass@host:1080'],
        ['socks4://host:1080', 'socks4://host:1080'],
        ['justahost', 'socks5://justahost'],
        ['a:b:c', 'socks5://a:b:c'],
        [' host:1080 ', 'socks5://host:1080']
    ])('%p becomes %p', (input, expected) => {
        expect(buildProxyUri(input)).toBe(expected);
    });

    test('log redaction hides user and password', () => {
        expect(redactProxy('socks5://bob:p%40ss@203.0.113.7:1080')).toBe('socks5://***:***@203.0.113.7:1080');
        expect(redactProxy('socks5://203.0.113.7:1080')).toBe('socks5://203.0.113.7:1080');
    });

    test('log redaction works on unparsable URIs', () => {
        const redacted = redactProxy('socks5://bob:se cret@[bad host:1080');
        expect(redacted).not.toContain('bob');
        expect(redacted).not.toContain('se cret');
        expect(redacted).toContain('***@');
    });
});

describe('child environment', () => {
    const base = { PATH: '/bin', HOME: '/home/x' };

    test('token and JX variables for a Jagex character', () => {
        const env = buildEnv(base, 'px_testtoken', { accountId: '418273645', sessionId: 'sess-fake', displayName: 'Iron Wick' });
        expect(env).toMatchObject({
            PATH: '/bin',
            PROJECTX_ACCOUNT_TOKEN: 'px_testtoken',
            JX_CHARACTER_ID: '418273645',
            JX_SESSION_ID: 'sess-fake',
            JX_DISPLAY_NAME: 'Iron Wick'
        });
    });

    test('no JX variables without a session id; "Not set" when the character has no name', () => {
        expect(buildEnv(base, null, { accountId: '1' })).not.toHaveProperty('JX_SESSION_ID');
        expect(buildEnv(base, null, { accountId: '1', sessionId: 's' }).JX_DISPLAY_NAME).toBe('Not set');
        expect(buildEnv(base, null, { accountId: '1', sessionId: 's', displayName: '  ' }).JX_DISPLAY_NAME).toBe('Not set');
    });

    test('no token variable is added when signed out', () => {
        expect(buildEnv(base, null, null)).not.toHaveProperty('PROJECTX_ACCOUNT_TOKEN');
    });

    test('inherited variables pass through unless this launch sets its own', () => {
        const inherited = { ...base, PROJECTX_ACCOUNT_TOKEN: 'px_inherited', JX_CHARACTER_ID: '9', JX_SESSION_ID: 'sess-inherited', JX_DISPLAY_NAME: 'Inherited' };
        expect(buildEnv(inherited, null, null)).toMatchObject({
            PROJECTX_ACCOUNT_TOKEN: 'px_inherited', JX_CHARACTER_ID: '9', JX_SESSION_ID: 'sess-inherited', JX_DISPLAY_NAME: 'Inherited'
        });
        expect(buildEnv(inherited, 'px_own', { accountId: '1', sessionId: 'sess-own', displayName: 'Own' })).toMatchObject({
            PROJECTX_ACCOUNT_TOKEN: 'px_own', JX_CHARACTER_ID: '1', JX_SESSION_ID: 'sess-own', JX_DISPLAY_NAME: 'Own'
        });
        expect(inherited.PROJECTX_ACCOUNT_TOKEN).toBe('px_inherited');
    });
});

describe('credentials file', () => {
    test('exact seven-line layout with LF endings and a final newline', () => {
        const text = credentialsText({ accountId: '418273645', sessionId: 'sess-fake', displayName: 'Iron Wick' }, new Date(2026, 10, 15, 14, 55, 7));
        const lines = text.split('\n');
        expect(text.endsWith('\n')).toBe(true);
        expect(text).not.toContain('\r');
        expect(lines).toHaveLength(8);
        expect(lines[0]).toBe('#Do not share this file with anyone');
        expect(lines[1].startsWith('#')).toBe(true);
        expect(lines.slice(2, 7)).toEqual([
            'JX_CHARACTER_ID=418273645',
            'JX_SESSION_ID=sess-fake',
            'JX_REFRESH_TOKEN=',
            'JX_DISPLAY_NAME=Iron Wick',
            'JX_ACCESS_TOKEN='
        ]);
    });

    test('a missing display name is written as Not set', () => {
        expect(credentialsText({ accountId: '1', sessionId: 's', displayName: null }).split('\n')[5]).toBe('JX_DISPLAY_NAME=Not set');
    });
});

describe('Java', () => {
    function fakeSpawn(behaviour) {
        return jest.fn(() => {
            const child = new EventEmitter();
            child.kill = jest.fn();
            setImmediate(() => behaviour(child));
            return child;
        });
    }

    test('found when java -version exits 0', async () => {
        await expect(checkJava(fakeSpawn((child) => child.emit('exit', 0)))).resolves.toBe(true);
    });

    test('missing on a non-zero exit or a spawn error', async () => {
        await expect(checkJava(fakeSpawn((child) => child.emit('exit', 1)))).resolves.toBe(false);
        await expect(checkJava(fakeSpawn((child) => child.emit('error', new Error('ENOENT'))))).resolves.toBe(false);
    });

    test('missing after the timeout, and the check is killed', async () => {
        let spawned;
        const spawn = jest.fn(() => {
            spawned = new EventEmitter();
            spawned.kill = jest.fn();
            return spawned;
        });
        await expect(checkJava(spawn, 20)).resolves.toBe(false);
        expect(spawned.kill).toHaveBeenCalled();
    });

    test('download page for each platform', () => {
        expect(javaDownloadUrl('win32', 'x64')).toBe('https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk&version=17&mode=filter');
        expect(javaDownloadUrl('darwin', 'arm64')).toBe('https://adoptium.net/temurin/releases/?os=mac&arch=aarch64&package=jdk&version=17&mode=filter');
        expect(javaDownloadUrl('linux', 'x64')).toContain('os=linux&arch=x64');
        expect(javaDownloadUrl('freebsd', 'x64')).toBe('https://adoptium.net/temurin/');
    });
});

describe('launcher', () => {
    function setup({ platform = 'win32', javaExit = 0, token = 'px_faketoken123', env = {} } = {}) {
        const home = makeTempDir();
        const paths = createPaths(home);
        fs.mkdirSync(paths.projectxDir, { recursive: true });
        fs.writeFileSync(paths.jarPath('2.0.0'), 'jar');
        writeJsonFile(paths.accountsFile, [
            { accountId: '111', displayName: 'Iron Wick', sessionId: 'sess-one', createdOn: '2026-01-01T00:00:00.000Z', profile: 'default' },
            { accountId: '222', displayName: 'Bank Alt', sessionId: 'sess-two', createdOn: '2026-01-02T00:00:00.000Z' }
        ]);
        const log = makeLog();
        const events = [];
        let currentToken = token;
        const spawn = jest.fn((command, args, options) => {
            const child = new EventEmitter();
            child.unref = jest.fn();
            child.kill = jest.fn();
            if (args[0] === '-version') {
                events.push('java-check');
                setImmediate(() => child.emit('exit', javaExit));
            } else {
                const creds = fs.existsSync(paths.credentialsFile) ? fs.readFileSync(paths.credentialsFile, 'utf8') : '';
                events.push({ command, args, options, creds });
            }
            return child;
        });
        const dialog = {
            showMessageBox: jest.fn(async () => ({ response: 1 })),
            showErrorBox: jest.fn()
        };
        const openExternal = jest.fn(async () => {});
        const accounts = createAccountsStore({ file: paths.accountsFile, fetch: jest.fn(), log });
        const launcher = createLauncher({
            paths,
            log,
            spawn,
            dialog,
            openExternal,
            readToken: () => currentToken,
            accounts,
            env: { PATH: '/bin', ...env },
            argv: ['electron', '.'],
            platform,
            arch: 'x64'
        });
        return { paths, log, spawn, events, dialog, openExternal, launcher, setToken: (value) => { currentToken = value; } };
    }

    const clientLaunches = (events) => events.filter((event) => typeof event === 'object');

    test('Jagex launch writes credentials before spawning javaw detached with the env', async () => {
        const { launcher, events, paths, log } = setup();
        const result = await launcher.launchJagex({ accountId: '111', version: '2.0.0', ram: '2g', proxy: 'host:1080:bob:secretpw' });
        expect(result).toEqual({ ok: true });
        const [launch] = clientLaunches(events);
        expect(launch.command).toBe('javaw');
        expect(launch.creds).toContain('JX_CHARACTER_ID=111');
        expect(launch.creds).toContain('JX_SESSION_ID=sess-one');
        expect(launch.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
        expect(launch.options.env).toMatchObject({ PROJECTX_ACCOUNT_TOKEN: 'px_faketoken123', JX_CHARACTER_ID: '111', JX_SESSION_ID: 'sess-one', JX_DISPLAY_NAME: 'Iron Wick' });
        expect(launch.args).toContain('-profile=default');
        expect(launch.args).toContain('-proxy=socks5://bob:secretpw@host:1080');
        expect(launch.args.join(' ')).not.toContain('px_faketoken123');
        expect(fs.readFileSync(paths.credentialsFile, 'utf8')).toContain('JX_DISPLAY_NAME=Iron Wick');
        const logged = log.all();
        expect(logged).not.toContain('px_faketoken123');
        expect(logged).not.toContain('sess-one');
        expect(logged).not.toContain('secretpw');
        expect(logged).not.toContain('bob');
        expect(logged).toContain('signed in to Project X');
    });

    test('java elsewhere; no profile argument when the character has none', async () => {
        const { launcher, events } = setup({ platform: 'linux' });
        await launcher.launchJagex({ accountId: '222', version: '2.0.0', ram: '1g' });
        const [launch] = clientLaunches(events);
        expect(launch.command).toBe('java');
        expect(launch.args.some((arg) => arg.startsWith('-profile='))).toBe(false);
    });

    test('the token is read fresh at each launch and absent when signed out', async () => {
        const { launcher, events, setToken } = setup();
        await launcher.launchNormal({ version: '2.0.0', ram: '1g' });
        setToken(null);
        await launcher.launchNormal({ version: '2.0.0', ram: '1g' });
        const [first, second] = clientLaunches(events);
        expect(first.options.env.PROJECTX_ACCOUNT_TOKEN).toBe('px_faketoken123');
        expect(second.options.env).not.toHaveProperty('PROJECTX_ACCOUNT_TOKEN');
    });

    test('normal launch: no JX env, clean flag, profile only when not default', async () => {
        const { launcher, events, paths } = setup();
        writeJsonFile(paths.nonJagexProfileFile, { profile: 'default' });
        await launcher.launchNormal({ version: '2.0.0', ram: '1g' });
        writeJsonFile(paths.nonJagexProfileFile, { profile: 'Woodcutting alt' });
        await launcher.launchNormal({ version: '2.0.0', ram: '1g' });
        const [first, second] = clientLaunches(events);
        expect(first.args).toContain('-clean-jagex-launcher');
        expect(first.args.some((arg) => arg.startsWith('-profile='))).toBe(false);
        expect(first.options.env).not.toHaveProperty('JX_SESSION_ID');
        expect(second.args[second.args.length - 1]).toBe('-profile=Woodcutting alt');
        expect(fs.existsSync(paths.credentialsFile)).toBe(false);
    });

    test('missing Java shows the JDK prompt and spawns nothing', async () => {
        const { launcher, events, dialog, openExternal } = setup({ javaExit: 1 });
        dialog.showMessageBox.mockResolvedValue({ response: 0 });
        const result = await launcher.launchJagex({ accountId: '111', version: '2.0.0', ram: '1g' });
        expect(result).toMatchObject({ ok: false, silent: true });
        expect(clientLaunches(events)).toHaveLength(0);
        expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'Java Not Found', buttons: ['Yes, Download JDK', 'Cancel'] }));
        expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('adoptium.net'));
    });

    test('debug pipes output and does not hide the window', async () => {
        const { launcher, events } = setup({ env: { DEBUG: '1' } });
        await launcher.launchNormal({ version: '2.0.0', ram: '1g' });
        const [launch] = clientLaunches(events);
        expect(launch.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        expect(launch.options.windowsHide).toBe(false);
    });

    test('an unknown character or missing jar is refused', async () => {
        const { launcher } = setup();
        await expect(launcher.launchJagex({ accountId: '999', version: '2.0.0' })).resolves.toMatchObject({ ok: false });
        await expect(launcher.launchNormal({ version: '9.9.9' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not installed') });
    });

    test('credentials file is private on POSIX systems', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const { launcher, paths } = setup({ platform: 'linux' });
        await launcher.launchJagex({ accountId: '111', version: '2.0.0' });
        expect(fs.statSync(paths.credentialsFile).mode & 0o777).toBe(0o600);
    });

    test('jar path is inside ~/.projectx', async () => {
        const { launcher, events, paths } = setup();
        await launcher.launchNormal({ version: '2.0.0' });
        const [launch] = clientLaunches(events);
        expect(launch.args[launch.args.indexOf('-jar') + 1]).toBe(path.join(paths.projectxDir, 'projectx-2.0.0.jar'));
    });
});
