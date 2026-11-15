// Start-up and launch-preparation steps used by the renderer. The UI and the bridge are passed in,
// so the same code runs under the tests. No imports on purpose (see ram.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PXFlows = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NO_VERSION = 'Please select a valid client version';

    function jarName(version) {
        return 'projectx-' + version + '.jar';
    }

    // deps: api { listInstalledClients, resolveClientVersion, confirmOutdated }, downloadWithOverlay(version),
    // refreshVersionList(version), saveSetting(key, value), showError(message), log(level, message),
    // selectedVersion()
    function createFlows(deps) {
        const { api } = deps;
        let skippedLatest = null;

        async function resolveCurrent() {
            try {
                return await api.resolveClientVersion();
            } catch (err) {
                return { ok: false, error: err && err.message ? err.message : 'Could not determine the client version.' };
            }
        }

        // First run (client "0.0.0"): download the current client. Failure leaves "0.0.0" so the
        // next start tries again.
        async function firstRun(settings) {
            const current = await resolveCurrent();
            if (settings.client !== '0.0.0') {
                return { downloaded: false };
            }
            if (!current.ok) {
                await deps.showError(current.error);
                return { downloaded: false };
            }
            const result = await deps.downloadWithOverlay(current.version);
            if (!result.ok) {
                await deps.showError('Could not download the client: ' + result.error);
                return { downloaded: false };
            }
            await deps.saveSetting('client', current.version);
            return { downloaded: true, version: current.version };
        }

        // Downloads the version if it is missing, then selects it in the version list.
        async function ensureJar(version) {
            let installed = [];
            try {
                installed = await api.listInstalledClients();
            } catch (_) {
                installed = [];
            }
            if (installed.indexOf(jarName(version)) < 0) {
                deps.log('info', 'Client ' + version + ' is not installed; downloading it');
                const result = await deps.downloadWithOverlay(version);
                if (!result.ok) {
                    await deps.showError('Could not download the client: ' + result.error);
                    return false;
                }
            }
            await deps.refreshVersionList(version);
            return true;
        }

        // The version to launch, or null to stop. Warns once per latest version when the selection is older.
        async function chooseLaunchVersion() {
            const selected = deps.selectedVersion();
            if (!selected) {
                await deps.showError(NO_VERSION);
                return null;
            }
            const current = await resolveCurrent();
            if (!current.ok || current.version === selected || skippedLatest === current.version) {
                return selected;
            }
            const choice = await api.confirmOutdated(selected, current.version);
            if (choice === 'skip') {
                skippedLatest = current.version;
                return selected;
            }
            return (await ensureJar(current.version)) ? current.version : null;
        }

        // Several accounts: the selected jar is made ready once, before any launch.
        async function prepareMulti() {
            const version = deps.selectedVersion();
            if (!version) {
                await deps.showError(NO_VERSION);
                return null;
            }
            return (await ensureJar(version)) ? version : null;
        }

        return { firstRun, ensureJar, chooseLaunchVersion, prepareMulti };
    }

    return { NO_VERSION, createFlows };
});
