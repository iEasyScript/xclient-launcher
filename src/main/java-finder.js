'use strict';

const nodeFs = require('fs');
const path = require('path');

// Finding a Java the client can run on. "java" on PATH comes first, as before. When that is
// missing or too old, JAVA_HOME and the usual install folders are tried, because the launcher
// can hold an older PATH than a fresh command prompt (Java installed or PATH changed after it,
// or Explorer, started).

const MIN_MAJOR = 17;
const PROBE_TIMEOUT_MS = 15000;
const MAX_OUTPUT = 4096;

// Folders that hold one Java per subfolder, e.g. C:\Program Files\Java\jdk-17\bin\java.exe.
function windowsRoots(env) {
    const programFiles = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
    const roots = [];
    for (const base of programFiles) {
        for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'OpenJDK']) {
            roots.push(path.win32.join(base, vendor));
        }
    }
    if (env.LOCALAPPDATA) {
        roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'));
    }
    if (env.USERPROFILE) {
        roots.push(path.win32.join(env.USERPROFILE, '.jdks'));
    }
    return roots;
}

// Folders whose bin holds java directly (Oracle's javapath links).
function windowsDirect(env) {
    const out = [];
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.CommonProgramFiles, env['CommonProgramFiles(x86)']].filter(Boolean)) {
        if (/Common Files$/i.test(base)) {
            out.push(path.win32.join(base, 'Oracle', 'Java', 'javapath'));
        } else {
            out.push(path.win32.join(base, 'Common Files', 'Oracle', 'Java', 'javapath'));
        }
    }
    if (env.ProgramData) {
        out.push(path.win32.join(env.ProgramData, 'Oracle', 'Java', 'javapath'));
    }
    return out;
}

// Highest version first: jdk-21 before jdk-8, so the likeliest Java is tried first.
function newestFirst(names) {
    return names.slice().sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

function listDirs(fs, dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => entry.name);
    } catch (_) {
        return [];
    }
}

// Every Java executable worth trying, best guesses first, without duplicates. Only paths that
// exist are listed; "java" on PATH is always first.
function javaCandidates({ platform, env, fs = nodeFs }) {
    const win = platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const exe = win ? 'java.exe' : 'java';
    const seen = new Set();
    const out = [];
    const add = (command, source) => {
        const key = win ? command.toLowerCase() : command;
        if (!seen.has(key)) {
            seen.add(key);
            out.push({ command, source });
        }
    };
    const addIfFile = (file, source) => {
        try {
            if (fs.existsSync(file)) {
                add(file, source);
            }
        } catch (_) {
            // unreadable: skip it
        }
    };

    add('java', 'PATH');
    if (env.JAVA_HOME) {
        addIfFile(p.join(env.JAVA_HOME, 'bin', exe), 'JAVA_HOME');
    }
    if (win) {
        for (const root of windowsRoots(env)) {
            for (const name of newestFirst(listDirs(fs, root))) {
                addIfFile(p.join(root, name, 'bin', exe), root);
            }
        }
        for (const dir of windowsDirect(env)) {
            addIfFile(p.join(dir, exe), dir);
        }
    } else if (platform === 'darwin') {
        const root = '/Library/Java/JavaVirtualMachines';
        for (const name of newestFirst(listDirs(fs, root))) {
            addIfFile(p.join(root, name, 'Contents', 'Home', 'bin', 'java'), root);
        }
        addIfFile('/opt/homebrew/opt/openjdk/bin/java', 'Homebrew');
        addIfFile('/usr/local/opt/openjdk/bin/java', 'Homebrew');
    } else {
        for (const root of ['/usr/lib/jvm', '/usr/java', '/opt/java']) {
            for (const name of newestFirst(listDirs(fs, root))) {
                addIfFile(p.join(root, name, 'bin', 'java'), root);
            }
        }
    }
    return out;
}

// The major version from "java -version" output: 'version "17.0.12"' is 17, '"1.8.0_401"' is 8.
function parseMajor(text) {
    const match = /version "(\d+)(?:\.(\d+))?/.exec(typeof text === 'string' ? text : '');
    if (!match) {
        return null;
    }
    const first = Number(match[1]);
    return first === 1 && match[2] !== undefined ? Number(match[2]) : first;
}

// Runs "<command> -version". Resolves { ok, major } and never rejects.
function probeJava(spawnFn, command, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let output = '';
        let child;
        const done = (ok) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ ok, major: ok ? parseMajor(output) : null });
            }
        };
        const timer = setTimeout(() => {
            try {
                child && child.kill();
            } catch (_) {
                // already gone
            }
            done(false);
        }, timeoutMs);
        try {
            child = spawnFn(command, ['-version'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (_) {
            done(false);
            return;
        }
        if (child.stderr && typeof child.stderr.on === 'function') {
            child.stderr.setEncoding && child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                if (output.length < MAX_OUTPUT) {
                    output += String(chunk);
                }
            });
        }
        child.on('error', () => done(false));
        child.on('exit', (code) => done(code === 0));
    });
}

// The windowed launcher next to a java executable: javaw.exe on Windows when it is there.
function windowedCommand(command, platform, fs = nodeFs) {
    if (platform !== 'win32') {
        return command;
    }
    if (command === 'java') {
        return 'javaw';
    }
    const javaw = path.win32.join(path.win32.dirname(command), 'javaw.exe');
    try {
        return fs.existsSync(javaw) ? javaw : command;
    } catch (_) {
        return command;
    }
}

// Tries the candidates in order and returns the first that runs and is new enough.
// { found: true, command, windowed, major, source } or { found: false, olderMajor }.
async function findJava({ spawn, platform, env, fs = nodeFs, log, timeoutMs = PROBE_TIMEOUT_MS, minMajor = MIN_MAJOR }) {
    let olderMajor = null;
    for (const candidate of javaCandidates({ platform, env, fs })) {
        const result = await probeJava(spawn, candidate.command, timeoutMs);
        if (!result.ok) {
            if (log && candidate.source !== 'PATH') {
                log.info('Java at ' + candidate.source + ' did not run');
            }
            continue;
        }
        if (result.major !== null && result.major < minMajor) {
            olderMajor = olderMajor === null ? result.major : Math.max(olderMajor, result.major);
            if (log) {
                log.info('Skipping Java ' + result.major + ' from ' + candidate.source + ': ' + minMajor + ' or newer is needed');
            }
            continue;
        }
        return {
            found: true,
            command: candidate.command,
            windowed: windowedCommand(candidate.command, platform, fs),
            major: result.major,
            source: candidate.source
        };
    }
    return { found: false, olderMajor };
}

module.exports = { MIN_MAJOR, PROBE_TIMEOUT_MS, javaCandidates, parseMajor, probeJava, windowedCommand, findJava };
