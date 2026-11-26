'use strict';

const v = require('./validate');

const CHANNELS = {
    minimize: 'px:window:minimize',
    toggleMaximize: 'px:window:toggle-maximize',
    close: 'px:window:close',
    appInfo: 'px:app:info',
    getSession: 'px:auth:session',
    startPairing: 'px:auth:start-pairing',
    cancelPairing: 'px:auth:cancel-pairing',
    reopenPairingPage: 'px:auth:reopen-pairing-page',
    copyPairingLink: 'px:auth:copy-pairing-link',
    signOut: 'px:auth:sign-out',
    getSettings: 'px:settings:get',
    setSetting: 'px:settings:set',
    resolveClientVersion: 'px:client:resolve',
    listInstalledClients: 'px:client:installed',
    downloadClient: 'px:client:download',
    checkClientUpdate: 'px:client:check-update',
    confirmOutdated: 'px:client:confirm-outdated',
    listAccounts: 'px:accounts:list',
    accountsFileState: 'px:accounts:file-state',
    addJagexAccounts: 'px:accounts:add',
    refreshAccounts: 'px:accounts:refresh',
    deleteAccount: 'px:accounts:delete',
    removeAllAccounts: 'px:accounts:remove-all',
    setAccountProfile: 'px:accounts:set-profile',
    listProfiles: 'px:profiles:list',
    getNormalProfile: 'px:profiles:get-normal',
    setNormalProfile: 'px:profiles:set-normal',
    getNicknames: 'px:nicknames:get',
    setNickname: 'px:nicknames:set',
    getPanelSettings: 'px:panel:get',
    setPanelSettings: 'px:panel:set',
    lookupHiscores: 'px:hiscores:lookup',
    launchJagex: 'px:launch:jagex',
    launchNormal: 'px:launch:normal',
    getPresets: 'px:presets:get',
    savePreset: 'px:presets:save',
    deletePreset: 'px:presets:delete',
    assignPreset: 'px:presets:assign',
    listMyScripts: 'px:site:my-scripts',
    getNews: 'px:site:news',
    listRunning: 'px:running:list',
    closeClient: 'px:running:close',
    listLiveClients: 'px:live:list',
    stopRemote: 'px:live:stop',
    showError: 'px:dialog:error',
    openLocation: 'px:locations:open',
    log: 'px:log:write'
};

const EVENTS = {
    downloadProgress: 'px:event:download-progress',
    pairingResult: 'px:event:pairing-result',
    runningChanged: 'px:event:running-changed'
};

const none = (...args) => args.length === 0;

