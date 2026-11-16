'use strict';

(function () {
    const PX = window.PX;
    const NEWS_REFRESH_MS = 15 * 60 * 1000;
    const CLOCK_MS = 30 * 1000;

    function elapsed(startedAt, now) {
        const minutes = Math.max(0, Math.floor((now - startedAt) / 60000));
        if (minutes < 1) {
            return 'just now';
        }
        const hours = Math.floor(minutes / 60);
        return hours > 0 ? hours + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
    }

    function when(iso, now) {
        const time = Date.parse(iso);
        if (!Number.isFinite(time)) {
            return '';
        }
        const days = Math.floor((now - time) / 86400000);
        if (days <= 0) {
            return 'Today';
        }
        if (days === 1) {
            return 'Yesterday';
        }
        if (days < 7) {
            return days + ' days ago';
        }
        return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }

    // The activity column: clients opened by this launcher, and recent updates.
    const LIVE_REFRESH_MS = 15 * 1000;

    function perHour(value) {
        if (typeof value !== 'number' || value <= 0) {
            return null;
        }
        return value >= 1000 ? Math.round(value / 100) / 10 + 'k xp/h' : Math.round(value) + ' xp/h';
    }

    function liveLine(live) {
        const state = live.state;
        if (!state) {
            return 'Live status is off in this client';
        }
        if (!state.loggedIn) {
            return 'At the login screen';
        }
        const parts = [];
        if (state.breakActive) {
            parts.push('On a break');
        }
        if (state.world) {
            parts.push('World ' + state.world);
        }
        return parts.join(' \u00B7 ') || 'Logged in';
    }

    // The activity column: clients opened by this launcher, live status from the site, and updates.
    PX.createSide = function createSide({ onRunningChange, getAccounts }) {
        const runningList = PX.$('running-list');
        const newsList = PX.$('news-list');
        let clients = [];
        let live = [];
        let liveNote = null;

        // A local client and a live one are the same when the live one reports the player name
        // of the account the local one was opened for.
        function accountNameOf(client) {
            const accounts = getAccounts ? getAccounts() : [];
            const account = client.accountId ? accounts.find((item) => item.accountId === client.accountId) : null;
            return account && account.displayName ? account.displayName.toLowerCase() : null;
        }

        function merged() {
            const used = new Set();
            const rows = clients.map((client) => {
                const name = accountNameOf(client);
                const match = name ? live.find((item) => !used.has(item.id) && item.state && item.state.name && item.state.name.toLowerCase() === name) : null;
                if (match) {
                    used.add(match.id);
                }
                return { local: client, live: match || null };
            });
            for (const item of live) {
                if (!used.has(item.id)) {
                    rows.push({ local: null, live: item });
                }
            }
            return rows;
        }

        function stopButton(liveClient, script) {
            const button = PX.el('button', { className: 'btn btn-small run-close', type: 'button', text: script ? 'Stop script' : 'Stop all' });
            if (!liveClient.remoteControl) {
                button.disabled = true;
                button.title = 'Turn on website control in the client\u2019s Control Panel settings to stop scripts from here';
            }
            button.addEventListener('click', () => PX.runBusy(button, async () => {
                const result = await PX.api.stopRemote(liveClient.id, script && script.internalName ? script.internalName : null);
                if (!result.ok) {
                    await PX.showError(result.error);
                    return;
                }
                button.textContent = 'Stopping\u2026';
                setTimeout(refreshLive, 3000);
            }));
            return button;
        }

        function card({ local, live: liveClient }, now) {
            const label = local ? local.label : (liveClient.state && liveClient.state.name) || liveClient.label || 'Client';
            const started = local ? local.startedAt : null;
            const scripts = liveClient && liveClient.state ? liveClient.state.scripts : [];
            const script = scripts[0] || null;
            const parts = [
                PX.el('div', { className: 'run-top' }, [
                    PX.el('span', { className: 'run-name', text: label, title: label }),
                    PX.el('span', { className: 'run-time', text: '\u25CF ' + elapsed(script && script.startedAt ? script.startedAt : started || now, now) })
                ]),
                PX.el('span', { className: 'run-script', text: script ? script.name : local && local.scriptName ? local.scriptName : 'No script running' })
            ];
            if (script && script.status) {
                parts.push(PX.el('span', { className: 'run-note', text: script.status }));
            }
            const details = [];
            if (liveClient) {
                details.push(liveLine(liveClient));
                const rate = script ? perHour(script.xpPerHour) : null;
                if (rate) {
                    details.push(rate);
                }
            } else if (local && local.presetName) {
                details.push('Preset: ' + local.presetName);
            }
            if (details.length) {
                parts.push(PX.el('span', { className: 'run-note', text: details.join(' \u00B7 ') }));
            }
            if (!liveClient && local && liveNote === null) {
                parts.push(PX.el('span', { className: 'run-note', text: 'Live progress shows once it has logged in.' }));
            }
            const buttons = [];
            if (liveClient && script) {
                buttons.push(stopButton(liveClient, script));
            }
            if (local) {
                const close = PX.el('button', { className: 'btn btn-small run-close', type: 'button', text: 'Close client' });
                close.addEventListener('click', () => PX.runBusy(close, async () => {
                    const result = await PX.api.closeClient(local.id);
                    if (!result.ok) {
                        await PX.showError(result.error);
                    }
                }));
                buttons.push(close);
            }
            if (buttons.length) {
                parts.push(PX.el('div', { className: 'run-buttons' }, buttons));
            }
            return PX.el('div', { className: 'run-card' }, parts);
        }

        function renderRunning() {
            const now = Date.now();
            const rows = merged();
            const items = rows.map((row) => card(row, now));
            if (liveNote) {
                items.push(PX.el('p', { className: 'side-empty', text: liveNote }));
            }
            if (rows.length === 0) {
                items.unshift(PX.el('p', { className: 'side-empty', text: 'Nothing running. Clients you open from here show up with their preset and script.' }));
            }
            runningList.replaceChildren(...items);
        }

        async function refreshLive() {
            let result;
            try {
                result = await PX.api.listLiveClients();
            } catch (_) {
                result = { ok: false, clients: [] };
            }
            live = result && result.ok && Array.isArray(result.clients) ? result.clients : [];
            liveNote = result && result.membersOnly ? result.error : null;
            renderRunning();
        }

        function setRunning(list) {
            clients = Array.isArray(list) ? list : [];
            renderRunning();
            onRunningChange(clients);
        }

        async function refreshNews(force) {
            let result;
            try {
                result = await PX.api.getNews(Boolean(force));
            } catch (err) {
                result = { ok: false, items: [] };
            }
            const items = result && Array.isArray(result.items) ? result.items : [];
            if (items.length === 0) {
                newsList.replaceChildren(PX.el('p', { className: 'side-empty', text: result && result.ok ? 'No updates yet.' : 'Updates could not be loaded right now.' }));
                return;
            }
            const now = Date.now();
            newsList.replaceChildren(...items.map((item) => PX.el('div', { className: 'news-item' }, [
                PX.el('span', { className: 'news-when', text: when(item.at, now) + ' \u00B7 ' + (item.kind === 'client' ? 'Client' : 'Script update') }),
                PX.el('span', { className: 'news-title', text: item.title }),
                item.text ? PX.el('span', { className: 'news-text', text: item.text }) : null
            ])));
        }

        async function start() {
            PX.api.onRunningChanged(setRunning);
            try {
                const result = await PX.api.listRunning();
                setRunning(result && result.clients);
            } catch (err) {
                setRunning([]);
            }
            refreshNews(false);
            setInterval(() => refreshNews(false), NEWS_REFRESH_MS);
            refreshLive();
            setInterval(() => {
                if (!document.hidden) {
                    refreshLive();
                }
            }, LIVE_REFRESH_MS);
            setInterval(renderRunning, CLOCK_MS);
        }

        renderRunning();
        return { start, refreshNews, clients: () => clients };
    };
})();
