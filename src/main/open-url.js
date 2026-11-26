'use strict';

const { errorMessage } = require('./http');

// Any installed browser can show a web page, most common first.
const FALLBACK_BROWSERS = [
    'Google Chrome',
    'Microsoft Edge',
    'Firefox',
    'Brave Browser',
    'Opera',
    'Vivaldi',
    'Chromium'
];

function pickFallbackBrowser(found) {
    const usable = (found || []).filter((item) => item && typeof item.executable === 'string' && item.executable
        // Internet Explorer and the pre-Chromium Edge are left out.
        && item.browser !== 'Internet Explorer'
        && !/[\\/]MicrosoftEdge\.exe$/i.test(item.executable));
    for (const name of FALLBACK_BROWSERS) {
        const match = usable.find((item) => item.browser === name);
        if (match) {
            return match.executable;
        }
    }
    return usable.length > 0 ? usable[0].executable : null;
}

function startDetached(spawn, executable, url) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: false });
        } catch (err) {
            reject(err);
            return;
        }
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

// Opens a web page in the system browser. When the system has no default browser set up for web
// links (Windows reports "Application not found"), an installed browser is started directly.
function createUrlOpener({ openExternal, detect = () => require('detect-browsers').getAvailableBrowsers(), spawn, log }) {
    return async function openUrl(url) {
        try {
            await openExternal(url);
            return;
        } catch (err) {
            log.warn('The default browser could not be opened: ' + errorMessage(err));
            let executable = null;
            try {
                executable = pickFallbackBrowser(await detect());
            } catch (detectErr) {
                log.warn('Could not look for installed browsers: ' + errorMessage(detectErr));
            }
            if (!executable) {
                throw err;
            }
            try {
                await startDetached(spawn, executable, url);
                log.info('Opened the page with an installed browser instead');
            } catch (spawnErr) {
                log.warn('The installed browser could not be started: ' + errorMessage(spawnErr));
                throw err;
            }
        }
    };
}

module.exports = { FALLBACK_BROWSERS, pickFallbackBrowser, createUrlOpener };
