'use strict';

const crypto = require('crypto');

// The clients this launcher opened and that are still running, for the "Running now" panel.
// A client opened by an earlier run of the launcher is not known here.

function createRunningRegistry({ log, onChange = () => {}, now = () => Date.now() }) {
    const clients = new Map();

    function view(entry) {
        return {
            id: entry.id,
            label: entry.label,
            accountId: entry.accountId,
            presetName: entry.presetName,
            scriptName: entry.scriptName,
            startedAt: entry.startedAt
        };
    }

    function changed() {
        try {
            onChange(list());
        } catch (err) {
            log.warn('Could not report running clients: ' + err.message);
        }
    }

    function list() {
        return Array.from(clients.values()).map(view).sort((a, b) => a.startedAt - b.startedAt);
    }

    return {
        list,
        add(child, details) {
            const id = crypto.randomBytes(6).toString('hex');
            const entry = {
                id,
                child,
                label: details.label || 'Client',
                accountId: details.accountId || null,
                presetName: details.presetName || null,
                scriptName: details.scriptName || null,
                startedAt: now()
            };
            clients.set(id, entry);
            child.once('exit', () => {
                clients.delete(id);
                changed();
            });
            child.once('error', () => {
                clients.delete(id);
                changed();
            });
            changed();
            return id;
        },
        close(id) {
            const entry = clients.get(id);
            if (!entry) {
                return { ok: false, error: 'That client has already closed.' };
            }
            try {
                entry.child.kill();
                return { ok: true };
            } catch (err) {
                log.warn('Could not close a client: ' + err.message);
                return { ok: false, error: 'The client could not be closed: ' + err.message };
            }
        }
    };
}

module.exports = { createRunningRegistry };
