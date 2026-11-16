'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { normalisePreset, normaliseStore, toClientPreset, createPresetStore, isPresetId } = require('../src/main/presets');
const { newsFrom, scriptsFrom } = require('../src/main/site-data');
const { createRunningRegistry } = require('../src/main/running');
const { isPresetInput } = require('../src/main/validate');

const quietLog = { info() {}, warn() {}, error() {} };

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'px-presets-'));
    return path.join(dir, 'launch-presets.json');
}

describe('normalisePreset', () => {
    test('defaults everything that is missing or invalid', () => {
        const p = normalisePreset({ name: '  ', script: 'bad name!', delay: 'soon', world: { mode: 'mars', number: 9 }, stopAfterMinutes: 7 });
        expect(isPresetId(p.id)).toBe(true);
        expect(p.name).toBe('New preset');
        expect(p.script).toBeNull();
        expect(p.scriptName).toBe('');
        expect(p.delay).toBe('random');
        expect(p.world).toEqual({ mode: 'keep', number: 302 });
        expect(p.stopAfterMinutes).toBe(0);
        expect(p.whenStopped).toBe('logout-close');
    });

    test('keeps valid values and trims long names', () => {
        const p = normalisePreset({
            name: 'A'.repeat(60),
            script: 'AioFighterPlusPlugin',
            scriptName: 'AIO Fighter X Slayer',
            startAfterLogin: false,
            world: { mode: 'world', number: 330 },
            ram: '1.5g',
            proxy: ' 1.2.3.4:1080 ',
            breaks: 'short',
            stopAfterMinutes: 240,
            whenStopped: 'logout'
        });
        expect(p.name).toHaveLength(40);
        expect(p.script).toBe('AioFighterPlusPlugin');
        expect(p.startAfterLogin).toBe(false);
        expect(p.world).toEqual({ mode: 'world', number: 330 });
        expect(p.ram).toBe('1.5g');
        expect(p.proxy).toBe('1.2.3.4:1080');
        expect(p.breaks).toBe('short');
        expect(p.stopAfterMinutes).toBe(240);
        expect(p.whenStopped).toBe('logout');
    });
});

describe('toClientPreset', () => {
    test('maps a preset to the client contract without proxy, memory or profile', () => {
        const preset = normalisePreset({ name: 'Slayer', script: 'AioFighterPlusPlugin', breaks: 'normal', world: { mode: 'world', number: 302 }, proxy: 'x:1', ram: '2g', profile: 'Slayer', stopAfterMinutes: 240 });
        expect(toClientPreset(preset)).toEqual({
            v: 1,
            name: 'Slayer',
            script: 'AioFighterPlusPlugin',
            startAfterLogin: true,
            startDelaySeconds: { min: 10, max: 60 },
            autoLogin: true,
            world: { mode: 'world', number: 302 },
            breaks: { mode: 'on', playMinutes: { min: 45, max: 90 }, breakMinutes: { min: 5, max: 15 } },
            stopAfterMinutes: 240,
            whenStopped: 'logout-close'
        });
    });

    test('never asks to start when there is no script', () => {
        const contract = toClientPreset(normalisePreset({ name: 'Login only', delay: 'none', world: { mode: 'members' } }));
        expect(contract.script).toBeNull();
        expect(contract.startAfterLogin).toBe(false);
        expect(contract.startDelaySeconds).toEqual({ min: 0, max: 0 });
        expect(contract.world).toEqual({ mode: 'members' });
        expect(contract.breaks).toEqual({ mode: 'keep' });
    });
});

describe('normaliseStore', () => {
    test('drops assignments to unknown presets or bad account ids and duplicate presets', () => {
        const a = normalisePreset({ name: 'A' });
        const store = normaliseStore({ presets: [a, a], assignments: { '123': a.id, '456': 'deadbeefdeadbeef', '__proto__': a.id } });
        expect(store.presets).toHaveLength(1);
        expect(store.assignments).toEqual({ '123': a.id });
    });
});

describe('createPresetStore', () => {
    test('saves, assigns, finds and removes', () => {
        const store = createPresetStore({ file: tempFile(), log: quietLog });
        expect(store.list()).toEqual({ v: 1, presets: [], assignments: {} });
        const { preset } = store.save({ name: 'Crabs', script: 'AmmoniteCrabPlugin', scriptName: 'Fossil Island Crabs' });
        store.assign('111', preset.id);
        expect(store.forAccount('111').name).toBe('Crabs');
        const { preset: renamed } = store.save({ ...preset, name: 'Crabs, spec on' });
        expect(renamed.id).toBe(preset.id);
        expect(store.list().presets).toHaveLength(1);
        store.unassign(['111']);
        expect(store.forAccount('111')).toBeNull();
        store.assign('111', preset.id);
        store.remove(preset.id);
        expect(store.list()).toEqual({ v: 1, presets: [], assignments: {} });
    });

    test('refuses to assign a preset that does not exist', () => {
        const store = createPresetStore({ file: tempFile(), log: quietLog });
        expect(() => store.assign('111', 'deadbeefdeadbeef')).toThrow('no longer exists');
    });

    test('reads a corrupt file as empty', () => {
        const file = tempFile();
        fs.writeFileSync(file, '{not json');
        const store = createPresetStore({ file, log: quietLog });
        expect(store.list().presets).toEqual([]);
    });
});

