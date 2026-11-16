'use strict';

const { EventEmitter } = require('events');
const { javaCandidates, parseMajor, probeJava, windowedCommand, findJava } = require('../src/main/java-finder');

// A fake filesystem: a set of existing files and a map of folder -> subfolder names.
function fakeFs(files, dirs = {}) {
    const lower = new Set(files.map((f) => f.toLowerCase()));
    return {
        existsSync: (file) => lower.has(String(file).toLowerCase()),
        readdirSync: (dir) => {
            const names = dirs[dir];
            if (!names) {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
            return names.map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false }));
        }
    };
}

// A fake spawn: behaviour(command) returns { code, stderr } or 'hang' or 'error'.
function fakeSpawn(behaviour) {
    const calls = [];
    const spawn = jest.fn((command) => {
        calls.push(command);
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stderr.setEncoding = () => {};
        child.kill = jest.fn();
        const result = behaviour(command);
        setImmediate(() => {
            if (result === 'hang') {
                return;
            }
            if (result === 'error') {
                child.emit('error', new Error('ENOENT'));
                return;
            }
            if (result.stderr) {
                child.stderr.emit('data', result.stderr);
            }
            child.emit('exit', result.code);
        });
        return child;
    });
    spawn.calls = calls;
    return spawn;
}

const WIN_ENV = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\p'
};

describe('parseMajor', () => {
    test('reads modern and 1.x version strings', () => {
        expect(parseMajor('java version "17.0.12" 2024-07-16 LTS')).toBe(17);
        expect(parseMajor('openjdk version "21" 2023-09-19')).toBe(21);
        expect(parseMajor('java version "1.8.0_401"')).toBe(8);
        expect(parseMajor('nonsense')).toBeNull();
        expect(parseMajor(undefined)).toBeNull();
    });
});

describe('javaCandidates', () => {
    test('PATH first, then JAVA_HOME, then install folders that exist, newest folder first', () => {
        const fs = fakeFs([
            'C:\\jdk17\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
            'C:\\Program Files\\Java\\jre1.8.0_401\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe',
            'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe'
        ], {
            'C:\\Program Files\\Java': ['jdk-17', 'jre1.8.0_401', 'empty-folder'],
            'C:\\Program Files\\Eclipse Adoptium': ['jdk-21.0.4.7-hotspot']
        });
        const list = javaCandidates({ platform: 'win32', env: { ...WIN_ENV, JAVA_HOME: 'C:\\jdk17' }, fs }).map((c) => c.command);
        expect(list[0]).toBe('java');
        expect(list[1]).toBe('C:\\jdk17\\bin\\java.exe');
        expect(list).toContain('C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe');
        expect(list).toContain('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe');
        expect(list.indexOf('C:\\Program Files\\Java\\jre1.8.0_401\\bin\\java.exe')).toBeLessThan(list.indexOf('C:\\Program Files\\Java\\jdk-17\\bin\\java.exe'));
        expect(list.some((c) => c.includes('empty-folder'))).toBe(false);
    });

    test('a JAVA_HOME that also sits in an install folder is listed once', () => {
        const file = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
        const fs = fakeFs([file], { 'C:\\Program Files\\Java': ['jdk-17'] });
        const list = javaCandidates({ platform: 'win32', env: { ...WIN_ENV, JAVA_HOME: 'C:\\Program Files\\Java\\jdk-17' }, fs });
        expect(list.filter((c) => c.command.toLowerCase() === file.toLowerCase())).toHaveLength(1);
    });
});

describe('windowedCommand', () => {
    test('uses javaw next to java on Windows when it exists', () => {
        const fs = fakeFs(['C:\\jdk\\bin\\javaw.exe']);
        expect(windowedCommand('C:\\jdk\\bin\\java.exe', 'win32', fs)).toBe('C:\\jdk\\bin\\javaw.exe');
        expect(windowedCommand('C:\\other\\bin\\java.exe', 'win32', fs)).toBe('C:\\other\\bin\\java.exe');
        expect(windowedCommand('java', 'win32', fs)).toBe('javaw');
        expect(windowedCommand('/usr/bin/java', 'linux', fs)).toBe('/usr/bin/java');
    });
});

describe('findJava', () => {
    test('uses java on PATH when it runs and is new enough', async () => {
        const spawn = fakeSpawn(() => ({ code: 0, stderr: 'java version "17.0.12"' }));
        const found = await findJava({ spawn, platform: 'win32', env: WIN_ENV, fs: fakeFs([]) });
        expect(found).toMatchObject({ found: true, command: 'java', windowed: 'javaw', major: 17, source: 'PATH' });
        expect(spawn.calls).toEqual(['java']);
    });

    test('falls back to JAVA_HOME when java is not on the launcher PATH', async () => {
        const javaHome = 'C:\\Program Files\\Java\\jdk-17';
        const fs = fakeFs([javaHome + '\\bin\\java.exe', javaHome + '\\bin\\javaw.exe']);
        const spawn = fakeSpawn((command) => (command === 'java' ? 'error' : { code: 0, stderr: 'java version "17.0.12"' }));
        const found = await findJava({ spawn, platform: 'win32', env: { ...WIN_ENV, JAVA_HOME: javaHome }, fs });
        expect(found).toMatchObject({ found: true, command: javaHome + '\\bin\\java.exe', windowed: javaHome + '\\bin\\javaw.exe', source: 'JAVA_HOME' });
    });

    test('skips a Java that is too old and reports it when nothing newer exists', async () => {
        const spawn = fakeSpawn(() => ({ code: 0, stderr: 'java version "1.8.0_401"' }));
        await expect(findJava({ spawn, platform: 'win32', env: WIN_ENV, fs: fakeFs([]) })).resolves.toEqual({ found: false, olderMajor: 8 });
    });

    test('an old Java on PATH does not hide a new one in an install folder', async () => {
        const jdk = 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.12.7-hotspot\\bin\\java.exe';
        const fs = fakeFs([jdk], { 'C:\\Program Files\\Eclipse Adoptium': ['jdk-17.0.12.7-hotspot'] });
        const spawn = fakeSpawn((command) => ({ code: 0, stderr: command === 'java' ? 'java version "1.8.0_401"' : 'openjdk version "17.0.12"' }));
        const found = await findJava({ spawn, platform: 'win32', env: WIN_ENV, fs });
        expect(found).toMatchObject({ found: true, command: jdk, major: 17 });
    });

    test('a java whose version cannot be read is still used', async () => {
        const spawn = fakeSpawn(() => ({ code: 0 }));
        await expect(findJava({ spawn, platform: 'linux', env: {}, fs: fakeFs([]) })).resolves.toMatchObject({ found: true, command: 'java', major: null });
    });

    test('nothing found', async () => {
        const spawn = fakeSpawn(() => 'error');
        await expect(findJava({ spawn, platform: 'win32', env: WIN_ENV, fs: fakeFs([]) })).resolves.toEqual({ found: false, olderMajor: null });
    });
});

describe('probeJava', () => {
    test('a check that never answers is killed after the timeout', async () => {
        const spawn = fakeSpawn(() => 'hang');
        await expect(probeJava(spawn, 'java', 20)).resolves.toEqual({ ok: false, major: null });
    });
});
