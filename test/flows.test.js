'use strict';

const { createFlows, NO_VERSION } = require('../src/shared/flows');

function setup({ installed = ['projectx-2.0.0.jar'], latest = { ok: true, version: '2.0.0' }, selected = '2.0.0', download = { ok: true }, choice = 'latest' } = {}) {
    const calls = [];
    const api = {
        listInstalledClients: jest.fn(async () => installed.slice()),
        resolveClientVersion: jest.fn(async () => latest),
        confirmOutdated: jest.fn(async () => choice)
    };
    const deps = {
        api,
        downloadWithOverlay: jest.fn(async (version) => {
            calls.push('download ' + version);
            if (download.ok) {
                installed.push('projectx-' + version + '.jar');
            }
            return download;
        }),
        refreshVersionList: jest.fn(async (version) => calls.push('select ' + version)),
        saveSetting: jest.fn(async (key, value) => calls.push('save ' + key + '=' + value)),
        showError: jest.fn(async (message) => calls.push('error ' + message)),
        log: jest.fn(),
        selectedVersion: jest.fn(() => selected)
    };
    return { flows: createFlows(deps), api, deps, calls };
}

describe('first run', () => {
    test('downloads the current client and records it', async () => {
        const { flows, calls } = setup({ installed: [], latest: { ok: true, version: '2.0.1' } });
        await expect(flows.firstRun({ client: '0.0.0' })).resolves.toEqual({ downloaded: true, version: '2.0.1' });
        expect(calls).toEqual(['download 2.0.1', 'save client=2.0.1']);
    });

    test('a failed download shows an error and leaves the client unset for next time', async () => {
        const { flows, calls, deps } = setup({ installed: [], download: { ok: false, error: 'HTTP 503' } });
        await expect(flows.firstRun({ client: '0.0.0' })).resolves.toEqual({ downloaded: false });
        expect(calls).toEqual(['download 2.0.0', 'error Could not download the client: HTTP 503']);
        expect(deps.saveSetting).not.toHaveBeenCalled();
    });

    test('an unknown version is reported', async () => {
        const { flows, calls } = setup({ latest: { ok: false, error: 'Could not determine the client version.' } });
        await flows.firstRun({ client: '0.0.0' });
        expect(calls).toEqual(['error Could not determine the client version.']);
    });

    test('nothing is downloaded once a client is installed', async () => {
        const { flows, deps, api } = setup();
        await expect(flows.firstRun({ client: '2.0.0' })).resolves.toEqual({ downloaded: false });
        expect(deps.downloadWithOverlay).not.toHaveBeenCalled();
        expect(api.resolveClientVersion).toHaveBeenCalledTimes(1);
    });
});

describe('outdated-version prompt', () => {
    test('no prompt when the selection is the latest', async () => {
        const { flows, api } = setup();
        await expect(flows.chooseLaunchVersion()).resolves.toBe('2.0.0');
        expect(api.confirmOutdated).not.toHaveBeenCalled();
    });

    test('no prompt when the lookup fails', async () => {
        const { flows, api } = setup({ latest: { ok: false, error: 'offline' } });
        await expect(flows.chooseLaunchVersion()).resolves.toBe('2.0.0');
        expect(api.confirmOutdated).not.toHaveBeenCalled();
    });

    test('"Skip latest version" launches the selection and is remembered for that version', async () => {
        const { flows, api } = setup({ latest: { ok: true, version: '2.1.0' }, choice: 'skip' });
        await expect(flows.chooseLaunchVersion()).resolves.toBe('2.0.0');
        await expect(flows.chooseLaunchVersion()).resolves.toBe('2.0.0');
        expect(api.confirmOutdated).toHaveBeenCalledTimes(1);
        expect(api.confirmOutdated).toHaveBeenCalledWith('2.0.0', '2.1.0');
    });

    test('a newer latest version asks again after a skip', async () => {
        const { flows, api } = setup({ latest: { ok: true, version: '2.1.0' }, choice: 'skip' });
        await flows.chooseLaunchVersion();
        api.resolveClientVersion.mockResolvedValue({ ok: true, version: '2.2.0' });
        await flows.chooseLaunchVersion();
        expect(api.confirmOutdated).toHaveBeenCalledTimes(2);
    });

    test('"Launch with the latest version" downloads and selects it', async () => {
        const { flows, calls } = setup({ latest: { ok: true, version: '2.1.0' }, choice: 'latest' });
        await expect(flows.chooseLaunchVersion()).resolves.toBe('2.1.0');
        expect(calls).toEqual(['download 2.1.0', 'select 2.1.0']);
    });

    test('a failed download of the latest stops the launch', async () => {
        const { flows } = setup({ latest: { ok: true, version: '2.1.0' }, choice: 'latest', download: { ok: false, error: 'HTTP 404' } });
        await expect(flows.chooseLaunchVersion()).resolves.toBeNull();
    });

    test('no valid selection is refused', async () => {
        const { flows, calls, api } = setup({ selected: null });
        await expect(flows.chooseLaunchVersion()).resolves.toBeNull();
        expect(calls).toEqual(['error ' + NO_VERSION]);
        expect(api.resolveClientVersion).not.toHaveBeenCalled();
    });
});

describe('multi-launch preparation', () => {
    test('an installed jar is selected without downloading', async () => {
        const { flows, calls } = setup();
        await expect(flows.prepareMulti()).resolves.toBe('2.0.0');
        expect(calls).toEqual(['select 2.0.0']);
    });

    test('a missing jar is downloaded once', async () => {
        const { flows, calls } = setup({ installed: [] });
        await expect(flows.prepareMulti()).resolves.toBe('2.0.0');
        expect(calls).toEqual(['download 2.0.0', 'select 2.0.0']);
    });

    test('a failed download or no selection returns null', async () => {
        await expect(setup({ installed: [], download: { ok: false, error: 'x' } }).flows.prepareMulti()).resolves.toBeNull();
        const none = setup({ selected: null });
        await expect(none.flows.prepareMulti()).resolves.toBeNull();
        expect(none.calls).toEqual(['error ' + NO_VERSION]);
    });

    test('exact file names: 1.0.1 is not satisfied by 1.0.10', async () => {
        const { flows, calls } = setup({ installed: ['projectx-1.0.10.jar'], selected: '1.0.1' });
        await flows.prepareMulti();
        expect(calls[0]).toBe('download 1.0.1');
    });
});