describe('isPresetInput', () => {
    test('accepts the editor shape and refuses extra keys or wrong types', () => {
        expect(isPresetInput({ name: 'Slayer', script: null, world: { mode: 'keep', number: 302 }, stopAfterMinutes: 0 })).toBe(true);
        expect(isPresetInput({ name: 'x', extra: 1 })).toBe(false);
        expect(isPresetInput({ world: { mode: 'keep', other: 1 } })).toBe(false);
        expect(isPresetInput({ startAfterLogin: 'yes' })).toBe(false);
        expect(isPresetInput({ id: '../../x' })).toBe(false);
    });
});

describe('site data', () => {
    test('newsFrom lists the newest listed releases and the client, newest first', () => {
        const items = newsFrom([
            { name: 'Old', version: '1.0.0', addedAt: '2026-11-01T00:00:00Z', changelog: 'old' },
            { name: 'Gone', version: '2.0.0', addedAt: '2026-11-15T00:00:00Z', listed: false },
            { name: 'AIO Fighter X Slayer', version: '2.3.0', addedAt: '2026-11-16T18:00:00Z', changelog: '\nNo more attacking through doors.\nMore text' }
        ], { version: '2.2.0', publishedAt: '2026-11-15T17:00:00Z' });
        expect(items.map((i) => i.title)).toEqual(['AIO Fighter X Slayer 2.3.0', 'Client 2.2.0', 'Old 1.0.0']);
        expect(items[0].text).toBe('No more attacking through doors.');
    });

    test('scriptsFrom keeps live entitlements, sorted by name', () => {
        const now = Date.parse('2026-11-16T12:00:00Z');
        const list = scriptsFrom({
            entitlements: [
                { internalName: 'ZScript', name: 'Zulu', expiresAt: '2026-12-01T00:00:00Z' },
                { internalName: 'Expired', name: 'Old', expiresAt: '2026-11-01T00:00:00Z' },
                { internalName: 'bad name', name: 'Bad' },
                { internalName: 'AScript', name: 'Alpha', expiresAt: '2026-11-20T00:00:00Z', trial: true }
            ]
        }, now);
        expect(list.map((s) => s.internalName)).toEqual(['AScript', 'ZScript']);
        expect(list[0].trial).toBe(true);
    });
});

describe('running registry', () => {
    test('tracks a client until it exits and can close it', () => {
        const changes = [];
        const registry = createRunningRegistry({ log: quietLog, onChange: (list) => changes.push(list.length), now: () => 5 });
        const child = new EventEmitter();
        child.kill = jest.fn();
        const id = registry.add(child, { label: 'osruney', presetName: 'Slayer', scriptName: 'AIO Fighter X Slayer' });
        expect(registry.list()).toEqual([{ id, label: 'osruney', accountId: null, presetName: 'Slayer', scriptName: 'AIO Fighter X Slayer', startedAt: 5 }]);
        expect(registry.close(id)).toEqual({ ok: true });
        expect(child.kill).toHaveBeenCalled();
        child.emit('exit', 0);
        expect(registry.list()).toEqual([]);
        expect(changes).toEqual([1, 0]);
        expect(registry.close(id).ok).toBe(false);
    });
});

describe('liveFrom', () => {
    const { liveFrom } = require('../src/main/site-data');

    test('keeps checked fields and drops bad entries', () => {
        const list = liveFrom([
            { id: 'sess-aaaa1111', label: 'Desktop', liveness: 'online', remoteControl: true, state: { loggedIn: true, world: 302, name: 'osruney', scripts: [{ name: 'AIO Fighter X Slayer', internalName: 'AioFighterPlusPlugin', startedAt: 5, status: 'Slayer', xpPerHour: 41200, extra: 'x' }] } },
            { id: 'bad id!', label: 'x' },
            { id: 'sess-bbbb2222', liveness: 'weird', state: null },
            { id: 'sess-cccc3333', state: { scripts: [{ name: 'Odd', internalName: '../x' }] } }
        ]);
        expect(list.map((c) => c.id)).toEqual(['sess-aaaa1111', 'sess-bbbb2222', 'sess-cccc3333']);
        expect(list[0].state.scripts[0]).toEqual({ name: 'AIO Fighter X Slayer', internalName: 'AioFighterPlusPlugin', startedAt: 5, status: 'Slayer', xpPerHour: 41200, skill: null });
        expect(list[1]).toMatchObject({ liveness: 'offline', remoteControl: false, state: null });
        expect(list[2].state.scripts[0].internalName).toBeNull();
    });
});
