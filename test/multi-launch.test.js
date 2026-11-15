'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const { createMultiLauncher, sanitizeGap, summary } = require('../src/shared/multi-launch');
const { createLauncher } = require('../src/main/launch');
const { createPaths } = require('../src/main/paths');
const { createAccountsStore } = require('../src/main/jagex/accounts');
const { makeTempDir, cleanupTempDirs, makeLog, writeJsonFile } = require('./helpers');

afterEach(cleanupTempDirs);

const characters = [
    { accountId: '1', label: 'One' },
    { accountId: '2', label: 'Two' },
    { accountId: '3', label: 'Three' }
];

function deps(overrides = {}) {
    const statuses = [];
    const logs = [];
    const order = [];
    return {
        statuses,
        logs,
        order,
        prepare: jest.fn(async () => '2.0.0'),
        launchOne: jest.fn(async (id) => {
            order.push('launch ' + id);
            return { ok: true };
        }),
        sleep: jest.fn(async () => order.push('sleep')),
        onStatus: (text) => statuses.push(text),
        log: (level, message) => logs.push({ level, message }),
        ...overrides
    };
}

test('gap choices fall back to 25', () => {
    expect(sanitizeGap(15)).toBe(15);
    expect(sanitizeGap('60')).toBe(60);
    expect(sanitizeGap(5)).toBe(25);
    expect(sanitizeGap(undefined)).toBe(25);
});

test('runs in order with a counted-down gap between launches, not after the last', async () => {
    const d = deps();
    const result = await createMultiLauncher(d).run(characters, 15);
    expect(result).toEqual({ started: true, count: 3, total: 3 });
    expect(d.order.filter((item) => item === 'sleep')).toHaveLength(30);
    expect(d.order[0]).toBe('launch 1');
    expect(d.order[16]).toBe('launch 2');
    expect(d.order[d.order.length - 1]).toBe('launch 3');
    expect(d.statuses[0]).toBe('Starting One (1 of 3)\u2026');
    expect(d.statuses).toContain('Next account in 15s\u2026');
    expect(d.statuses).toContain('Next account in 1s\u2026');
    expect(d.statuses[d.statuses.length - 1]).toBe('Started 3 of 3.');
});

test('one failing character does not stop the others and the summary counts correctly', async () => {
    const d = deps({
        launchOne: jest.fn(async (id) => {
            if (id === '2') {
                return { ok: false, error: 'Java was not found.' };
            }
            if (id === '3') {
                throw new Error('boom');
            }
            return { ok: true };
        })
    });
    const result = await createMultiLauncher(d).run(characters, 25);
    expect(result.count).toBe(1);
    expect(d.statuses).toContain('Two failed to start: Java was not found.');
    expect(d.logs).toEqual(expect.arrayContaining([
        { level: 'warn', message: 'Two: Java was not found.' },
        { level: 'error', message: 'Three: boom' }
    ]));
    expect(d.statuses[d.statuses.length - 1]).toBe(summary(1, 3));
    expect(summary(1, 3)).toBe('Started 1 of 3 \u2014 see the launcher log for the rest.');
});

test('the jar is resolved once and a failure stops the run before any launch', async () => {
    const ok = deps();
    await createMultiLauncher(ok).run(characters, 15);
    expect(ok.prepare).toHaveBeenCalledTimes(1);
    expect(ok.launchOne.mock.calls.every((call) => call[1] === '2.0.0')).toBe(true);

    const failing = deps({ prepare: jest.fn(async () => null) });
    await expect(createMultiLauncher(failing).run(characters, 15)).resolves.toMatchObject({ started: false, reason: 'prepare-failed' });
    expect(failing.launchOne).not.toHaveBeenCalled();
});

test('cannot start twice while running', async () => {
    let release;
    const d = deps({ prepare: jest.fn(() => new Promise((resolve) => { release = () => resolve('2.0.0'); })) });
    const multi = createMultiLauncher(d);
    const first = multi.run(characters, 15);
    expect(multi.isRunning()).toBe(true);
    await expect(multi.run(characters, 15)).resolves.toEqual({ started: false, reason: 'already-running' });
    release();
    await first;
    expect(multi.isRunning()).toBe(false);
    expect(d.prepare).toHaveBeenCalledTimes(1);
});

test('credentials are strictly interleaved: write N, launch N, wait, write N+1', async () => {
    const home = makeTempDir();
    const paths = createPaths(home);
    fs.mkdirSync(paths.projectxDir, { recursive: true });
    fs.writeFileSync(paths.jarPath('2.0.0'), 'jar');
    writeJsonFile(paths.accountsFile, characters.map((c) => ({ accountId: c.accountId, displayName: c.label, sessionId: 'sess-' + c.accountId, createdOn: '2026-01-01T00:00:00.000Z' })));
    const timeline = [];
    const spawn = jest.fn((command, args) => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        if (args[0] === '-version') {
            setImmediate(() => child.emit('exit', 0));
        } else {
            const creds = fs.readFileSync(paths.credentialsFile, 'utf8');
            timeline.push('spawn with ' + /JX_CHARACTER_ID=(\d+)/.exec(creds)[1]);
        }
        return child;
    });
    const log = makeLog();
    const launcher = createLauncher({
        paths,
        log,
        spawn,
        dialog: { showMessageBox: jest.fn(), showErrorBox: jest.fn() },
        openExternal: jest.fn(),
        readToken: () => null,
        accounts: createAccountsStore({ file: paths.accountsFile, fetch: jest.fn(), log }),
        env: {},
        argv: [],
        platform: 'linux'
    });
    const multi = createMultiLauncher({
        prepare: async () => '2.0.0',
        launchOne: (id, version) => launcher.launchJagex({ accountId: id, version, ram: '1g' }),
        sleep: async () => {
            const creds = fs.readFileSync(paths.credentialsFile, 'utf8');
            const last = timeline[timeline.length - 1];
            if (last !== 'wait') {
                timeline.push('wait');
            }
            expect(last === 'wait' || last === 'spawn with ' + /JX_CHARACTER_ID=(\d+)/.exec(creds)[1]).toBe(true);
        },
        onStatus: () => {},
        log: () => {}
    });
    await multi.run(characters, 15);
    expect(timeline).toEqual(['spawn with 1', 'wait', 'spawn with 2', 'wait', 'spawn with 3']);
});
