'use strict';

// Runs sandboxed, so it cannot require project files; channel names are kept in step with
// src/main/ipc.js by a test.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
    return (callback) => {
        if (typeof callback !== 'function') {
            return () => {};
        }
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    };
}

const api = {
    minimize: call('px:window:minimize'),
    toggleMaximize: call('px:window:toggle-maximize'),
    close: call('px:window:close'),
    appInfo: call('px:app:info'),

    getSession: call('px:auth:session'),
    startPairing: call('px:auth:start-pairing'),
    cancelPairing: call('px:auth:cancel-pairing'),
    reopenPairingPage: call('px:auth:reopen-pairing-page'),
    copyPairingLink: call('px:auth:copy-pairing-link'),
    signOut: call('px:auth:sign-out'),
    onPairingResult: subscribe('px:event:pairing-result'),

    getSettings: call('px:settings:get'),
    setSetting: call('px:settings:set'),

    resolveClientVersion: call('px:client:resolve'),
    listInstalledClients: call('px:client:installed'),
    downloadClient: call('px:client:download'),
    checkClientUpdate: call('px:client:check-update'),
    confirmOutdated: call('px:client:confirm-outdated'),
    onDownloadProgress: subscribe('px:event:download-progress'),

    listAccounts: call('px:accounts:list'),
    accountsFileState: call('px:accounts:file-state'),
    addJagexAccounts: call('px:accounts:add'),
    refreshAccounts: call('px:accounts:refresh'),
    deleteAccount: call('px:accounts:delete'),
    removeAllAccounts: call('px:accounts:remove-all'),
    setAccountProfile: call('px:accounts:set-profile'),

    listProfiles: call('px:profiles:list'),
    getNormalProfile: call('px:profiles:get-normal'),
    setNormalProfile: call('px:profiles:set-normal'),

    getNicknames: call('px:nicknames:get'),
    setNickname: call('px:nicknames:set'),
    getPanelSettings: call('px:panel:get'),
    setPanelSettings: call('px:panel:set'),
    lookupHiscores: call('px:hiscores:lookup'),

    launchJagex: call('px:launch:jagex'),
    launchNormal: call('px:launch:normal'),

    getPresets: call('px:presets:get'),
    savePreset: call('px:presets:save'),
    deletePreset: call('px:presets:delete'),
    assignPreset: call('px:presets:assign'),
    listMyScripts: call('px:site:my-scripts'),
    getNews: call('px:site:news'),
    listRunning: call('px:running:list'),
    closeClient: call('px:running:close'),
    listLiveClients: call('px:live:list'),
    stopRemote: call('px:live:stop'),
    onRunningChanged: subscribe('px:event:running-changed'),

    showError: call('px:dialog:error'),
    openLocation: call('px:locations:open'),
    log: call('px:log:write')
};

contextBridge.exposeInMainWorld('launcher', Object.freeze(api));
