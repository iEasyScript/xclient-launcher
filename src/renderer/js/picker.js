'use strict';

(function () {
    const PX = window.PX;
    const { accountLabel } = window.PXFormat;

    // Searchable account dropdown with a delete button on each row.
    PX.createPicker = function createPicker({ root, onSelect, onDelete }) {
        let accounts = [];
        let nicknames = {};
        let selectedId = null;
        let isOpen = false;
        let query = '';

        const toggle = PX.el('button', {
            className: 'picker-toggle',
            type: 'button',
            'aria-haspopup': 'listbox',
            'aria-expanded': 'false',
            'aria-labelledby': 'account-label'
        });
        const label = PX.el('span', { className: 'picker-label' });
        const badge = PX.el('span', { className: 'count-badge' });
        const caret = PX.el('span', { className: 'picker-caret', 'aria-hidden': 'true', text: '\u25BE' });
        toggle.append(label, badge, caret);

        const panel = PX.el('div', { className: 'popup picker-panel', hidden: true });
        const search = PX.el('input', {
            className: 'input',
            type: 'text',
            placeholder: 'Search accounts\u2026',
            'aria-label': 'Search accounts',
            spellcheck: 'false',
            autocomplete: 'off'
        });
        const list = PX.el('div', { className: 'picker-list', role: 'listbox', 'aria-label': 'Jagex accounts' });
        panel.append(PX.el('div', { className: 'picker-search' }, search), list);
        root.replaceChildren(toggle, panel);

        function labelFor(id) {
            const account = accounts.find((item) => item.accountId === id);
            return account ? accountLabel(account, nicknames) : null;
        }

        function renderToggle() {
            badge.textContent = String(accounts.length);
            if (selectedId === null) {
                label.textContent = 'None';
                toggle.title = 'No Jagex account selected';
            } else {
                const text = labelFor(selectedId);
                label.textContent = text || 'Select Jagex account';
                toggle.title = text ? 'Selected ' + text : 'Select Jagex account';
            }
            toggle.setAttribute('aria-label', toggle.title);
        }

        function row(id, text, withTrash) {
            const selected = id === selectedId;
            const name = PX.el('button', {
                className: 'picker-name',
                type: 'button',
                title: id === null ? 'Use no Jagex account' : 'Select ' + text,
                text
            });
            name.addEventListener('click', () => choose(id));
            const children = [name];
            if (withTrash) {
                const trash = PX.el('button', {
                    className: 'picker-trash',
                    type: 'button',
                    title: 'Delete ' + text,
                    'aria-label': 'Delete ' + text,
                    text: '\uD83D\uDDD1\uFE0F'
                });
                trash.addEventListener('click', (event) => {
                    event.stopPropagation();
                    close(false);
                    onDelete(id);
                });
                children.push(trash);
            }
            return PX.el('div', {
                className: 'picker-row',
                role: 'option',
                'aria-selected': selected ? 'true' : 'false'
            }, children);
        }

        function renderList() {
            const needle = query.trim().toLowerCase();
            const rows = [];
            if (!needle || 'none'.includes(needle)) {
                rows.push(row(null, 'None', false));
            }
            for (const account of accounts) {
                const text = accountLabel(account, nicknames);
                if (!needle || text.toLowerCase().includes(needle)) {
                    rows.push(row(account.accountId, text, true));
                }
            }
            if (rows.length === 0) {
                rows.push(PX.el('div', { className: 'picker-empty', text: 'No accounts match your search.' }));
            }
            list.replaceChildren(...rows);
        }

        function onDocumentDown(event) {
            if (!root.contains(event.target)) {
                close(false);
            }
        }

        function onDocumentKey(event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close(true);
            }
        }

        function open() {
            if (isOpen) {
                return;
            }
            isOpen = true;
            query = '';
            search.value = '';
            renderList();
            panel.hidden = false;
            root.classList.add('open');
            toggle.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onDocumentDown, true);
            document.addEventListener('keydown', onDocumentKey, true);
            search.focus();
        }

        function close(returnFocus) {
            if (!isOpen) {
                return;
            }
            isOpen = false;
            panel.hidden = true;
            root.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocumentDown, true);
            document.removeEventListener('keydown', onDocumentKey, true);
            if (returnFocus) {
                toggle.focus();
            }
        }

        function choose(id) {
            selectedId = id;
            close(true);
            renderToggle();
            onSelect(id);
        }

        toggle.addEventListener('click', () => (isOpen ? close(true) : open()));
        search.addEventListener('input', () => {
            query = search.value;
            renderList();
        });

        return {
            render(state) {
                accounts = state.accounts;
                nicknames = state.nicknames;
                selectedId = state.selectedId;
                renderToggle();
                if (isOpen) {
                    renderList();
                }
            },
            close: () => close(false)
        };
    };
})();