// Every channel lists the exact argument check it requires and the operation it runs.
function buildHandlers(ops) {
    return {
        [CHANNELS.minimize]: { check: none, run: () => ops.minimize() },
        [CHANNELS.toggleMaximize]: { check: none, run: () => ops.toggleMaximize() },
        [CHANNELS.close]: { check: none, run: () => ops.close() },
        [CHANNELS.appInfo]: { check: none, run: () => ops.appInfo() },
        [CHANNELS.getSession]: { check: none, run: () => ops.getSession() },
        [CHANNELS.startPairing]: { check: none, run: () => ops.startPairing() },
        [CHANNELS.cancelPairing]: { check: none, run: () => ops.cancelPairing() },
        [CHANNELS.reopenPairingPage]: { check: none, run: () => ops.reopenPairingPage() },
        [CHANNELS.copyPairingLink]: { check: none, run: () => ops.copyPairingLink() },
        [CHANNELS.signOut]: { check: none, run: () => ops.signOut() },
        [CHANNELS.getSettings]: { check: none, run: () => ops.getSettings() },
        [CHANNELS.setSetting]: {
            check: (...args) => args.length === 2 && v.isSettingUpdate(args[0], args[1]),
            run: (key, value) => ops.setSetting(key, value)
        },
        [CHANNELS.resolveClientVersion]: { check: none, run: () => ops.resolveClientVersion() },
        [CHANNELS.listInstalledClients]: { check: none, run: () => ops.listInstalledClients() },
        [CHANNELS.downloadClient]: {
            check: (...args) => args.length === 1 && v.isVersion(args[0]),
            run: (version) => ops.downloadClient(version)
        },
        [CHANNELS.checkClientUpdate]: { check: none, run: () => ops.checkClientUpdate() },
        [CHANNELS.confirmOutdated]: {
            check: (...args) => args.length === 2 && v.isVersion(args[0]) && v.isVersion(args[1]),
            run: (selected, latest) => ops.confirmOutdated(selected, latest)
        },
        [CHANNELS.listAccounts]: { check: none, run: () => ops.listAccounts() },
        [CHANNELS.accountsFileState]: { check: none, run: () => ops.accountsFileState() },
        [CHANNELS.addJagexAccounts]: { check: none, run: () => ops.addJagexAccounts() },
        [CHANNELS.refreshAccounts]: { check: none, run: () => ops.refreshAccounts() },
        [CHANNELS.deleteAccount]: {
            check: (...args) => args.length === 1 && v.isAccountId(args[0]),
            run: (accountId) => ops.deleteAccount(accountId)
        },
        [CHANNELS.removeAllAccounts]: { check: none, run: () => ops.removeAllAccounts() },
        [CHANNELS.setAccountProfile]: {
            check: (...args) => args.length === 2 && v.isAccountId(args[0]) && v.isProfile(args[1]),
            run: (accountId, profile) => ops.setAccountProfile(accountId, profile)
        },
        [CHANNELS.listProfiles]: { check: none, run: () => ops.listProfiles() },
        [CHANNELS.getNormalProfile]: { check: none, run: () => ops.getNormalProfile() },
        [CHANNELS.setNormalProfile]: {
            check: (...args) => args.length === 1 && v.isProfile(args[0]),
            run: (profile) => ops.setNormalProfile(profile)
        },
        [CHANNELS.getNicknames]: { check: none, run: () => ops.getNicknames() },
        [CHANNELS.setNickname]: {
            check: (...args) => args.length === 2 && v.isAccountId(args[0]) && v.isString(args[1], 256),
            run: (accountId, text) => ops.setNickname(accountId, text)
        },
        [CHANNELS.getPanelSettings]: { check: none, run: () => ops.getPanelSettings() },
        [CHANNELS.setPanelSettings]: {
            check: (...args) => args.length === 1 && v.isPanelPatch(args[0]),
            run: (patch) => ops.setPanelSettings(patch)
        },
        [CHANNELS.lookupHiscores]: {
            check: (...args) => args.length === 2 && v.isString(args[0], 64) && typeof args[1] === 'boolean',
            run: (name, force) => ops.lookupHiscores(name, force)
        },
        [CHANNELS.launchJagex]: {
            check: (...args) => args.length === 1 && v.isLaunchOptions(args[0], true),
            run: (options) => ops.launchJagex(options)
        },
        [CHANNELS.launchNormal]: {
            check: (...args) => args.length === 1 && v.isLaunchOptions(args[0], false),
            run: (options) => ops.launchNormal(options)
        },
        [CHANNELS.getPresets]: { check: none, run: () => ops.getPresets() },
        [CHANNELS.savePreset]: {
            check: (...args) => args.length === 1 && v.isPresetInput(args[0]),
            run: (preset) => ops.savePreset(preset)
        },
        [CHANNELS.deletePreset]: {
            check: (...args) => args.length === 1 && v.isPresetId(args[0]),
            run: (presetId) => ops.deletePreset(presetId)
        },
        [CHANNELS.assignPreset]: {
            check: (...args) => args.length === 2 && v.isAccountId(args[0]) && (args[1] === null || v.isPresetId(args[1])),
            run: (accountId, presetId) => ops.assignPreset(accountId, presetId)
        },
        [CHANNELS.listMyScripts]: {
            check: (...args) => args.length === 1 && typeof args[0] === 'boolean',
            run: (force) => ops.listMyScripts(force)
        },
        [CHANNELS.getNews]: {
            check: (...args) => args.length === 1 && typeof args[0] === 'boolean',
            run: (force) => ops.getNews(force)
        },
        [CHANNELS.listRunning]: { check: none, run: () => ops.listRunning() },
        [CHANNELS.closeClient]: {
            check: (...args) => args.length === 1 && v.isString(args[0], 32) && /^[a-f0-9]+$/.test(args[0]),
            run: (id) => ops.closeClient(id)
        },
        [CHANNELS.listLiveClients]: { check: none, run: () => ops.listLiveClients() },
        [CHANNELS.stopRemote]: {
            check: (...args) => args.length === 2 && v.isSessionId(args[0]) && (args[1] === null || v.isInternalName(args[1])),
            run: (sessionId, internalName) => ops.stopRemote(sessionId, internalName)
        },
        [CHANNELS.showError]: {
            check: (...args) => args.length === 1 && v.isString(args[0], 2000),
            run: (message) => ops.showError(message)
        },
        [CHANNELS.openLocation]: {
            check: (...args) => args.length === 1 && v.isLocationKey(args[0]),
            run: (key) => ops.openLocation(key)
        },
        [CHANNELS.log]: {
            check: (...args) => args.length === 2 && v.isLogLevel(args[0]) && v.isString(args[1], 4000),
            run: (level, message) => ops.log(level, message)
        }
    };
}

// isTrustedSender(event) must confirm the call came from the bundled page.
function registerIpc({ ipcMain, ops, isTrustedSender, log }) {
    const handlers = buildHandlers(ops);
    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!isTrustedSender(event)) {
                log.warn('Refused a call to ' + channel + ' from an unexpected page');
                throw new Error('Refused');
            }
            if (!handler.check(...args)) {
                log.warn('Refused a call to ' + channel + ' with invalid arguments');
                throw new TypeError('Invalid arguments for ' + channel);
            }
            return handler.run(...args);
        });
    }
    return handlers;
}

module.exports = { CHANNELS, EVENTS, buildHandlers, registerIpc };
