'use strict';

(function () {
    const PX = window.PX;
    const R = window.PXRam;

    const WORLD_CHOICES = [
        { value: 'keep', label: 'As saved' },
        { value: 'world', label: 'One world' },
        { value: 'members', label: 'Any members' },
        { value: 'free', label: 'Any free' }
    ];
    const DELAY_CHOICES = [
        { value: 'random', label: 'A random 10 to 60 seconds' },
        { value: 'none', label: 'Straight away' }
    ];
    const BREAK_CHOICES = [
        { value: 'keep', label: 'Use my break settings in the client' },
        { value: 'normal', label: 'Play 45 to 90 min, break 5 to 15 min' },
        { value: 'short', label: 'Play 20 to 40 min, break 2 to 8 min' },
        { value: 'off', label: 'No breaks' }
    ];
    const STOP_CHOICES = [
        { value: 0, label: 'Never' },
        { value: 60, label: '1 hour' },
        { value: 120, label: '2 hours' },
        { value: 180, label: '3 hours' },
        { value: 240, label: '4 hours' },
        { value: 360, label: '6 hours' },
        { value: 480, label: '8 hours' }
    ];
    const THEN_CHOICES = [
        { value: 'logout-close', label: 'Log out and close the client' },
        { value: 'logout', label: 'Log out' },
        { value: 'stay', label: 'Just stop the script' }
    ];

    const NEW_PRESET = {
        name: 'New preset',
        script: null,
        scriptName: '',
        startAfterLogin: true,
        delay: 'random',
        autoLogin: true,
        world: { mode: 'keep', number: 302 },
        profile: 'default',
        ram: '',
        proxy: '',
        connection: 'direct',
        vpn: null,
        breaks: 'keep',
        stopAfterMinutes: 0,
        whenStopped: 'logout-close'
    };
    const CONNECTION_CHOICES = [
        { value: 'direct', label: 'Direct' },
        { value: 'proxy', label: 'Proxy' },
        { value: 'vpn', label: 'VPN (WireGuard)' }
    ];

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function daysLeft(iso) {
        const time = Date.parse(iso);
        if (!Number.isFinite(time)) {
            return null;
        }
        return Math.max(0, Math.ceil((time - Date.now()) / 86400000));
    }

    // Lifetime access ends on 9999-12-31: shown as "for life", not a count of days.
    function isLifetime(iso) {
        const time = Date.parse(iso);
        return Number.isFinite(time) && new Date(time).getUTCFullYear() >= 9999;
    }

    function selectOf(choices, value, onChange, className) {
        const select = PX.el('select', { className: className || 'select' }, choices.map((choice) => PX.el('option', { value: String(choice.value), text: choice.label })));
        select.value = String(value);
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    function field(label, control, note) {
        return PX.el('label', { className: 'field' }, [PX.el('span', { className: 'field-label', text: label }), control, note || null]);
    }

    function toggle(title, sub, checked, onChange) {
        const button = PX.el('button', { className: 'switch', type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': title });
        button.addEventListener('click', () => {
            const next = button.getAttribute('aria-checked') !== 'true';
            button.setAttribute('aria-checked', next ? 'true' : 'false');
            onChange(next);
        });
        return PX.el('div', { className: 'toggle-row' }, [
            PX.el('div', { className: 'toggle-text' }, [
                PX.el('span', { className: 'toggle-title', text: title }),
                PX.el('span', { className: 'field-note', text: sub })
            ]),
            button
        ]);
    }

    // The launch presets view. getAccounts/labelOf come from the Play view so "Used by" names match.
    PX.createPresets = function createPresets({ getAccounts, labelOf, onStoreChange }) {
        const listEl = PX.$('preset-list');
        const editorEl = PX.$('preset-editor');
        const state = {
            store: { presets: [], assignments: {} },
            scripts: [],
            scriptsError: null,
            vpnWarnings: [],
            vpnTest: null,
            profiles: [],
            currentId: null,
            draft: null,
            dirty: false
        };

        function presetById(id) {
            return state.store.presets.find((preset) => preset.id === id) || null;
        }

        function usedBy(presetId) {
            const accounts = getAccounts();
            return Object.entries(state.store.assignments)
                .filter(([, id]) => id === presetId)
                .map(([accountId]) => accounts.find((account) => account.accountId === accountId))
                .filter(Boolean)
                .map(labelOf);
        }

        function summary(preset) {
            if (preset.script && preset.startAfterLogin) {
                return 'Starts ' + (preset.scriptName || preset.script);
            }
            return preset.script ? (preset.scriptName || preset.script) + ', not started' : 'No script';
        }

        function setStore(store) {
            state.store = { presets: store.presets || [], assignments: store.assignments || {} };
            onStoreChange(state.store);
        }

        function renderList() {
            if (state.store.presets.length === 0 && !state.draft) {
                listEl.replaceChildren(PX.el('p', { className: 'side-empty', text: 'No presets yet. Make one to start a script by itself when a client opens.' }));
                return;
            }
            const items = state.store.presets.map((preset) => {
                const button = PX.el('button', { className: 'preset-item' + (preset.id === state.currentId ? ' active' : ''), type: 'button' }, [
                    PX.el('span', { className: 'preset-item-name', text: preset.name }),
                    PX.el('span', { className: 'preset-item-sub', text: summary(preset) })
                ]);
                button.addEventListener('click', () => open(preset.id));
                return button;
            });
            if (state.draft && !state.currentId) {
                items.push(PX.el('div', { className: 'preset-item active' }, [
                    PX.el('span', { className: 'preset-item-name', text: state.draft.name || 'New preset' }),
                    PX.el('span', { className: 'preset-item-sub', text: 'Not saved yet' })
                ]));
            }
            listEl.replaceChildren(...items);
        }

        function change(patch) {
            state.draft = { ...state.draft, ...patch };
            state.dirty = true;
            renderEditor();
        }

        function scriptControl(draft) {
            const options = [PX.el('option', { value: '', text: 'No script' })];
            let known = false;
            for (const script of state.scripts) {
                options.push(PX.el('option', { value: script.internalName, text: script.name }));
                if (script.internalName === draft.script) {
                    known = true;
                }
            }
            if (draft.script && !known) {
                options.push(PX.el('option', { value: draft.script, text: (draft.scriptName || draft.script) + ' (no access now)' }));
            }
            const select = PX.el('select', { className: 'select' }, options);
            select.value = draft.script || '';
            select.addEventListener('change', () => {
                const picked = state.scripts.find((script) => script.internalName === select.value);
                change({ script: select.value || null, scriptName: picked ? picked.name : (select.value ? draft.scriptName : '') });
            });
            let note;
            const owned = state.scripts.find((script) => script.internalName === draft.script);
            if (!draft.script) {
                note = PX.el('span', { className: 'field-note', text: state.scriptsError || 'The client opens without starting anything.' });
            } else if (owned) {
                const left = daysLeft(owned.expiresAt);
                const text = owned.trial ? 'Free trial' : 'Subscribed';
                const detail = isLifetime(owned.expiresAt)
                    ? 'Owned for life'
                    : left === null ? text : text + ' \u00B7 ' + left + (left === 1 ? ' day left' : ' days left');
                note = PX.el('span', { className: 'field-note good', text: detail });
            } else {
                note = PX.el('span', { className: 'field-note warn', text: 'You don\u2019t have access right now, so it won\u2019t start.' });
            }
            return field('Start this script', select, note);
        }

        function worldControl(draft) {
            const seg = PX.el('div', { className: 'segmented', role: 'radiogroup', 'aria-label': 'World' }, WORLD_CHOICES.map((choice) => {
                const button = PX.el('button', { className: 'seg', type: 'button', role: 'radio', 'aria-checked': draft.world.mode === choice.value ? 'true' : 'false', text: choice.label });
                button.addEventListener('click', () => change({ world: { ...draft.world, mode: choice.value } }));
                return button;
            }));
            const parts = [PX.el('span', { className: 'field-label', text: 'World' }), seg];
            if (draft.world.mode === 'world') {
                const input = PX.el('input', { className: 'input', type: 'number', min: '301', max: '650', value: String(draft.world.number), 'aria-label': 'World number' });
                input.addEventListener('change', () => {
                    const number = Math.round(Number(input.value));
                    change({ world: { ...draft.world, number: number >= 301 && number <= 650 ? number : draft.world.number } });
                });
                parts.push(input);
            }
            parts.push(PX.el('span', { className: 'field-note', text: draft.world.mode === 'members' || draft.world.mode === 'free' ? 'Skips full, PvP and high-risk worlds.' : draft.world.mode === 'keep' ? 'Logs in to the world the client last used.' : 'Logs in to this world.' }));
            return PX.el('div', { className: 'field' }, parts);
        }

        function ramControl(draft) {
            const { options } = R.ramOptionsFor(draft.ram || '1g');
            const select = PX.el('select', { className: 'select' }, [PX.el('option', { value: '', text: 'Launcher setting' })]
                .concat(options.map((option) => PX.el('option', { value: option.value, text: option.label }))));
            select.value = draft.ram || '';
            select.addEventListener('change', () => change({ ram: select.value }));
            return field('Memory', select);
        }

        async function importVpn() {
            const result = await PX.api.importVpnConfig();
            if (result.cancelled) {
                return;
            }
            if (!result.ok) {
                await PX.showError('Could not use that WireGuard config: ' + result.error);
                return;
            }
            state.vpnWarnings = Array.isArray(result.warnings) ? result.warnings : [];
            state.vpnTest = null;
            change({ connection: 'vpn', vpn: result.vpn });
        }

        async function testVpn(vpnId) {
            state.vpnTest = { kind: 'busy', text: 'Connecting through the VPN...' };
            renderEditor();
            let result;
            try {
                result = await PX.api.testVpnConfig(vpnId);
            } catch (err) {
                result = { ok: false, error: err.message };
            }
            if (!state.draft || !state.draft.vpn || state.draft.vpn.id !== vpnId) {
                return;
            }
            state.vpnTest = result.ok
                ? { kind: 'good', text: 'Connected. Sites see ' + result.ip + (result.country ? ' (' + result.country + ')' : '') + '.' }
                : { kind: 'warn', text: result.error };
            renderEditor();
        }

        function vpnPanel(draft) {
            if (!draft.vpn) {
                const importButton = PX.el('button', { className: 'btn btn-small', type: 'button', text: 'Import WireGuard config' });
                importButton.addEventListener('click', () => PX.runBusy(importButton, importVpn, 300));
                return [
                    importButton,
                    PX.el('span', { className: 'field-note', text: 'A .conf file from your VPN provider. Only clients using this preset connect through it; nothing else on this PC changes.' })
                ];
            }
            const vpn = draft.vpn;
            const busy = Boolean(state.vpnTest && state.vpnTest.kind === 'busy');
            const test = PX.el('button', { className: 'btn btn-small', type: 'button', text: 'Test connection' });
            test.disabled = busy;
            test.addEventListener('click', () => testVpn(vpn.id));
            const replace = PX.el('button', { className: 'btn btn-small btn-ghost', type: 'button', text: 'Replace' });
            replace.disabled = busy;
            replace.addEventListener('click', () => PX.runBusy(replace, importVpn, 300));
            const remove = PX.el('button', { className: 'btn btn-small btn-ghost', type: 'button', text: 'Remove' });
            remove.disabled = busy;
            remove.addEventListener('click', () => {
                state.vpnWarnings = [];
                state.vpnTest = null;
                change({ vpn: null });
            });
            const parts = [
                PX.el('div', { className: 'vpn-box' }, [
                    PX.el('span', { className: 'vpn-name', text: vpn.name }),
                    PX.el('span', { className: 'vpn-endpoint', text: vpn.endpoint ? 'Server ' + vpn.endpoint : 'WireGuard' })
                ]),
                PX.el('div', { className: 'vpn-actions' }, [test, replace, remove])
            ];
            if (!vpn.encrypted) {
                parts.push(PX.el('span', { className: 'field-note warn', text: 'Kept unencrypted on this PC: no system key store is available to protect the private key.' }));
            }
            for (const warning of state.vpnWarnings) {
                parts.push(PX.el('span', { className: 'field-note', text: warning }));
            }
            if (state.vpnTest) {
                parts.push(PX.el('span', { className: 'field-note vpn-status' + (state.vpnTest.kind === 'busy' ? '' : ' ' + state.vpnTest.kind), text: state.vpnTest.text }));
            }
            return parts;
        }

        function connectionControl(draft) {
            const seg = PX.el('div', { className: 'segmented three', role: 'radiogroup', 'aria-label': 'Connection' }, CONNECTION_CHOICES.map((choice) => {
                const button = PX.el('button', { className: 'seg', type: 'button', role: 'radio', 'aria-checked': draft.connection === choice.value ? 'true' : 'false', text: choice.label });
                button.addEventListener('click', () => {
                    if (draft.connection !== choice.value) {
                        state.vpnTest = null;
                        change({ connection: choice.value });
                    }
                });
                return button;
            }));
            const parts = [PX.el('span', { className: 'field-label', text: 'Connection' }), seg];
            if (draft.connection === 'proxy') {
                const input = PX.el('input', { className: 'input', type: 'text', placeholder: 'ip:port:user:password', spellcheck: 'false', autocomplete: 'off', value: draft.proxy || '', 'aria-label': 'Proxy' });
                input.addEventListener('change', () => change({ proxy: input.value.trim().slice(0, 512) }));
                parts.push(input, PX.el('span', { className: 'field-note', text: 'SOCKS, ip:port:user:pass' }));
            } else if (draft.connection === 'vpn') {
                parts.push(...vpnPanel(draft));
            } else {
                parts.push(PX.el('span', { className: 'field-note', text: 'No connection of its own. The proxy in Settings applies, if you set one.' }));
            }
            return PX.el('div', { className: 'field' }, parts);
        }

        function profileControl(draft) {
            const choices = [{ value: 'default', label: 'Default' }].concat(state.profiles.map((name) => ({ value: name, label: name })));
            if (draft.profile !== 'default' && !state.profiles.includes(draft.profile)) {
                choices.push({ value: draft.profile, label: draft.profile + ' (not found)' });
            }
            return field('Client settings profile', selectOf(choices, draft.profile, (value) => change({ profile: value })),
                PX.el('span', { className: 'field-note', text: 'Script settings are saved in the profile, so pick the one set up for this script.' }));
        }

        function renderEditor() {
            const draft = state.draft;
            if (!draft) {
                editorEl.replaceChildren(PX.el('div', { className: 'empty' }, [
                    PX.el('strong', { text: 'Launch presets' }),
                    PX.el('br'),
                    'A preset tells a client what to do by itself when it opens: which script to start, which world, breaks, and when to stop.'
                ]));
                return;
            }
            const name = PX.el('input', { className: 'input editor-name', type: 'text', maxlength: '40', value: draft.name, 'aria-label': 'Preset name' });
            name.addEventListener('change', () => change({ name: name.value }));
            const users = state.currentId ? usedBy(state.currentId) : [];

            const save = PX.el('button', { className: 'btn btn-primary', type: 'button', text: state.currentId ? 'Save' : 'Save preset' });
            save.disabled = !state.dirty;
            save.addEventListener('click', () => PX.runBusy(save, saveDraft, 400));
            const buttons = [save];
            if (state.currentId) {
                const remove = PX.el('button', { className: 'btn btn-danger', type: 'button', text: 'Delete' });
                remove.addEventListener('click', () => PX.runBusy(remove, removeCurrent, 400));
                buttons.unshift(remove);
            } else {
                const cancel = PX.el('button', { className: 'btn btn-ghost', type: 'button', text: 'Cancel' });
                cancel.addEventListener('click', () => {
                    state.draft = null;
                    state.dirty = false;
                    open(state.store.presets[0] ? state.store.presets[0].id : null);
                });
                buttons.unshift(cancel);
            }

            editorEl.replaceChildren(
                PX.el('div', { className: 'editor-head' }, [
                    PX.el('div', { className: 'editor-title-wrap' }, [
                        PX.el('span', { className: 'eyebrow', text: 'Launch preset' }),
                        name,
                        PX.el('span', { className: 'editor-used', text: users.length ? 'Used by ' + users.join(', ') : 'Not used by any account yet. Pick it on an account\u2019s card.' })
                    ]),
                    PX.el('div', { className: 'editor-buttons' }, buttons)
                ]),
                PX.el('div', { className: 'editor-grid' }, [
                    PX.el('section', { className: 'card' }, [
                        PX.el('h3', { className: 'card-title' }, [PX.el('span', { className: 'step', text: '1' }), 'Script']),
                        scriptControl(draft),
                        toggle('Start after login', 'Off: the client opens and you press Start yourself', draft.startAfterLogin, (value) => change({ startAfterLogin: value })),
                        field('Wait before starting', selectOf(DELAY_CHOICES, draft.delay, (value) => change({ delay: value })))
                    ]),
                    PX.el('section', { className: 'card' }, [
                        PX.el('h3', { className: 'card-title' }, [PX.el('span', { className: 'step', text: '2' }), 'World and login']),
                        worldControl(draft),
                        toggle('Log in automatically', 'With the Jagex account the client opens for', draft.autoLogin, (value) => change({ autoLogin: value })),
                        profileControl(draft),
                        ramControl(draft),
                        connectionControl(draft)
                    ]),
                    PX.el('section', { className: 'card' }, [
                        PX.el('h3', { className: 'card-title' }, [PX.el('span', { className: 'step', text: '3' }), 'Breaks and stopping']),
                        field('Breaks', selectOf(BREAK_CHOICES, draft.breaks, (value) => change({ breaks: value }))),
                        field('Stop after', selectOf(STOP_CHOICES, draft.stopAfterMinutes, (value) => change({ stopAfterMinutes: Number(value) }))),
                        field('Then', selectOf(THEN_CHOICES, draft.whenStopped, (value) => change({ whenStopped: value }))),
                        PX.el('div', { className: 'how-it-works' }, [
                            PX.el('strong', { text: 'How it works' }),
                            PX.el('br'),
                            'The launcher hands this preset to the client as it opens. Once logged in, the client starts the script with these settings, the same as pressing Start yourself.'
                        ])
                    ])
                ])
            );
        }

        async function saveDraft() {
            const input = clone(state.draft);
            if (state.currentId) {
                input.id = state.currentId;
            }
            const result = await PX.api.savePreset(input);
            if (!result.ok) {
                await PX.showError('Could not save the preset: ' + result.error);
                return;
            }
            setStore(result);
            state.currentId = result.preset.id;
            state.draft = clone(result.preset);
            delete state.draft.id;
            state.dirty = false;
            renderList();
            renderEditor();
        }

        async function removeCurrent() {
            const result = await PX.api.deletePreset(state.currentId);
            if (result.cancelled) {
                return;
            }
            if (!result.ok) {
                await PX.showError('Could not delete the preset: ' + result.error);
                return;
            }
            setStore(result);
            open(state.store.presets[0] ? state.store.presets[0].id : null);
        }

        function open(presetId) {
            const preset = presetId ? presetById(presetId) : null;
            state.currentId = preset ? preset.id : null;
            if (preset) {
                state.draft = clone(preset);
                delete state.draft.id;
            } else {
                state.draft = null;
            }
            state.dirty = false;
            state.vpnWarnings = [];
            state.vpnTest = null;
            renderList();
            renderEditor();
        }

        function startNew() {
            state.currentId = null;
            state.draft = clone(NEW_PRESET);
            state.dirty = true;
            state.vpnWarnings = [];
            state.vpnTest = null;
            renderList();
            renderEditor();
        }

        PX.$('preset-new').addEventListener('click', startNew);

        async function load() {
            try {
                const result = await PX.api.getPresets();
                setStore(result);
            } catch (err) {
                PX.log('warn', 'Could not load the presets: ' + err.message);
            }
            renderList();
        }

        // Called when the view opens: fresh scripts and profiles, then the first preset.
        async function show() {
            const [scripts, profiles] = await Promise.all([
                PX.api.listMyScripts(false).catch(() => ({ ok: false, scripts: [] })),
                PX.api.listProfiles().catch(() => [])
            ]);
            state.scripts = scripts && Array.isArray(scripts.scripts) ? scripts.scripts : [];
            state.scriptsError = scripts && !scripts.ok ? scripts.error : null;
            state.profiles = Array.isArray(profiles) ? profiles : [];
            if (!state.draft) {
                open(state.currentId || (state.store.presets[0] ? state.store.presets[0].id : null));
            } else {
                renderList();
                renderEditor();
            }
        }

        renderList();
        renderEditor();
        return { load, show, store: () => state.store, setStore: (store) => { setStore(store); renderList(); } };
    };
})();
