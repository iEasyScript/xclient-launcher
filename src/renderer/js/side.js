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
    PX.createSide = function createSide({ onRunningChange }) {
        const runningList = PX.$('running-list');
        const newsList = PX.$('news-list');
        let clients = [];

        function renderRunning() {
            const now = Date.now();
            if (clients.length === 0) {
                runningList.replaceChildren(PX.el('p', { className: 'side-empty', text: 'Nothing running. Clients you open from here show up with their preset and script.' }));
                return;
            }
            runningList.replaceChildren(...clients.map((client) => {
                const close = PX.el('button', { className: 'btn btn-small run-close', type: 'button', text: 'Close client' });
                close.addEventListener('click', () => PX.runBusy(close, async () => {
                    const result = await PX.api.closeClient(client.id);
                    if (!result.ok) {
                        await PX.showError(result.error);
                    }
                }));
                return PX.el('div', { className: 'run-card' }, [
                    PX.el('div', { className: 'run-top' }, [
                        PX.el('span', { className: 'run-name', text: client.label, title: client.label }),
                        PX.el('span', { className: 'run-time', text: '\u25CF ' + elapsed(client.startedAt, now) })
                    ]),
                    PX.el('span', { className: 'run-script', text: client.scriptName || 'No script set to start' }),
                    client.presetName ? PX.el('span', { className: 'run-note', text: 'Preset: ' + client.presetName }) : null,
                    close
                ]);
            }));
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
            setInterval(renderRunning, CLOCK_MS);
        }

        renderRunning();
        return { start, refreshNews, clients: () => clients };
    };
})();
