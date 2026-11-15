'use strict';

(function () {
    const PX = window.PX;
    const LEAVE_DELAY_MS = 200;

    // The hamburger menu. onTogglePanel is called for the "Accounts panel" item.
    PX.createMenu = function createMenu({ onTogglePanel }) {
        const button = PX.$('menu-button');
        const menu = PX.$('app-menu');
        const panelItem = PX.$('menu-panel');
        const subWrap = menu.querySelector('.menu-sub-wrap');
        let leaveTimer = null;

        function isOpen() {
            return !menu.hidden;
        }

        function open() {
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onKey, true);
        }

        function close() {
            clearTimeout(leaveTimer);
            // The submenu lives inside the menu, so hiding the menu hides both in the same frame.
            menu.hidden = true;
            subWrap.classList.remove('open');
            button.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onKey, true);
        }

        function onOutside(event) {
            if (!menu.contains(event.target) && !button.contains(event.target)) {
                close();
            }
        }

        function onKey(event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
                button.focus();
            }
        }

        button.addEventListener('click', () => (isOpen() ? close() : open()));
        menu.addEventListener('mouseleave', () => {
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(close, LEAVE_DELAY_MS);
        });
        menu.addEventListener('mouseenter', () => clearTimeout(leaveTimer));

        PX.$('menu-open').addEventListener('click', () => subWrap.classList.toggle('open'));
        panelItem.addEventListener('click', () => {
            close();
            onTogglePanel();
        });
        for (const item of menu.querySelectorAll('[data-location]')) {
            item.addEventListener('click', () => {
                close();
                PX.api.openLocation(item.dataset.location).catch((err) => PX.log('warn', 'Open failed: ' + err.message));
            });
        }

        return {
            close,
            setPanelShown(shown) {
                panelItem.setAttribute('aria-checked', shown ? 'true' : 'false');
            },
            // The Open items (folders and logs) stay usable while signed out, so people can still
            // find their logs for support; only items that need a session are disabled.
            setSignedIn(signedIn) {
                panelItem.disabled = !signedIn;
                panelItem.setAttribute('aria-disabled', signedIn ? 'false' : 'true');
            }
        };
    };
})();
