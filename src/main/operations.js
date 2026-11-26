'use strict';

const { parseRam } = require('../shared/ram');
const { readClientProfiles, readNonJagexProfile, writeNonJagexProfile } = require('./profiles');
const { errorMessage } = require('./http');

function failure(err) {
    return { ok: false, error: errorMessage(err) };
}

// The operations the renderer can ask for, composed from the services. Arguments have already
// been validated by ipc.js when these run.
function createOperations(ctx) {
    const {
        appInfo,
        windowControls,
        messageBox,
        log,
        paths,
        account,
        settings,
        nicknames,
        client,
        accounts,
        runJagexLogin,
        hiscores,
        launcher,
        locations,
        emit,
        presets = null,
        siteData = null,
        running = null,
        vpnStore = null,
        vpn = null,
        pickConfigFile = null
    } = ctx;

    let jagexLoginRunning = false;

    async function confirm(options) {
        const { confirmIndex, ...boxOptions } = options;
        try {
            const { response } = await messageBox({ type: 'warning', ...boxOptions });
            return response === confirmIndex;
        } catch (err) {
            log.warn('Could not show a confirmation: ' + err.message);
            await showError('Could not ask for confirmation: ' + err.message);
            return false;
        }
    }

    // Deletes saved WireGuard configs no preset uses any more.
    function sweepVpnConfigs() {
        if (!vpnStore || !presets) {
            return;
        }
        try {
            vpnStore.sweep(presets.vpnIds());
        } catch (err) {
            log.warn('Could not tidy the saved WireGuard configs: ' + err.message);
        }
    }

    // A preset as the renderer sent it, with its VPN details taken from the store rather than
    // trusted from the page.
    function withStoredVpn(preset) {
        if (preset.connection !== 'vpn') {
            return { preset: { ...preset, vpn: null } };
        }
        const info = vpnStore && preset.vpn ? vpnStore.info(preset.vpn.id) : null;
        if (!info) {
            return { error: 'Import a WireGuard config for this preset, or pick another connection.' };
        }
        return { preset: { ...preset, vpn: info } };
    }

    async function showError(message) {
        try {
            await messageBox({ type: 'error', title: 'Error', message: String(message), buttons: ['OK'] });
        } catch (err) {
            log.warn('Could not show an error dialog: ' + err.message);
        }
    }

    return {
        minimize: () => windowControls.minimize(),
        toggleMaximize: () => windowControls.toggleMaximize(),
        close: () => windowControls.close(),
        appInfo: () => appInfo,

        getSession: () => account.getSession(),
        startPairing: () => account.startPairing(),
        cancelPairing: () => {
            account.cancelPairing();
        },
        reopenPairingPage: () => account.reopenPairingPage(),
        copyPairingLink: () => account.copyPairingLink(),
        signOut: () => {
            try {
                account.signOut();
                return { ok: true };
            } catch (err) {
                log.error('Sign out failed: ' + err.message);
                return failure(err);
            }
        },

        getSettings: () => {
            const saved = settings.read();
            return {
                client: typeof saved.client === 'string' ? saved.client : '0.0.0',
                version_pref: typeof saved.version_pref === 'string' ? saved.version_pref : '0.0.0',
                proxyip: typeof saved.proxyip === 'string' ? saved.proxyip : '',
                client_ram: typeof saved.client_ram === 'string' ? saved.client_ram : '',
                selected_account: typeof saved.selected_account === 'string' ? saved.selected_account : null
            };
        },
        setSetting: (key, value) => {
            try {
                const stored = key === 'client_ram' ? parseRam(value).value : value;
                settings.update(key, stored);
                return { ok: true };
            } catch (err) {
                log.error('Could not save setting ' + key + ': ' + err.message);
                return failure(err);
            }
        },

        resolveClientVersion: () => client.resolve(),
        listInstalledClients: () => client.listInstalled(),
        downloadClient: (version) => client.download(version, (progress) => emit('downloadProgress', progress)),
        checkClientUpdate: () => client.checkForUpdate(),
        confirmOutdated: async (selected, latest) => {
            try {
                const { response } = await messageBox({
                    type: 'warning',
                    title: 'Outdated Version Warning',
                    message: 'Do you want to proceed?',
                    detail: 'You are about to launch an older version (' + selected + '). The latest version is ' + latest + '.',
                    buttons: ['Skip latest version', 'Launch with the latest version'],
                    defaultId: 1,
                    cancelId: 1
                });
                return response === 0 ? 'skip' : 'latest';
            } catch (err) {
                log.warn('Could not show the outdated version warning: ' + err.message);
                return 'latest';
            }
        },

        listAccounts: () => accounts.listForDisplay(),
        accountsFileState: () => {
            const state = accounts.fileState();
            return { exists: state.exists, mtimeMs: state.mtimeMs };
        },
        addJagexAccounts: async () => {
            if (jagexLoginRunning) {
                return { ok: false, error: 'A Jagex sign-in is already open.' };
            }
            jagexLoginRunning = true;
            try {
                return await runJagexLogin();
            } catch (err) {
                log.error('Jagex sign-in failed: ' + (err && err.name ? err.name : 'error'));
                return { ok: false, error: 'An error occurred during the authentication flow.' };
            } finally {
                jagexLoginRunning = false;
            }
        },
        refreshAccounts: () => accounts.refreshAll(),
        deleteAccount: async (accountId) => {
            const confirmed = await confirm({
                title: 'Delete account?',
                message: 'Delete account?',
                detail: 'This permanently removes the account from the launcher. This cannot be undone.',
                buttons: ['Cancel', 'Delete'],
                defaultId: 0,
                cancelId: 0,
                confirmIndex: 1
            });
            if (!confirmed) {
                return { ok: false, cancelled: true };
            }
            const result = accounts.deleteAccount(accountId);
            if (!result.ok) {
                return result;
            }
            try {
                nicknames.removeNicknames([accountId]);
            } catch (err) {
                log.warn('Could not remove the nickname of a deleted account: ' + err.message);
            }
            if (presets) {
                try {
                    presets.unassign([accountId]);
                } catch (err) {
                    log.warn('Could not remove the preset of a deleted account: ' + err.message);
                }
            }
            return { ok: true };
        },
        removeAllAccounts: async () => {
            const confirmed = await confirm({
                title: 'Remove all accounts?',
                message: 'Remove every saved Jagex account?',
                detail: 'All saved Jagex accounts and their nicknames will be removed from this launcher. '
                    + 'Your Jagex logins are not affected, and you can add them again with "Login Jagex Account".',
                buttons: ['Cancel', 'Remove All'],
                defaultId: 0,
                cancelId: 0,
                confirmIndex: 1
            });
            if (!confirmed) {
                return { ok: false, cancelled: true };
            }
            const result = accounts.removeAll();
            if (!result.ok) {
                return result;
            }
            try {
                nicknames.removeNicknames('all');
            } catch (err) {
                log.warn('Could not clear nicknames: ' + err.message);
            }
            if (presets) {
                try {
                    presets.unassign('all');
                } catch (err) {
                    log.warn('Could not clear preset assignments: ' + err.message);
                }
            }
            return { ok: true };
        },
        setAccountProfile: (accountId, profile) => accounts.setProfile(accountId, profile),

        listProfiles: () => readClientProfiles(paths.profilesFile, log),
        getNormalProfile: () => readNonJagexProfile(paths.nonJagexProfileFile, log),
        setNormalProfile: (profile) => {
            try {
                writeNonJagexProfile(paths.nonJagexProfileFile, profile);
                return { ok: true };
            } catch (err) {
                log.error('Could not save the normal-account profile: ' + err.message);
                return failure(err);
            }
        },

        getNicknames: () => {
            try {
                return { ok: true, nicknames: nicknames.getNicknames() };
            } catch (err) {
                return failure(err);
            }
        },
        setNickname: (accountId, text) => {
            try {
                return { ok: true, nicknames: nicknames.setNickname(accountId, text) };
            } catch (err) {
                log.warn('Could not save a nickname: ' + err.message);
                return failure(err);
            }
        },
        getPanelSettings: () => {
            try {
                return { ok: true, panel: nicknames.getPanel() };
            } catch (err) {
                return { ok: false, error: err.message, panel: { hidden: false, collapsed: false } };
            }
        },
        setPanelSettings: (patch) => {
            try {
                return { ok: true, panel: nicknames.setPanel(patch) };
            } catch (err) {
                log.warn('Could not save the accounts panel settings: ' + err.message);
                return failure(err);
            }
        },
        lookupHiscores: async (name, force) => {
            try {
                return await hiscores.lookup(name, force);
            } catch (_) {
                return { status: 'error', name, message: 'Lookup failed.', cached: false };
            }
        },

        launchJagex: async (options) => {
            try {
                return await launcher.launchJagex(options);
            } catch (err) {
                log.error('Launch failed: ' + err.message);
                return failure(err);
            }
        },
        launchNormal: async (options) => {
            try {
                return await launcher.launchNormal(options);
            } catch (err) {
                log.error('Launch failed: ' + err.message);
                return failure(err);
            }
        },

        getPresets: () => {
            try {
                return { ok: true, ...presets.list() };
            } catch (err) {
                log.warn('Could not read the launch presets: ' + err.message);
                return { ...failure(err), presets: [], assignments: {} };
            }
        },
        savePreset: (preset) => {
            try {
                const checked = withStoredVpn(preset);
                if (checked.error) {
                    return { ok: false, error: checked.error };
                }
                const { store, preset: saved } = presets.save(checked.preset);
                if (saved.vpn && vpnStore) {
                    vpnStore.settle(saved.vpn.id);
                }
                sweepVpnConfigs();
                return { ok: true, preset: saved, ...store };
            } catch (err) {
                log.warn('Could not save a launch preset: ' + err.message);
                return failure(err);
            }
        },
        deletePreset: async (presetId) => {
            const confirmed = await confirm({
                title: 'Delete preset?',
                message: 'Delete this launch preset?',
                detail: 'Accounts that use it will open without a preset.',
                buttons: ['Cancel', 'Delete'],
                defaultId: 0,
                cancelId: 0,
                confirmIndex: 1
            });
            if (!confirmed) {
                return { ok: false, cancelled: true };
            }
            try {
                const store = presets.remove(presetId);
                sweepVpnConfigs();
                return { ok: true, ...store };
            } catch (err) {
                log.warn('Could not delete a launch preset: ' + err.message);
                return failure(err);
            }
        },
        // Picks a .conf file and saves it. Only the name, endpoint and any warnings come back.
        importVpnConfig: async () => {
            if (!vpnStore || !pickConfigFile) {
                return { ok: false, error: 'VPN presets are not available in this copy of the launcher.' };
            }
            let file;
            try {
                file = await pickConfigFile();
            } catch (err) {
                log.warn('Could not open the file picker: ' + err.message);
                return failure(err);
            }
            if (!file) {
                return { ok: false, cancelled: true };
            }
            try {
                const result = vpnStore.importFile(file);
                if (!result.ok) {
                    log.info('A WireGuard config was not accepted: ' + result.error);
                }
                return result;
            } catch (err) {
                log.warn('Could not save a WireGuard config: ' + err.message);
                return { ok: false, error: 'The config could not be saved: ' + err.message };
            }
        },
        testVpnConfig: async (vpnId) => {
            if (!vpn) {
                return { ok: false, error: 'VPN presets are not available in this copy of the launcher.' };
            }
            try {
                return await vpn.test(vpnId, 'a connection test');
            } catch (err) {
                log.warn('The VPN test failed: ' + err.message);
                return failure(err);
            }
        },
        assignPreset: (accountId, presetId) => {
            try {
                return { ok: true, ...presets.assign(accountId, presetId) };
            } catch (err) {
                return failure(err);
            }
        },
        listMyScripts: (force) => siteData.myScripts(force),
        getNews: (force) => siteData.news(force),
        listRunning: () => ({ ok: true, clients: running.list() }),
        closeClient: (id) => running.close(id),
        listLiveClients: () => siteData.liveClients(),
        stopRemote: (sessionId, internalName) => siteData.stopRemote(sessionId, internalName),

        showError,
        openLocation: async (key) => {
            try {
                await locations.open(key);
                return { ok: true };
            } catch (err) {
                log.warn('Could not open ' + key + ': ' + err.message);
                await showError('Could not open the folder: ' + err.message);
                return failure(err);
            }
        },
        log: (level, message) => {
            log[level]('[ui] ' + message);
        }
    };
}

module.exports = { createOperations };
