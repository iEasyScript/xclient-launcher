'use strict';

(function () {
    const PX = window.PX;
    const F = window.PXFormat;
    const OK_RECENT_MS = 30 * 60 * 1000;
    const OTHER_RECENT_MS = 2 * 60 * 1000;
    const RENDER_COALESCE_MS = 60;
    const REFRESH_COOLDOWN_MS = 3000;
    const PERIODIC_MS = 5 * 60 * 1000;

    // The "Your accounts" panel over the hero. Read-only: nothing in it logs in or launches.
    PX.createPanel = function createPanel({ getState, onPanelChange, onNicknamesSaved }) {
        const root = PX.$('accounts-panel');
        const toggle = PX.$('panel-toggle');
        const count = PX.$('panel-count');
        const list = PX.$('panel-list');
        const refresh = PX.$('panel-refresh');
        const hide = PX.$('panel-hide');

        const results = new Map();
        const inFlight = new Set();
        const openSkills = new Set();
        let editingId = null;
        let renderTimer = null;

        function key(name) {
            return name.toLowerCase();
        }

        function isVisible() {
            const { accounts, panel } = getState();
            return accounts.length > 0 && !panel.hidden;
        }

        function scheduleRender() {
            if (renderTimer) {
                return;
            }
            renderTimer = setTimeout(() => {
                renderTimer = null;
                render();
            }, RENDER_COALESCE_MS);
        }

        function requestLookups(force) {
            if (!isVisible()) {
                return;
            }
            for (const account of getState().accounts) {
                const name = F.displayName(account);
                if (!name) {
                    continue;
                }
                const k = key(name);
                if (inFlight.has(k)) {
                    continue;
                }
                const previous = results.get(k);
                if (previous && !force) {
                    const limit = previous.status === 'ok' ? OK_RECENT_MS : OTHER_RECENT_MS;
                    if (Date.now() - previous.receivedAt < limit) {
                        continue;
                    }
                }
                inFlight.add(k);
                PX.api.lookupHiscores(name, Boolean(force))
                    .then((result) => results.set(k, { ...result, receivedAt: Date.now() }))
                    .catch(() => results.set(k, { status: 'error', message: 'Lookup failed.', receivedAt: Date.now() }))
                    .finally(() => {
                        inFlight.delete(k);
                        scheduleRender();
                    });
            }
        }

        function stat(value, label, title) {
            return PX.el('div', { className: 'stat', title: title || null }, [
                PX.el('div', { className: 'stat-value', text: value }),
                PX.el('div', { className: 'stat-label', text: label })
            ]);
        }

        function progressFor(account, name) {
            if (!name) {
                return PX.el('div', { className: 'card-note', text: 'This account has no display name yet, so there is nothing to look up.' });
            }
            const result = results.get(key(name));
            if (!result) {
                return PX.el('div', { className: 'card-note', text: 'Checking the hiscores\u2026' });
            }
            if (result.status === 'not-found') {
                return PX.el('div', { className: 'card-note', text: 'This name is not on the hiscores yet. New accounts and recent name changes can take a while to appear.' });
            }
            if (result.status === 'invalid') {
                return PX.el('div', { className: 'card-note warning', text: 'This name cannot be looked up on the hiscores.' });
            }
            if (result.status !== 'ok' || !result.data) {
                return PX.el('div', { className: 'card-note warning', text: result.message || 'The hiscores are unavailable right now.' });
            }
            const data = result.data;
            const totalTitle = data.totalLevelApproximate
                ? 'Overall is unranked, so this adds up the ranked skills.'
                : (typeof data.overallRank === 'number' ? 'Overall rank ' + F.formatNumber(data.overallRank) : null);
            const stats = PX.el('div', { className: 'stats' }, [
                stat((data.totalLevelApproximate ? '~' : '') + F.formatNumber(data.totalLevel), 'Total', totalTitle),
                stat((data.combatApproximate ? '~' : '') + F.formatNumber(data.combatLevel), 'Combat',
                    data.combatApproximate ? 'A combat skill is unranked, so this may be a little low.' : null),
                stat(F.formatXpCompact(data.totalXp), 'XP', typeof data.totalXp === 'number' ? F.formatNumber(data.totalXp) + ' XP' : null)
            ]);
            const best = (data.topSkills || []).map((skill) => skill.name + ' ' + skill.level).join(' \u00B7 ');
            const children = [stats];
            if (best) {
                children.push(PX.el('div', { className: 'best-line', title: 'Best: ' + best, text: 'Best: ' + best }));
            }
            const details = PX.el('details', { className: 'all-skills' });
            details.open = openSkills.has(account.accountId);
            details.addEventListener('toggle', () => {
                if (details.open) {
                    openSkills.add(account.accountId);
                } else {
                    openSkills.delete(account.accountId);
                }
            });
            const cells = (data.skills || []).map((skill) => {
                const ranked = skill.ranked && typeof skill.level === 'number';
                return PX.el('div', {
                    className: 'skill-cell' + (ranked ? '' : ' unranked'),
                    title: ranked ? skill.name + ' ' + skill.level + ' (' + F.formatNumber(skill.xp) + ' XP)' : skill.name + ': not ranked'
                }, [
                    PX.el('span', { text: F.skillAbbreviation(skill.name) }),
                    PX.el('span', { className: 'skill-level', text: ranked ? String(skill.level) : F.DASH })
                ]);
            });
            details.append(PX.el('summary', { text: 'All skills' }), PX.el('div', { className: 'skill-grid' }, cells));
            children.push(details);
            return PX.el('div', null, children);
        }

        function startEditing(account) {
            if (editingId !== null) {
                return;
            }
            editingId = account.accountId;
            render(true);
        }

        async function finishEditing(account, input, save) {
            if (editingId !== account.accountId) {
                return;
            }
            editingId = null;
            let saved = null;
            if (save) {
                try {
                    const result = await PX.api.setNickname(account.accountId, input.value);
                    if (result && result.ok) {
                        saved = result.nicknames;
                    } else {
                        await PX.showError('Could not save the nickname: ' + (result ? result.error : 'unknown error'));
                    }
                } catch (err) {
                    await PX.showError('Could not save the nickname: ' + err.message);
                }
            }
            onNicknamesSaved(saved);
        }

        function card(account, nicknames) {
            const name = F.displayName(account);
            const nickname = nicknames[account.accountId];
            const subject = name || 'this account';
            const head = PX.el('div', { className: 'card-head' });
            const body = PX.el('div', { className: 'account-card' }, head);

            if (editingId === account.accountId) {
                const input = PX.el('input', {
                    className: 'nickname-input',
                    type: 'text',
                    maxlength: '24',
                    placeholder: 'Nickname, e.g. WC account',
                    spellcheck: 'false',
                    autocomplete: 'off',
                    'aria-label': 'Nickname for ' + subject
                });
                input.value = nickname || '';
                let done = false;
                const end = (save) => {
                    if (!done) {
                        done = true;
                        finishEditing(account, input, save);
                    }
                };
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        end(true);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        end(false);
                    }
                });
                input.addEventListener('blur', () => end(true));
                head.append(PX.el('div', { className: 'card-names' }, [
                    input,
                    PX.el('div', { className: 'nickname-hint', text: 'Enter saves, Esc cancels, empty removes it.' })
                ]));
                setTimeout(() => {
                    input.focus();
                    input.select();
                }, 0);
            } else {
                const names = PX.el('div', { className: 'card-names' });
                if (nickname) {
                    names.append(
                        PX.el('div', { className: 'card-name', title: nickname, text: nickname }),
                        PX.el('div', { className: 'card-subname', title: name || 'Name not set', text: name || 'Name not set' })
                    );
                } else {
                    names.append(PX.el('div', { className: 'card-name', title: name || 'Name not set', text: name || 'Name not set' }));
                }
                const tip = nickname ? 'Change the nickname for ' + subject : 'Give ' + subject + ' a nickname';
                const pencil = PX.el('button', { className: 'pencil-button', type: 'button', title: tip, 'aria-label': tip, text: '\u270E' });
                pencil.addEventListener('click', () => startEditing(account));
                head.append(names, pencil);
            }

            const progress = PX.el('div', { className: 'card-progress' }, progressFor(account, name));
            const result = name ? results.get(key(name)) : null;
            if (result && typeof result.fetchedAt === 'number') {
                progress.title = 'Hiscores checked ' + F.relativeTime(result.fetchedAt, Date.now());
            }
            body.append(progress);
            return body;
        }

        function render(force) {
            const { accounts, nicknames, panel } = getState();
            const visible = accounts.length > 0 && !panel.hidden;
            root.hidden = !visible;
            if (!visible) {
                return;
            }
            root.classList.toggle('collapsed', panel.collapsed);
            toggle.setAttribute('aria-expanded', panel.collapsed ? 'false' : 'true');
            count.textContent = String(accounts.length);
            // Rebuilding while a nickname is being typed would throw the input away.
            if (editingId !== null && !force) {
                return;
            }
            list.replaceChildren(...accounts.map((account) => card(account, nicknames)));
            requestLookups(false);
        }

        toggle.addEventListener('click', () => onPanelChange({ collapsed: !getState().panel.collapsed }));
        hide.addEventListener('click', () => onPanelChange({ hidden: true }));
        refresh.addEventListener('click', () => {
            refresh.disabled = true;
            requestLookups(true);
            setTimeout(() => {
                refresh.disabled = false;
            }, REFRESH_COOLDOWN_MS);
        });
        setInterval(() => requestLookups(false), PERIODIC_MS);

        return {
            render: () => render(false),
            isEditing: () => editingId !== null
        };
    };
})();
