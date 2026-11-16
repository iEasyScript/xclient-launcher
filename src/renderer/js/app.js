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
        selectedId: null,
        ticks: new Set(),
        updateTimer: null,
        watchStamp: null,
        reloading: false,
        accountErrors: new Set(),
        presetStore: { presets: [], assignments: {} },
        levels: {},
        editingId: null,
        running: [],
        user: null,
        view: 'play'
    };

    const els = {
        title: $('title-text'),
        playNormal: $('play-normal'),
        playJagex: $('play-jagex'),
        playJagexText: $('play-jagex-text'),
        heroGreeting: $('hero-greeting'),
        heroTitle: $('hero-title'),
        heroSubtitle: $('hero-subtitle'),
        grid: $('account-grid'),
        summary: $('accounts-summary'),
        selectAll: $('select-all'),
        addAccounts: $('add-accounts'),
        addAccounts2: $('add-accounts-2'),
        removeAll: $('remove-all'),
        refreshAccounts: $('refresh-accounts'),
        version: $('version-select'),
        profile: $('profile-select'),
        ram: $('ram-select'),
        proxy: $('proxy-input'),
        launchLabel: $('launch-label'),
        launchSub: $('launch-sub'),
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
        video: $('hero-video'),
        userCard: $('user-card'),
        userName: $('user-name'),
        userTier: $('user-tier'),
        userBalance: $('user-balance'),
        clientStatus: $('client-status'),
        clientStatusText: $('client-status-text')
    };

    const versionOf = (name) => name.slice('projectx-'.length, -'.jar'.length);
    const findAccount = (id) => state.accounts.find((account) => account.accountId === id) || null;
    const labelOf = (account) => F.accountLabel(account, state.nicknames);

    // Window chrome

    $('win-min').addEventListener('click', () => api.minimize());
    $('win-max').addEventListener('click', () => api.toggleMaximize());
    $('win-close').addEventListener('click', () => api.close());
    api.appInfo().then((info) => {
        els.title.textContent = 'Project X Launcher ' + info.version;
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

    // Views

    const views = { play: $('view-play'), presets: $('view-presets'), settings: $('view-settings') };

    function showView(name) {
        state.view = name;
        for (const [key, section] of Object.entries(views)) {
            section.hidden = key !== name;
        }
        for (const link of document.querySelectorAll('.nav-link')) {
            const active = link.dataset.view === name;
            link.classList.toggle('active', active);
            if (active) {
                link.setAttribute('aria-current', 'page');
            } else {
                link.removeAttribute('aria-current');
            }
        }
        if (name === 'play') {
            applyMotionPreference();
        } else {
            els.video.pause();
        }
        if (name === 'presets') {
            presets.show();
        }
    }

    for (const link of document.querySelectorAll('.nav-link')) {
        link.addEventListener('click', () => showView(link.dataset.view));
    }

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

    // Normal account profile (Settings)

    function setProfileValue(value) {
        const options = Array.from(els.profile.options).map((option) => option.value);
        els.profile.value = options.includes(value) ? value : 'default';
    }

    async function refreshProfiles() {
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
        try {
            setProfileValue((await api.getNormalProfile()) || 'default');
        } catch (_) {
            setProfileValue('default');
        }
    }

    els.profile.addEventListener('change', async () => {
        const result = await api.setNormalProfile(els.profile.value || 'default');
        if (!result.ok) {
            PX.log('warn', 'Could not save the profile: ' + result.error);
        }
    });

    // RAM and proxy (Settings)

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

    function presetOf(accountId) {
        const presetId = state.presetStore.assignments[accountId];
        return presetId ? state.presetStore.presets.find((preset) => preset.id === presetId) || null : null;
    }

    function runningFor(accountId) {
        return state.running.filter((client) => client.accountId === accountId);
    }

    function cardMeta(account, preset) {
        const parts = [];
        if (preset && preset.script && preset.startAfterLogin) {
            parts.push('\u2192 ' + (preset.scriptName || preset.script));
        }
        if (state.levels[account.accountId]) {
            parts.push(state.levels[account.accountId]);
        }
        if (preset) {
            if (preset.world.mode === 'world') {
                parts.push('World ' + preset.world.number);
            } else if (preset.world.mode === 'members') {
                parts.push('Any members world');
            } else if (preset.world.mode === 'free') {
                parts.push('Any free world');
            }
            if (preset.proxy) {
                parts.push('Own proxy');
            }
            if (preset.ram) {
                parts.push(R.ramOptionsFor(preset.ram).options.find((option) => option.value === preset.ram)?.label || preset.ram);
            }
        }
        return parts.join(' \u00B7 ') || (account.profile && account.profile !== 'default' ? 'Profile: ' + account.profile : 'Launcher settings');
    }

    function tickButton(account) {
        const checked = state.ticks.has(account.accountId);
        const button = PX.el('button', {
            className: 'tick',
            type: 'button',
            role: 'checkbox',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': 'Select ' + labelOf(account)
        }, [PX.el('span', { 'aria-hidden': 'true', text: '\u2713' })]);
        button.addEventListener('click', () => {
            if (state.ticks.has(account.accountId)) {
                state.ticks.delete(account.accountId);
            } else {
                state.ticks.add(account.accountId);
            }
            renderCards();
        });
        return button;
    }

    function presetSelect(account, preset) {
        const select = PX.el('select', { className: 'select', 'aria-label': 'Preset for ' + labelOf(account) },
            [PX.el('option', { value: '', text: 'No preset' })].concat(state.presetStore.presets.map((item) => PX.el('option', { value: item.id, text: item.name }))));
        select.value = preset ? preset.id : '';
        select.addEventListener('change', async () => {
            const result = await api.assignPreset(account.accountId, select.value || null);
            if (!result.ok) {
                await PX.showError('Could not set the preset: ' + result.error);
                return;
            }
            presets.setStore(result);
        });
        return select;
    }

    function nameArea(account) {
        if (state.editingId === account.accountId) {
            const input = PX.el('input', { className: 'input nickname-edit', type: 'text', maxlength: '24', value: state.nicknames[account.accountId] || '', placeholder: F.displayName(account), 'aria-label': 'Nickname' });
            const finish = async (save) => {
                if (state.editingId !== account.accountId) {
                    return;
                }
                state.editingId = null;
                if (save) {
                    const result = await api.setNickname(account.accountId, input.value);
                    if (result.ok) {
                        state.nicknames = result.nicknames;
                    } else {
                        await PX.showError('Could not save the nickname: ' + result.error);
                    }
                }
                renderCards();
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    finish(true);
                } else if (event.key === 'Escape') {
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));
            setTimeout(() => input.focus(), 0);
            return input;
        }
        const label = labelOf(account);
        const real = F.displayName(account);
        const rename = PX.el('button', { className: 'icon-btn', type: 'button', title: 'Rename', 'aria-label': 'Rename ' + label, text: '\u270E' });
        rename.addEventListener('click', () => {
            state.editingId = account.accountId;
            renderCards();
        });
        const remove = PX.el('button', { className: 'icon-btn danger', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + label, text: '\u2715' });
        remove.addEventListener('click', () => deleteAccount(account.accountId));
        return PX.el('div', { className: 'card-title-row' }, [
            PX.el('span', { className: 'card-name', text: label, title: label }),
            label !== real ? PX.el('span', { className: 'card-realname', text: real }) : null,
            rename,
            remove
        ]);
    }

    function accountCard(account) {
        const preset = presetOf(account.accountId);
        const running = runningFor(account.accountId);
        const label = labelOf(account);
        const play = PX.el('button', { className: 'btn btn-small card-play', type: 'button', text: 'Play', title: running.length ? 'Open another client for this account' : 'Open the client' });
        play.addEventListener('click', () => PX.runBusy(play, () => launchOne(account.accountId)));
        return PX.el('div', { className: 'account-card' + (state.ticks.has(account.accountId) ? ' selected' : '') }, [
            tickButton(account),
            PX.el('div', { className: 'avatar', 'aria-hidden': 'true', text: (label.trim()[0] || '?').toUpperCase() }),
            PX.el('div', { className: 'card-main' }, [
                nameArea(account),
                PX.el('div', { className: 'card-preset' }, [
                    PX.el('span', { text: 'Preset' }),
                    presetSelect(account, preset)
                ]),
                PX.el('span', { className: 'card-meta', text: cardMeta(account, preset) })
            ]),
            PX.el('div', { className: 'card-side' }, [
                PX.el('span', { className: 'status-pill' + (running.length ? ' running' : ''), text: running.length ? 'Running' : 'Offline' }),
                play
            ])
        ]);
    }

    function renderCards() {
        for (const id of Array.from(state.ticks)) {
            if (!findAccount(id)) {
                state.ticks.delete(id);
            }
        }
        if (state.accounts.length === 0) {
            els.grid.replaceChildren(PX.el('div', { className: 'empty' }, [
                'No Jagex accounts yet. Press ',
                PX.el('strong', { text: '+ Add account' }),
                ' to sign in with Jagex, or use "Play normal account" for a non-Jagex login.'
            ]));
        } else {
            els.grid.replaceChildren(...state.accounts.map(accountCard));
        }
        const runningCount = state.accounts.filter((account) => runningFor(account.accountId).length > 0).length;
        els.summary.textContent = state.accounts.length
            ? state.accounts.length + (state.accounts.length === 1 ? ' account' : ' accounts') + (runningCount ? ' \u00B7 ' + runningCount + ' running' : '')
            : '';
        els.selectAll.hidden = state.accounts.length === 0;
        els.selectAll.textContent = state.accounts.length && state.ticks.size === state.accounts.length ? 'Select none' : 'Select all';
        els.refreshAccounts.hidden = state.accounts.length === 0;
        renderHero();
        updateLaunchBar();
    }

    function renderHero() {
        const hasAccounts = state.accounts.length > 0;
        const remembered = state.selectedId ? findAccount(state.selectedId) : null;
        els.playJagexText.textContent = !hasAccounts ? 'Add a Jagex account' : remembered ? 'Play ' + labelOf(remembered) : 'Play with Jagex account';
        const count = state.running.length;
        els.heroTitle.textContent = count ? count + (count === 1 ? ' client running' : ' clients running') : 'Ready to play';
        els.heroSubtitle.textContent = hasAccounts
            ? 'Tick accounts below and press Launch. Each one can start its own script the moment it logs in.'
            : 'Add your Jagex accounts to launch them in one click, each with its own preset.';
    }

    function updateLaunchBar() {
        const count = state.ticks.size;
        els.launchLabel.textContent = count === 0 ? 'No accounts selected' : count + (count === 1 ? ' account selected' : ' accounts selected');
        const withPreset = Array.from(state.ticks).filter((id) => presetOf(id)).length;
        els.launchSub.textContent = count === 0
            ? 'Tick the accounts you want to open together'
            : withPreset === count ? 'Each starts its preset after login' : withPreset ? withPreset + ' of them have a preset' : 'They open with the launcher settings';
        els.multiPlay.textContent = count ? 'Launch ' + count : 'Launch';
        els.multiPlay.disabled = count === 0 || multi.isRunning();
    }

    function selectAccount(id) {
        state.selectedId = id;
        saveSetting('selected_account', id);
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
            setAccounts(list);
            const next = S.selectionAfterReload(state.accounts, previousCount, state.selectedId);
            state.selectedId = next.accountId;
            if (next.changedCount && next.accountId !== null) {
                await saveSetting('selected_account', next.accountId);
            }
            restoreSelection();
            renderCards();
            loadLevels();
            await refreshVersionList(selectedVersion());
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
            renderCards();
        }
    }

    els.refreshAccounts.addEventListener('click', () => PX.runBusy(els.refreshAccounts, () => refreshFromJagex(false)));

    // Levels from the public hiscores, one account at a time (the service caches and rate-limits).
    let levelsRunning = false;
    async function loadLevels() {
        if (levelsRunning) {
            return;
        }
        levelsRunning = true;
        try {
            for (const account of state.accounts.slice()) {
                const name = F.displayName(account);
                if (!name) {
                    continue;
                }
                try {
                    const result = await api.lookupHiscores(name, false);
                    if (result && result.status === 'ok' && result.data) {
                        const data = result.data;
                        const parts = [];
                        if (typeof data.combatLevel === 'number') {
                            parts.push('Combat ' + F.formatNumber(data.combatLevel));
                        }
                        if (typeof data.totalLevel === 'number') {
                            parts.push('Total ' + F.formatNumber(data.totalLevel));
                        }
                        if (parts.length) {
                            state.levels[account.accountId] = parts.join(' \u00B7 ');
                            renderCards();
                        }
                    }
                } catch (_) {
                    // levels are a nicety; a failed lookup just leaves them out
                }
            }
        } finally {
            levelsRunning = false;
        }
    }

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
        const [nicknames, store] = await Promise.all([api.getNicknames(), api.getPresets()]);
        if (nicknames.ok) {
            state.nicknames = nicknames.nicknames;
        }
        if (store.ok) {
            presets.setStore(store);
        }
        const list = await readAccounts();
        if (list) {
            setAccounts(list);
        }
        if (state.selectedId === id) {
            state.selectedId = state.accounts.length ? state.accounts[0].accountId : null;
            await saveSetting('selected_account', state.selectedId);
        }
        state.ticks.delete(id);
        renderCards();
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
    els.addAccounts2.addEventListener('click', () => PX.runBusy(els.addAccounts2, addAccounts));

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
        state.levels = {};
        await saveSetting('selected_account', null);
        const store = await api.getPresets();
        if (store.ok) {
            presets.setStore(store);
        }
        renderCards();
    }));

    els.selectAll.addEventListener('click', () => {
        if (state.ticks.size === state.accounts.length) {
            state.ticks.clear();
        } else {
            state.accounts.forEach((account) => state.ticks.add(account.accountId));
        }
        renderCards();
    });

    // Menu (the old accounts panel item stays hidden)

    const menu = PX.createMenu({ onTogglePanel: () => {} });
    menu.setSignedIn(false);

    // Client updates

    function setClientStatus(kind, text) {
        els.clientStatus.classList.toggle('ok', kind === 'ok');
        els.clientStatus.classList.toggle('warn', kind === 'warn');
        els.clientStatusText.textContent = text;
    }

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
                setClientStatus('warn', 'Client ' + result.latest + ' available');
            } else {
                els.banner.hidden = true;
                setClientStatus('ok', 'Client ' + (fresh.client || result.latest || '') + ' \u00B7 up to date');
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
            setClientStatus('ok', 'Client ' + current.version + ' \u00B7 up to date');
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

    async function launchOne(accountId) {
        const account = findAccount(accountId);
        if (!account) {
            await PX.showError('That Jagex account could not be found. Refresh the list and try again.');
            return;
        }
        selectAccount(accountId);
        renderHero();
        const version = await chooseLaunchVersion();
        if (!version || !(await ensureJar(version))) {
            return;
        }
        const result = await api.launchJagex({ accountId, version, ram: currentRam(), proxy: currentProxy(), label: labelOf(account).slice(0, 64) });
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
    els.playJagex.addEventListener('click', () => PX.runBusy(els.playJagex, () => {
        if (state.accounts.length === 0) {
            return addAccounts();
        }
        const target = state.selectedId && findAccount(state.selectedId) ? state.selectedId : state.accounts[0].accountId;
        return launchOne(target);
    }));

    // Several accounts

    let multiOptions = { ram: '1g', proxy: '' };
    const multi = M.createMultiLauncher({
        prepare: () => flows.prepareMulti(),
        launchOne: (accountId, version) => {
            const account = findAccount(accountId);
            return api.launchJagex({ accountId, version, ram: multiOptions.ram, proxy: multiOptions.proxy, label: account ? labelOf(account).slice(0, 64) : undefined });
        },
        sleep: PX.sleep,
        onStatus: (text) => {
            els.multiStatus.textContent = text;
        },
        log: PX.log
    });

    els.multiPlay.addEventListener('click', () => PX.runBusy(els.multiPlay, async () => {
        const characters = state.accounts
            .filter((account) => state.ticks.has(account.accountId))
            .map((account) => ({ accountId: account.accountId, label: labelOf(account) }));
        multiOptions = { ram: currentRam(), proxy: currentProxy() };
        await multi.run(characters, Number(els.multiGap.value));
    }).finally(updateLaunchBar));

    // Presets and the activity column

    const presets = PX.createPresets({
        getAccounts: () => state.accounts,
        labelOf,
        onStoreChange: (store) => {
            state.presetStore = store;
            renderCards();
        }
    });

    const side = PX.createSide({
        getAccounts: () => state.accounts,
        onRunningChange: (clients) => {
            state.running = clients;
            renderCards();
        }
    });

    // Signed-in player

    function greeting() {
        const hour = new Date().getHours();
        return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    }

    function showUser(user) {
        state.user = user || null;
        if (!user) {
            els.userCard.hidden = true;
            els.heroGreeting.textContent = 'Welcome back';
            return;
        }
        const name = user.name || user.discordUsername || 'Player';
        els.userName.textContent = name;
        els.userName.title = name;
        const membership = user.membership && user.membership.name ? user.membership.name : null;
        els.userTier.hidden = !membership;
        els.userTier.textContent = membership || '';
        const cents = typeof user.balanceCents === 'number' ? user.balanceCents : typeof user.tokenBalance === 'number' ? user.tokenBalance * 100 : null;
        els.userBalance.textContent = cents === null ? '-' : (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)) + ' X';
        els.userCard.hidden = false;
        els.heroGreeting.textContent = greeting() + ', ' + name;
    }

    // Start-up after sign-in, once per run.

    async function initialise() {
        state.settings = { ...state.settings, ...(await api.getSettings()) };
        await flows.firstRun(state.settings);
        hideOverlay();

        const nicknames = await api.getNicknames();
        state.nicknames = nicknames.ok ? nicknames.nicknames : {};
        await presets.load();

        const list = await readAccounts();
        setAccounts(list || []);
        restoreSelection();
        renderCards();
        await refreshVersionList();
        await refreshProfiles();
        await setupRam(state.settings.client_ram);
        els.proxy.value = state.settings.proxyip || '';
        side.start();

        await runClientUpdateCheck();
        scheduleUpdateChecks();
        startAccountsWatch();
        loadLevels();
        if (state.accounts.length > 0) {
            refreshFromJagex(true);
        }
    }

    const signin = PX.createSignin({
        onSignedIn: (user) => {
            menu.setSignedIn(true);
            showUser(user);
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
        onSignedOut: () => {
            menu.setSignedIn(false);
            showUser(null);
        }
    });

    renderCards();
    signin.check();
})();
