'use strict';

// Chromium-family browsers that can be driven, most dependable first.
const SUPPORTED_BROWSERS = [
    'Google Chrome',
    'Microsoft Edge',
    'Brave Browser',
    'Chromium',
    'Google Chrome Canary',
    'Vivaldi',
    'Opera'
];

const NO_BROWSER_MESSAGE = 'No supported browser was found. Please install a Chromium-based browser such as Google Chrome or Microsoft Edge.';

function pickBrowser(found) {
    for (const name of SUPPORTED_BROWSERS) {
        // The pre-Chromium Edge (MicrosoftEdge.exe) cannot be automated.
        const match = (found || []).find((item) => item && item.browser === name && item.executable
            && !/[\\/]MicrosoftEdge\.exe$/i.test(item.executable));
        if (match) {
            return { name: match.browser, executablePath: match.executable };
        }
    }
    return null;
}

async function findBrowser(detect = () => require('detect-browsers').getAvailableBrowsers()) {
    const found = await detect();
    return pickBrowser(found);
}

// Opens a visible browser with a throwaway context, so no cookies or profile data are reused or kept.
async function launchBrowser(executablePath) {
    const { chromium } = require('patchright');
    const browser = await chromium.launch({ executablePath, headless: false });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    return { browser, page };
}

module.exports = { SUPPORTED_BROWSERS, NO_BROWSER_MESSAGE, pickBrowser, findBrowser, launchBrowser };
