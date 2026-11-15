'use strict';

(function () {
    const PX = window.PX;
    const api = PX.api;
    const F = window.PXFormat;
    const R = window.PXRam;
    const M = window.PXMultiLaunch;
    const S = window.PXSelection;
    const $ = PX.$;

    const UPDATE_CHECK_MS = 5 * 60 * 1000;
    const WATCH_MS = 1000;
    const PROXY_DEBOUNCE_MS = 400;

    const state = {
        initialised: false,
        settings: { client: '0.0.0', version_pref: '0.0.0', proxyip: '', client_ram: '1g', selected_account: null },
        accounts: [],
        newestFirst: [],
        nicknames: {},
        panel: { hidden: false, collapsed: false },
        selectedId: null,
        ticks: new Set(),
        updateTimer: null,
        watchStamp: null,
        reloading: false,
        accountErrors: new Set()
    };

    const els = {
        title: $('title-text'),
        playNormal: $('play-normal'),
        playJagex: $('play-jagex'),
        accountActions: $('account-actions'),
        addAccounts: $('add-accounts'),
        removeAll: $('remove-all'),
        accountField: $('account-field'),
        refreshAccounts: $('refresh-accounts'),
        version: $('version-select'),
        profile: $('profile-select'),
        ram: $('ram-select'),
        proxy: $('proxy-input'),
        multiToggle: $('multi-toggle'),
        multiPanel: $('multi-panel'),
        multiList: $('multi-list'),
        multiGap: $('multi-gap'),
        multiPlay: $('multi-play'),
        multiStatus: $('multi-status'),
        banner: $('update-banner'),
        bannerVersion: $('update-version'),
        updateNow: $('update-now'),
        updateLater: $('update-later'),
        overlay: $('progress-overlay'),
        track: $('progress-track'),
        bar: $('progress-bar'),
        barText: $('progress-text'),
        progressStatus: $('progress-status'),
        video: $('hero-video')
    };

    const versionOf = (name) => name.slice('projectx-'.length, -'.jar'.length);
    const findAccount = (id) => state.accounts.find((account) => account.accountId === id) || null;
    const labelOf = (account) => F.accountLabel(account, state.nicknames);

    // Window chrome

    $('win-min').addEventListener('click', () => api.minimize());
    $('win-max').addEventListener('click', () => api.toggleMaximize());
    $('win-close').addEventListener('click', () => api.close());
    api.appInfo().then((info) => {
        els.title.textContent = 'Project X Launcher - ' + info.version;
    }).catch(() => {});

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    function applyMotionPreference() {
        if (reducedMotion.matches) {
            els.video.pause();
            els.video.currentTime = 0;
        } else {
            els.video.play().catch(() => {});
        }
    }
    reducedMotion.addEventListener('change', applyMotionPreference);
    applyMotionPreference();

    // Progress overlay

    function setProgress(progress) {
        const percent = Math.max(0, Math.min(100, Number(progress && progress.percent) || 0));
        els.bar.style.width = percent + '%';
        els.barText.textContent = Math.round(percent) + '%';
        els.track.setAttribute('aria-valuenow', String(Math.round(percent)));
        if (progress && typeof progress.status === 'string') {
            els.progressStatus.textContent = progress.status;
        }
    }

    function showOverlay() {
        setProgress({ percent: 0, status: '' });
        els.overlay.hidden = false;
    }

    function hideOverlay() {
        els.overlay.hidden = true;
    }

    api.onDownloadProgress(setProgress);

    async function downloadWithOverlay(version) {
        showOverlay();
        try {
            return await api.downloadClient(version);
        } catch (err) {
            return { ok: false, error: err.message };
        } finally {
            hideOverlay();
        }
    }

    // Settings

    async function saveSetting(key, value) {
        try {
            const result = await api.setSetting(key, value);
            if (result && result.ok) {
                if (value === null) {
                    delete state.settings[key];
                } else {
                    state.settings[key] = value;
                }
            } else {
                PX.log('warn', 'Could not save ' + key + ': ' + (result && result.error));
            }
        } catch (err) {
            PX.log('warn', 'Could not save ' + key + ': ' + err.message);
        }
    }

    // Version list

    function selectedVersion() {
        const name = els.version.value;
        return name && name.startsWith('projectx-') && name.endsWith('.jar') ? versionOf(name) : null;
    }

    async function refreshVersionList(preferVersion) {
        let installed = [];
        try {
            installed = await api.listInstalledClients();
        } catch (err) {
            PX.log('warn', 'Could not list installed clients: ' + err.message);
        }
        els.version.replaceChildren(...installed.map((name) => PX.el('option', { value: name, text: name })));
        const target = S.chooseVersion(installed, preferVersion, state.settings.version_pref);
        if (target) {
            els.version.value = target;
            const version = versionOf(target);
            if (version !== state.settings.version_pref) {
                await saveSetting('version_pref', version);
            }
        }
        return installed;
    }

    els.version.addEventListener('change', () => {
        const version = selectedVersion();
        if (version) {
            saveSetting('version_pref', version);
        }
    });

    // Profiles

    function setProfileValue(value) {
        const options = Array.from(els.profile.options).map((option) => option.value);
        els.profile.value = options.includes(value) ? value : 'default';
    }

    async function refreshProfiles() {
        const current = els.profile.value;
        let names = [];
        try {
            names = await api.listProfiles();
        } catch (err) {
            PX.log('warn', 'Could not list profiles: ' + err.message);
        }
        els.profile.replaceChildren(
            PX.el('option', { value: 'default', text: 'Default' }),
            ...names.map((name) => PX.el('option', { value: name, text: name }))
        );
        setProfileValue(current || 'default');
    }

    async function applyProfileForSelection() {
        try {
            if (state.selectedId) {
                const listed = await api.listAccounts();
                const fresh = listed.ok ? listed.accounts.find((account) => account.accountId === state.selectedId) : null;
                setProfileValue((fresh && fresh.profile) || 'default');
            } else {
                setProfileValue((await api.getNormalProfile()) || 'default');
            }
        } catch (err) {
            PX.log('warn', 'Could not apply the profile: ' + err.message);
        }
    }

    els.profile.addEventListener('change', async () => {
        const profile = els.profile.value || 'default';
        if (state.selectedId) {
            const result = await api.setAccountProfile(state.selectedId, profile);
            if (!result.ok) {
                await PX.showError(result.error);
                return;
            }
            const account = findAccount(state.selectedId);
            if (account) {
                account.profile = profile;
            }
        } else {
            const result = await api.setNormalProfile(profile);
            if (!result.ok) {
                PX.log('warn', 'Could not save the profile: ' + result.error);
            }
        }
    });

    // RAM and proxy

    async function setupRam(stored) {
        const { value, options } = R.ramOptionsFor(stored);
        els.ram.replaceChildren(...options.map((option) => PX.el('option', { value: option.value, text: option.label })));
        els.ram.value = value;
        if (value !== stored) {
            await saveSetting('client_ram', value);
        }
    }

    function currentRam() {
        return R.sanitizeRam(els.ram.value);
    }

    function saveRam() {
        const value = currentRam();
        if (value !== state.settings.client_ram) {
            saveSetting('client_ram', value);
        }
    }

    els.ram.addEventListener('change', saveRam);
    els.ram.addEventListener('blur', saveRam);

    let proxyTimer = null;
    function saveProxy() {
        clearTimeout(proxyTimer);
        const value = els.proxy.value;
        if (value !== state.settings.proxyip) {
            saveSetting('proxyip', value.slice(0, 512));
        }
    }
    els.proxy.addEventListener('input', () => {
        clearTimeout(proxyTimer);
        proxyTimer = setTimeout(saveProxy, PROXY_DEBOUNCE_MS);
    });
    els.proxy.addEventListener('blur', saveProxy);

    function currentProxy() {
        return els.proxy.value.trim().slice(0, 512);
    }

    // Accounts

    function setAccounts(newestFirst) {
        state.newestFirst = newestFirst;
        state.accounts = F.sortAccountsAlphabetically(newestFirst);
    }

    function reportAccountsError(message) {
        if (state.accountErrors.has(message)) {
            PX.log('warn', message);
            return;
        }
        state.accountErrors.add(message);
        PX.showError(message);
    }

    async function readAccounts() {
        try {
            const result = await api.listAccounts();
            if (!result.ok) {
                reportAccountsError(result.error);
                return null;
            }
            return result.accounts;
        } catch (err) {
            reportAccountsError('Failed to load accounts: ' + err.message);
            return null;
        }
    }

    function restoreSelection() {
        const decision = S.rememberedSelection(state.accounts, state.settings.selected_account);
        if (decision.action === 'select') {
            state.selectedId = decision.accountId;
        } else if (decision.action === 'forget') {
            saveSetting('selected_account', null);
        }
    }

    const picker = PX.createPicker({
        root: $('account-picker'),
        onSelect: (id) => selectAccount(id),
        onDelete: (id) => deleteAccount(id)
    });

    function renderMulti() {
        for (const id of Array.from(state.ticks)) {
            if (!findAccount(id)) {
                state.ticks.delete(id);
            }
        }
        if (state.accounts.length === 0) {
            els.multiList.replaceChildren(PX.el('div', { className: 'multi-empty', text: 'No Jagex accounts added yet.' }));
        } else {
            els.multiList.replaceChildren(...state.accounts.map((account) => {
                const box = PX.el('input', { type: 'checkbox' });
                box.checked = state.ticks.has(account.accountId);
                box.addEventListener('change', () => {
                    if (box.checked) {
                        state.ticks.add(account.accountId);
                    } else {
                        state.ticks.delete(account.accountId);
                    }
                    updateMultiButton();
                });
                const label = labelOf(account);
                return PX.el('label', { className: 'multi-row', title: label }, [box, PX.el('span', { text: label })]);
            }));
        }
        updateMultiButton();
    }

    function updateMultiButton() {
        els.multiPlay.textContent = 'Play Selected (' + state.ticks.size + ')';
        els.multiPlay.disabled = state.ticks.size === 0 || multi.isRunning();
    }

    function refreshLabels() {
        picker.render({ accounts: state.accounts, nicknames: state.nicknames, selectedId: state.selectedId });
        renderMulti();
        panel.render();
    }

    // Sidebar layout follows the number of accounts, never the button text.
    function layout() {
        const hasAccounts = state.accounts.length > 0;
        els.playJagex.textContent = hasAccounts ? 'Play With Jagex Account' : 'Login Jagex Account';
        els.accountActions.hidden = !hasAccounts;
        els.accountField.hidden = !hasAccounts;
        if (!hasAccounts) {
            state.selectedId = null;
            picker.close();
        } else if (state.selectedId !== null && !findAccount(state.selectedId)) {
            state.selectedId = state.accounts[0].accountId;
        }
        refreshLabels();
    }

    function selectAccount(id) {
        state.selectedId = id;
        saveSetting('selected_account', id);
        refreshLabels();
        applyProfileForSelection();
    }

    async function onAccountsFileChanged() {
        if (state.reloading) {
            return;
        }
        state.reloading = true;
        try {
            const previousCount = state.accounts.length;
            const list = await readAccounts();
            if (!list) {
                return;
            }
            if (previousCount > 0 && list.length === 0) {
                PX.log('info', 'No saved Jagex accounts remain');
            }
            setAccounts(list);
            const next = S.selectionAfterReload(state.accounts, previousCount, state.selectedId);
            state.selectedId = next.accountId;
            if (next.changedCount && next.accountId !== null) {
                // Saved so the remembered selection below does not switch back to the old character.
                await saveSetting('selected_account', next.accountId);
            }
            restoreSelection();
            layout();
            await refreshVersionList(selectedVersion());
            await refreshProfiles();
            await applyProfileForSelection();
        } finally {
            state.reloading = false;
        }
    }

    function startAccountsWatch() {
        setInterval(async () => {
            let fileState;
            try {
                fileState = await api.accountsFileState();
            } catch (_) {
                return;
            }
            const stamp = fileState.exists ? 'file:' + fileState.mtimeMs : 'none';
            const first = state.watchStamp === null;
            const changed = first ? fileState.exists : stamp !== state.watchStamp;
            state.watchStamp = stamp;
            if (changed) {
                onAccountsFileChanged();
            }
        }, WATCH_MS);
    }

    async function refreshFromJagex(silent) {
        let result;
        try {
            result = await api.refreshAccounts();
        } catch (err) {
            result = { ok: false, error: err.message };
        }
        if (!result.ok) {
            if (silent) {
                PX.log('info', 'Background account refresh: ' + result.error);
            } else {
                await PX.showError(result.error);
            }
            return;
        }
        if (result.accounts) {
            setAccounts(result.accounts);
            restoreSelection();
            layout();
            await applyProfileForSelection();
        }
    }

    els.refreshAccounts.addEventListener('click', async () => {
        els.refreshAccounts.disabled = true;
        try {
            await refreshFromJagex(false);
        } finally {
            els.refreshAccounts.disabled = false;
        }
    });

    async function deleteAccount(id) {
        let result;
        try {
            result = await api.deleteAccount(id);
        } catch (err) {
            result = { ok: false, error: err.message };
        }
        if (result.cancelled) {
            return;
        }
        if (!result.ok) {
            await PX.showError('Failed to delete account: ' + result.error);
            return;
        }
        const nicknames = await api.getNicknames();
        if (nicknames.ok) {
            state.nicknames = nicknames.nicknames;
        }
        const list = await readAccounts();
        if (list) {
            setAccounts(list);
        }
        if (state.selectedId === id) {
            state.selectedId = state.accounts.length ? state.accounts[0].accountId : null;
            await saveSetting('selected_account', state.selectedId);
        }
        layout();
        await applyProfileForSelection();
    }

    async function addAccounts() {
        const result = await api.addJagexAccounts();
        if (!result.ok) {
            await PX.showError(result.error);
            return;
        }
        await onAccountsFileChanged();
    }

    els.addAccounts.addEventListener('click', () => PX.runBusy(els.addAccounts, addAccounts));

    els.removeAll.addEventListener('click', () => PX.runBusy(els.removeAll, async () => {
        const result = await api.removeAllAccounts();
        if (result.cancelled) {
            return;
        }
        if (!result.ok) {
            await PX.showError('Could not remove the accounts: ' + result.error);
            return;
        }
        setAccounts([]);
        state.nicknames = {};
        state.ticks.clear();
        await saveSetting('selected_account', null);
        layout();
        await applyProfileForSelection();
    }));

    // Accounts panel

    const panel = PX.createPanel({
        getState: () => ({ accounts: state.accounts, nicknames: state.nicknames, panel: state.panel }),
        onPanelChange: (patch) => changePanel(patch),
        onNicknamesSaved: (map) => {
            if (map) {
                state.nicknames = map;
            }
            refreshLabels();
        }
    });

    function applyPanel() {
        menu.setPanelShown(!state.panel.hidden);
        panel.render();
    }

    async function changePanel(patch) {
        state.panel = { ...state.panel, ...patch };
        applyPanel();
        try {
            const result = await api.setPanelSettings(patch);
            if (result.ok) {
                state.panel = result.panel;
                applyPanel();
            }
        } catch (err) {
            PX.log('warn', 'Could not save the panel settings: ' + err.message);
        }
    }

    const menu = PX.createMenu({ onTogglePanel: () => changePanel({ hidden: !state.panel.hidden }) });
    menu.setSignedIn(false);

    // Client updates

    async function runClientUpdateCheck() {
        try {
            const result = await api.checkClientUpdate();
            if (!result || !result.ok) {
                return;
            }
            const fresh = await api.getSettings();
            state.settings.client = fresh.client;
            if (result.needsUpdate) {
                els.bannerVersion.textContent = result.latest;
                els.banner.hidden = false;
            } else {
                els.banner.hidden = true;
            }
        } catch (err) {
            PX.log('warn', 'Client update check failed: ' + err.message);
        }
    }

    function scheduleUpdateChecks() {
        clearInterval(state.updateTimer);
        state.updateTimer = setInterval(runClientUpdateCheck, UPDATE_CHECK_MS);
    }

    els.updateLater.addEventListener('click', () => {
        els.banner.hidden = true;
    });

    els.updateNow.addEventListener('click', () => PX.runBusy(els.updateNow, async () => {
        clearInterval(state.updateTimer);
        els.banner.hidden = true;
        try {
            const current = await api.resolveClientVersion();
            if (!current.ok) {
                await PX.showError(current.error);
                return;
            }
            const result = await downloadWithOverlay(current.version);
            if (!result.ok) {
                await PX.showError('Could not download the client: ' + result.error);
                return;
            }
            await refreshVersionList(current.version);
            await saveSetting('client', current.version);
        } finally {
            hideOverlay();
            scheduleUpdateChecks();
        }
    }));

    // Launching

    const flows = window.PXFlows.createFlows({
        api,
        downloadWithOverlay,
        refreshVersionList: (version) => refreshVersionList(version),
        saveSetting,
        showError: PX.showError,
        log: PX.log,
        selectedVersion
    });
    const { ensureJar, chooseLaunchVersion } = flows;

    async function launchSelectedJagex() {
        if (!state.selectedId || !findAccount(state.selectedId)) {
            await PX.showError('Pick a Jagex account first. Choose one from the Jagex Account list, or use "Play Normal Account".');
            return;
        }
        const accountId = state.selectedId;
        const version = await chooseLaunchVersion();
        if (!version || !(await ensureJar(version))) {
            return;
        }
        const result = await api.launchJagex({ accountId, version, ram: currentRam(), proxy: currentProxy() });
        if (!result.ok && !result.silent) {
            await PX.showError(result.error);
        }
    }

    async function launchNormal() {
        const version = await chooseLaunchVersion();
        if (!version) {
            return;
        }
        await api.setNormalProfile(els.profile.value || 'default');
        if (!(await ensureJar(version))) {
            return;
        }
        const result = await api.launchNormal({ version, ram: currentRam(), proxy: currentProxy() });
        if (!result.ok && !result.silent) {
            await PX.showError(result.error);
        }
    }

    els.playNormal.addEventListener('click', () => PX.runBusy(els.playNormal, launchNormal));
    els.playJagex.addEventListener('click', () => PX.runBusy(els.playJagex, () => (state.accounts.length === 0 ? addAccounts() : launchSelectedJagex())));

    // Several accounts

    let multiOptions = { ram: '1g', proxy: '' };
    const multi = M.createMultiLauncher({
        prepare: () => flows.prepareMulti(),
        launchOne: (accountId, version) => api.launchJagex({ accountId, version, ram: multiOptions.ram, proxy: multiOptions.proxy }),
        sleep: PX.sleep,
        onStatus: (text) => {
            els.multiStatus.textContent = text;
        },
        log: PX.log
    });

    els.multiToggle.addEventListener('click', () => {
        const open = els.multiPanel.hidden;
        els.multiPanel.hidden = !open;
        els.multiToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('multi-all').addEventListener('click', () => {
        state.accounts.forEach((account) => state.ticks.add(account.accountId));
        renderMulti();
    });
    $('multi-none').addEventListener('click', () => {
        state.ticks.clear();
        renderMulti();
    });
    els.multiPlay.addEventListener('click', () => PX.runBusy(els.multiPlay, async () => {
        const characters = state.accounts
            .filter((account) => state.ticks.has(account.accountId))
            .map((account) => ({ accountId: account.accountId, label: labelOf(account) }));
        multiOptions = { ram: currentRam(), proxy: currentProxy() };
        await multi.run(characters, Number(els.multiGap.value));
    }).finally(updateMultiButton));

    // Start-up after sign-in, once per run.

    async function initialise() {
        state.settings = { ...state.settings, ...(await api.getSettings()) };
        await flows.firstRun(state.settings);
        hideOverlay();

        const [nicknames, panelSettings] = await Promise.all([api.getNicknames(), api.getPanelSettings()]);
        state.nicknames = nicknames.ok ? nicknames.nicknames : {};
        state.panel = panelSettings.panel || { hidden: false, collapsed: false };
        menu.setPanelShown(!state.panel.hidden);

        const list = await readAccounts();
        setAccounts(list || []);
        restoreSelection();
        layout();
        await refreshVersionList();
        await refreshProfiles();
        await applyProfileForSelection();
        await setupRam(state.settings.client_ram);
        els.proxy.value = state.settings.proxyip || '';

        await runClientUpdateCheck();
        scheduleUpdateChecks();
        startAccountsWatch();
        if (state.accounts.length > 0) {
            refreshFromJagex(true);
        }
    }

    const signin = PX.createSignin({
        onSignedIn: () => {
            menu.setSignedIn(true);
            if (state.initialised) {
                return;
            }
            state.initialised = true;
            initialise().catch((err) => {
                PX.log('error', 'Start-up failed: ' + err.message);
                hideOverlay();
                PX.showError('The launcher could not finish starting: ' + err.message);
            });
        },
        onSignedOut: () => menu.setSignedIn(false)
    });

    signin.check();
})();
