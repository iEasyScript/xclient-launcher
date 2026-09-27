const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Signing the launcher in to a Project X account.
 *
 * The launcher never sees a password and never talks to Discord. It asks the
 * website to start a pairing, sends the user there to approve it with the
 * Discord sign-in they already have, and polls until an API token comes back.
 * That token is what identifies the user to the client -- who they are, what
 * they have bought, and whether they get developer tooling.
 *
 * Shipping a Discord client secret inside an Electron app would leak it to
 * anyone who opened the asar, which is why the pairing hop exists at all.
 */

/**
 * Matches ProjectXSite.java in the client. Override with PROJECTX_SITE_URL to
 * point a development launcher at a local site.
 */
const DEFAULT_SITE_URL = 'https://xclient.dev';

/** Long enough for a user to find the browser window and click a button. */
const PAIRING_TIMEOUT_MS = 10 * 60 * 1000;

const SESSION_FILE = 'projectx-session.json';

function siteUrl() {
    const configured = (process.env.PROJECTX_SITE_URL || '').trim();
    return (configured || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function apiUrl(...segments) {
    return `${siteUrl()}/api/v1/${segments.join('/')}`;
}

/**
 * Sets up the account IPC channels.
 * @param {{ipcMain: import('electron').IpcMain, app: import('electron').App, shell: import('electron').Shell, log: import('electron-log')}} deps
 */
module.exports = function setupProjectXAccount(deps) {
    const { ipcMain, app, shell, log } = deps;

    const sessionPath = path.join(app.getPath('userData'), SESSION_FILE);

    /** The pairing currently being polled, if any. Only one at a time. */
    let pending = null;

    function readSession() {
        try {
            const raw = fs.readFileSync(sessionPath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed.token === 'string' ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function writeSession(session) {
        try {
            fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
            /**
             * 0600: the token is a bearer credential for the user's account, and
             * the default on a shared machine would let any other account read
             * it. Windows ignores the mode, so this is a POSIX-only guarantee.
             */
            fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), {
                mode: 0o600
            });
            return true;
        } catch (error) {
            log.error('Could not save the Project X session:', error);
            return false;
        }
    }

    function clearSession() {
        try {
            fs.unlinkSync(sessionPath);
        } catch (_) {
            /* already gone */
        }
    }

    /**
     * The token the client should run with, or null. Read at launch time rather
     * than cached, so signing out between launches takes effect.
     */
    function currentToken() {
        const session = readSession();
        return session ? session.token : null;
    }

    async function postJson(url, body) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (_) {
            /* a non-JSON body is handled by the status check below */
        }

        return { status: response.status, payload };
    }

    async function fetchMe(token) {
        try {
            const response = await fetch(apiUrl('me'), {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) {
                return { ok: false, status: response.status };
            }
            return { ok: true, user: await response.json() };
        } catch (error) {
            // Offline is not signed out: the stored token is still good, so the
            // caller keeps showing the cached identity.
            log.info('Could not reach the site to refresh the account:', error.message);
            return { ok: false, offline: true };
        }
    }

    /**
     * Who is signed in, as far as this machine knows.
     *
     * Returns the cached identity immediately and refreshes it from the site in
     * the same call, so a role granted on the website appears on the next open
     * of the launcher without the user signing in again.
     */
    ipcMain.handle('projectx:session', async () => {
        const session = readSession();
        if (!session) {
            return { signedIn: false, siteUrl: siteUrl() };
        }

        const refreshed = await fetchMe(session.token);

        if (refreshed.ok) {
            const updated = { ...session, user: refreshed.user, refreshedAt: Date.now() };
            writeSession(updated);
            return { signedIn: true, user: refreshed.user, siteUrl: siteUrl() };
        }

        // A token the site actively rejects is dead: drop it rather than leaving
        // the user looking at a signed-in launcher that cannot buy anything.
        if (refreshed.status === 401 || refreshed.status === 403) {
            clearSession();
            return {
                signedIn: false,
                siteUrl: siteUrl(),
                message: 'Your session expired. Sign in again.'
            };
        }

        return { signedIn: true, user: session.user || null, stale: true, siteUrl: siteUrl() };
    });

    /**
     * Starts a pairing and opens the browser at the approval page. Resolves as
     * soon as the code exists so the renderer can show it; the polling that
     * follows reports back over 'projectx:pair-update'.
     */
    ipcMain.handle('projectx:pair-start', async (event) => {
        try {
            const { status, payload } = await postJson(apiUrl('pair', 'start'), {
                label: `${os.hostname()} (${process.platform})`
            });

            if (status !== 200 || !payload || !payload.deviceCode) {
                return {
                    error:
                        (payload && payload.message) ||
                        `The site could not start a sign-in (HTTP ${status}).`
                };
            }

            pending = { deviceCode: payload.deviceCode, cancelled: false };

            // Opened in the real browser, not a window we control: the user is
            // typing Discord credentials, and they should be able to see the
            // address bar and their own password manager.
            shell.openExternal(payload.verificationUrlComplete).catch((error) => {
                log.error('Could not open the browser for pairing:', error);
            });

            pollUntilResolved(event.sender, pending, payload).catch((error) => {
                log.error('Pairing failed:', error);
            });

            return {
                userCode: payload.userCode,
                verificationUrl: payload.verificationUrlComplete,
                expiresAt: payload.expiresAt
            };
        } catch (error) {
            log.error('Could not start pairing:', error);
            return { error: 'Could not reach the Project X site. Check your connection.' };
        }
    });

    ipcMain.handle('projectx:pair-cancel', async () => {
        if (pending) {
            pending.cancelled = true;
            pending = null;
        }
        return { cancelled: true };
    });

    ipcMain.handle('projectx:signout', async () => {
        clearSession();
        if (pending) {
            pending.cancelled = true;
            pending = null;
        }
        return { signedIn: false };
    });

    async function pollUntilResolved(sender, pairing, start) {
        const intervalMs = Math.max(1, Number(start.pollSeconds) || 3) * 1000;
        const deadline = Date.now() + PAIRING_TIMEOUT_MS;

        const report = (message) => {
            if (!sender.isDestroyed()) sender.send('projectx:pair-update', message);
        };

        while (!pairing.cancelled && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            if (pairing.cancelled) return;

            let result;
            try {
                result = await postJson(apiUrl('pair', 'poll'), {
                    deviceCode: pairing.deviceCode
                });
            } catch (error) {
                // A blip while the user is in the browser should not end the
                // sign-in; keep polling until the pairing itself expires.
                log.info('Pairing poll failed, retrying:', error.message);
                continue;
            }

            if (result.status === 202) continue;

            if (result.status === 200 && result.payload && result.payload.token) {
                const saved = writeSession({
                    token: result.payload.token,
                    user: result.payload.user || null,
                    createdAt: Date.now()
                });

                if (pending === pairing) pending = null;

                report(
                    saved
                        ? { state: 'signed-in', user: result.payload.user || null }
                        : {
                              state: 'error',
                              message:
                                  'Signed in, but the session could not be saved to disk.'
                          }
                );
                return;
            }

            if (pending === pairing) pending = null;
            report({
                state: 'error',
                message:
                    (result.payload && result.payload.message) ||
                    'That sign-in could not be completed. Try again.'
            });
            return;
        }

        if (!pairing.cancelled) {
            if (pending === pairing) pending = null;
            report({ state: 'error', message: 'The sign-in timed out. Try again.' });
        }
    }

    return { currentToken, siteUrl };
};
