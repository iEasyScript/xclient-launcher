'use strict';

const fs = require('fs');
const os = require('os');
const { readJson, writeJson, isPlainObject } = require('./fsutil');
const { request, errorMessage } = require('./http');
const { isSiteUrl } = require('./site');

const SESSION_MODE = 0o600;
const PAIRING_DEADLINE_MS = 10 * 60 * 1000;
const DEFAULT_POLL_SECONDS = 3;
const EXPIRED_MESSAGE = 'Your session expired. Sign in again.';

function pollIntervalMs(value) {
    const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.max(1, value) : DEFAULT_POLL_SECONDS;
    return seconds * 1000;
}

// Project X sign-in: the session file, the /me refresh and the device-pairing flow.
function createAccountService(options) {
    const {
        sessionFile,
        siteUrl,
        fetch: fetchImpl,
        openExternal,
        copyText = () => {},
        notify,
        log,
        hostname = os.hostname(),
        platform = process.platform,
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    } = options;

    let pending = null;

    function readSession() {
        const result = readJson(sessionFile);
        if (result.status !== 'ok' || !isPlainObject(result.value) || typeof result.value.token !== 'string' || !result.value.token) {
            return null;
        }
        return result.value;
    }

    function writeSession(session) {
        writeJson(sessionFile, session, { mode: SESSION_MODE });
    }

    function deleteSession() {
        try {
            fs.unlinkSync(sessionFile);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
    }

    function readToken() {
        const session = readSession();
        return session ? session.token : null;
    }

    async function getSession() {
        const session = readSession();
        if (!session) {
            return { signedIn: false, siteUrl };
        }
        try {
            const response = await request(fetchImpl, siteUrl + '/api/v1/me', {
                headers: { Authorization: 'Bearer ' + session.token, Accept: 'application/json' }
            });
            if (response.status === 200) {
                const user = response.body;
                if (isPlainObject(user)) {
                    const updated = { ...session, user, refreshedAt: now() };
                    try {
                        writeSession(updated);
                    } catch (err) {
                        log.warn('Could not save the refreshed Project X session: ' + err.message);
                    }
                    return { signedIn: true, user, stale: false, siteUrl };
                }
            } else if (response.status === 401 || response.status === 403) {
                log.info('Project X session was rejected by the site (HTTP ' + response.status + ')');
                try {
                    deleteSession();
                } catch (err) {
                    log.warn('Could not remove the rejected session file: ' + err.message);
                }
                return { signedIn: false, message: EXPIRED_MESSAGE, siteUrl };
            } else {
                log.info('Project X site answered HTTP ' + response.status + '; using the saved session');
            }
        } catch (err) {
            log.info('Project X site could not be reached (' + errorMessage(err) + '); using the saved session');
        }
        return { signedIn: true, user: session.user || null, stale: true, siteUrl };
    }

    function push(payload) {
        try {
            notify(payload);
        } catch (err) {
            log.warn('Could not deliver the sign-in result: ' + err.message);
        }
    }

    async function poll(pairing) {
        const interval = pollIntervalMs(pairing.pollSeconds);
        while (true) {
            await sleep(interval);
            if (pairing.cancelled || pending !== pairing) {
                return;
            }
            if (now() - pairing.startedAt >= PAIRING_DEADLINE_MS) {
                pending = null;
                push({ type: 'failed', message: 'The sign-in timed out. Please try again.' });
                return;
            }
            let response;
            try {
                response = await request(fetchImpl, siteUrl + '/api/v1/pair/poll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ deviceCode: pairing.deviceCode })
                });
            } catch (err) {
                log.info('Sign-in check failed (' + errorMessage(err) + '); trying again');
                continue;
            }
            if (pairing.cancelled || pending !== pairing) {
                return;
            }
            if (response.status === 202) {
                continue;
            }
            const body = response.body;
            pending = null;
            if (response.status === 200 && body && typeof body.token === 'string' && body.token) {
                const user = isPlainObject(body.user) ? body.user : null;
                try {
                    writeSession({ token: body.token, user, createdAt: now() });
                    log.info('Signed in to Project X');
                    push({ type: 'signed-in', user });
                } catch (err) {
                    log.error('Could not save the Project X session: ' + err.message);
                    push({ type: 'error', user, message: 'You are signed in, but the session could not be saved to disk.' });
                }
                return;
            }
            log.warn('Sign-in was not completed (HTTP ' + response.status + ')');
            const message = body && typeof body.message === 'string' && body.message ? body.message : 'The sign-in could not be completed. Please try again.';
            push({ type: 'failed', message });
            return;
        }
    }

    async function startPairing() {
        cancelPairing();
        let response;
        try {
            response = await request(fetchImpl, siteUrl + '/api/v1/pair/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ label: hostname + ' (' + platform + ')' })
            });
        } catch (err) {
            log.warn('Could not start a sign-in: ' + errorMessage(err));
            return { ok: false, error: 'Could not reach the Project X site. Check your internet connection and try again.' };
        }
        const body = response.body;
        if (response.status !== 200 || !body || typeof body.deviceCode !== 'string' || !body.deviceCode) {
            log.warn('Sign-in start was refused (HTTP ' + response.status + ')');
            const message = body && typeof body.message === 'string' && body.message
                ? body.message
                : 'The Project X site could not start a sign-in (HTTP ' + response.status + ').';
            return { ok: false, error: message };
        }
        const url = typeof body.verificationUrlComplete === 'string' ? body.verificationUrlComplete : '';
        const pairing = {
            deviceCode: body.deviceCode,
            userCode: typeof body.userCode === 'string' ? body.userCode : '',
            url: isSiteUrl(url, siteUrl) ? url : null,
            pollSeconds: body.pollSeconds,
            startedAt: now(),
            cancelled: false
        };
        pending = pairing;
        if (pairing.url) {
            openPage(pairing);
        } else {
            log.warn('The sign-in page address was not on the Project X site, so it was not opened');
        }
        poll(pairing).catch((err) => {
            log.error('Sign-in polling stopped: ' + errorMessage(err));
            if (pending === pairing) {
                pending = null;
                push({ type: 'failed', message: 'The sign-in could not be completed. Please try again.' });
            }
        });
        return {
            ok: true,
            userCode: pairing.userCode,
            verificationUrl: pairing.url,
            expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null
        };
    }

    function openPage(pairing) {
        Promise.resolve()
            .then(() => openExternal(pairing.url))
            .catch((err) => {
                log.warn('Could not open the sign-in page: ' + errorMessage(err));
                if (pending === pairing) {
                    // The dialog stays open and offers the link to copy instead.
                    push({ type: 'open-failed', url: pairing.url });
                }
            });
    }

    function reopenPairingPage() {
        if (pending && pending.url) {
            openPage(pending);
            return true;
        }
        return false;
    }

    function copyPairingLink() {
        if (pending && pending.url) {
            copyText(pending.url);
            return true;
        }
        return false;
    }

    function cancelPairing() {
        if (pending) {
            pending.cancelled = true;
            pending = null;
        }
    }

    function signOut() {
        cancelPairing();
        deleteSession();
        log.info('Signed out of Project X');
    }

    return { getSession, startPairing, cancelPairing, reopenPairingPage, copyPairingLink, signOut, readToken, readSession };
}

module.exports = { createAccountService, EXPIRED_MESSAGE, PAIRING_DEADLINE_MS, pollIntervalMs };
