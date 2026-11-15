'use strict';

const oauth = require('./oauth');
const { NO_BROWSER_MESSAGE } = require('./browser');

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

const COMPLETE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authentication Complete</title>
<style>
html,body{height:100%;margin:0}
body{background:#0d1117;color:#e6edf3;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;animation:fade .5s ease both}
main{text-align:center;padding:24px}
h1{font-size:34px;margin:0 0 12px}
p{margin:0 0 28px;color:#e6edf3;opacity:.8}
.ring{width:40px;height:40px;margin:0 auto;border:4px solid #2d333b;border-top-color:#2f81f7;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fade{from{opacity:0}to{opacity:1}}
</style></head>
<body><main><h1>Authentication Complete</h1><p>You signed in successfully. Taking you back to the launcher&hellip;</p><div class="ring"></div></main></body></html>`;

const MESSAGES = {
    closed: 'The browser was closed before authentication completed.',
    generic: 'An error occurred during the authentication flow.',
    timeout: 'The Jagex sign-in took too long and was stopped. Please try again.',
    state: 'The Jagex sign-in could not be verified. Please try again.',
    launch: 'The browser could not be started for the Jagex sign-in.'
};

function isLocalhost(url) {
    return url.protocol === 'http:' && url.hostname === 'localhost';
}

// Drives a real browser through the Jagex sign-in. Secrets (codes, tokens, session ids, verifier)
// are never logged; only the steps are.
async function runJagexLogin(deps) {
    const {
        findBrowser,
        launchBrowser,
        fetch: fetchImpl,
        accounts,
        log,
        createPkce = oauth.createPkce,
        timeoutMs = LOGIN_TIMEOUT_MS
    } = deps;

    let found;
    try {
        found = await findBrowser();
    } catch (err) {
        log.warn('Browser detection failed: ' + err.message);
        found = null;
    }
    if (!found) {
        return { ok: false, error: NO_BROWSER_MESSAGE };
    }
    log.info('Starting Jagex sign-in in ' + found.name);

    const pkce = createPkce();
    let session;
    try {
        session = await launchBrowser(found.executablePath);
    } catch (err) {
        log.error('Could not start the browser: ' + err.message);
        return { ok: false, error: MESSAGES.launch };
    }
    const { browser, page } = session;

    return new Promise((resolve) => {
        let finished = false;
        let codeHandled = false;
        let tokenHandled = false;

        const timer = setTimeout(() => {
            log.warn('Jagex sign-in timed out');
            finish({ ok: false, error: MESSAGES.timeout });
        }, timeoutMs);

        async function finish(result) {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            try {
                await browser.close();
            } catch (_) {
                // already closed
            }
            resolve(result);
        }

        function navigate(url, step) {
            Promise.resolve()
                .then(() => page.goto(url))
                .catch(() => {
                    if (!finished) {
                        log.info('Browser navigation for ' + step + ' did not complete');
                    }
                });
        }

        async function onCode(found) {
            codeHandled = true;
            log.info('Found code parameter');
            if (found.state !== pkce.state) {
                log.warn('Jagex sign-in state did not match');
                return finish({ ok: false, error: MESSAGES.state });
            }
            let idToken;
            try {
                idToken = await oauth.exchangeCode({ fetch: fetchImpl, code: found.code, verifier: pkce.verifier });
            } catch (err) {
                log.warn(err.message);
                return finish({ ok: false, error: 'Jagex sign-in failed: the login could not be confirmed. Please try again.' });
            }
            log.info('Token exchange successful');
            if (finished) {
                return;
            }
            navigate(oauth.buildConsentUrl({ idToken, nonce: oauth.randomAlphanumeric(48), state: pkce.state }), 'consent');
        }

        async function onIdToken(found) {
            tokenHandled = true;
            log.info('Found identity token');
            if (found.state && found.state !== pkce.state) {
                log.warn('Jagex sign-in state did not match');
                return finish({ ok: false, error: MESSAGES.state });
            }
            let sessionId;
            try {
                sessionId = await oauth.createGameSession({ fetch: fetchImpl, idToken: found.idToken });
            } catch (err) {
                log.warn(err.message);
                return finish({ ok: false, error: 'Jagex sign-in failed: a game session could not be created.' });
            }
            log.info('Game session created');
            const merged = await accounts.fetchAndMerge(sessionId);
            if (!merged.ok) {
                return finish({ ok: false, error: merged.error });
            }
            return finish({ ok: true, added: merged.added, updated: merged.updated });
        }

        async function onNavigation(frame) {
            if (finished) {
                return;
            }
            const result = oauth.classifyNavigation(frame.url());
            if (!result) {
                return;
            }
            if (result.type === 'id_token' && !tokenHandled) {
                await onIdToken(result);
            } else if (result.type === 'code' && !codeHandled) {
                await onCode(result);
            }
        }

        page.on('framenavigated', (frame) => {
            onNavigation(frame).catch((err) => {
                log.error('Jagex sign-in error: ' + (err && err.name ? err.name : 'unknown'));
                finish({ ok: false, error: MESSAGES.generic });
            });
        });
        page.on('close', () => {
            if (!finished) {
                log.info('Browser closed before the Jagex sign-in completed');
            }
            finish({ ok: false, error: MESSAGES.closed });
        });
        if (typeof browser.on === 'function') {
            browser.on('disconnected', () => finish({ ok: false, error: MESSAGES.closed }));
        }

        Promise.resolve()
            .then(() => page.route((url) => isLocalhost(url), (route) => route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: COMPLETE_PAGE
            })))
            .then(() => {
                if (!finished) {
                    navigate(oauth.buildLoginUrl(pkce), 'sign-in');
                }
            })
            .catch((err) => {
                log.error('Could not prepare the Jagex sign-in page: ' + (err && err.name ? err.name : 'unknown'));
                finish({ ok: false, error: MESSAGES.generic });
            });
    });
}

module.exports = { runJagexLogin, COMPLETE_PAGE, MESSAGES, LOGIN_TIMEOUT_MS };
