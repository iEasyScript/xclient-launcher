'use strict';

(function () {
    const PX = (window.PX = window.PX || {});
    const api = window.launcher;

    PX.api = api;

    PX.$ = (id) => document.getElementById(id);

    // Builds an element. Text is always set as text, never parsed as HTML.
    PX.el = function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) {
            for (const [key, value] of Object.entries(props)) {
                if (value === undefined || value === null || value === false) {
                    continue;
                }
                if (key === 'className') {
                    node.className = value;
                } else if (key === 'text') {
                    node.textContent = value;
                } else if (key.startsWith('on') && typeof value === 'function') {
                    node.addEventListener(key.slice(2).toLowerCase(), value);
                } else if (value === true) {
                    node.setAttribute(key, '');
                } else {
                    node.setAttribute(key, String(value));
                }
            }
        }
        for (const child of [].concat(children || [])) {
            if (child !== null && child !== undefined && child !== false) {
                node.append(child instanceof Node ? child : document.createTextNode(String(child)));
            }
        }
        return node;
    };

    PX.log = function log(level, message) {
        try {
            api.log(level, String(message).slice(0, 4000)).catch(() => {});
        } catch (_) {
            // logging must never break the UI
        }
    };

    PX.showError = function showError(message) {
        return api.showError(String(message).slice(0, 2000)).catch((err) => PX.log('warn', 'Could not show an error: ' + err.message));
    };

    PX.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Spinner for about a second on click, and disabled until the action settles, so a double click
    // cannot start something twice.
    PX.runBusy = async function runBusy(button, action, minimumMs = 1000) {
        if (button.classList.contains('busy') || button.disabled) {
            return undefined;
        }
        button.classList.add('busy');
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const started = Date.now();
        try {
            return await action();
        } finally {
            const left = minimumMs - (Date.now() - started);
            if (left > 0) {
                await PX.sleep(left);
            }
            button.classList.remove('busy');
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    };

    window.addEventListener('error', (event) => {
        PX.log('error', 'Uncaught error: ' + (event.message || 'unknown') + (event.filename ? ' at ' + event.filename.split('/').pop() + ':' + event.lineno : ''));
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        PX.log('error', 'Unhandled rejection: ' + reason);
    });
})();
