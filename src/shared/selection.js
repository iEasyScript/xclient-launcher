// Selection rules for the version list and the account picker. Shared with the tests, so no imports.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PXSelection = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function jarName(version) {
        return 'projectx-' + version + '.jar';
    }

    // The jar to select: the wanted version if installed, else the saved preference on an exact
    // file-name match, else the newest installed jar.
    function chooseVersion(installed, wanted, preference) {
        if (wanted && installed.indexOf(jarName(wanted)) >= 0) {
            return jarName(wanted);
        }
        if (preference && preference !== '0.0.0' && installed.indexOf(jarName(preference)) >= 0) {
            return jarName(preference);
        }
        return installed.length ? installed[0] : null;
    }

    // What to do with the remembered selected_account: select it, forget it, or leave things as they are.
    function rememberedSelection(accounts, remembered) {
        if (!remembered) {
            return { action: 'keep' };
        }
        const exists = accounts.some((account) => account.accountId === remembered);
        return exists ? { action: 'select', accountId: remembered } : { action: 'forget' };
    }

    function createdTime(account) {
        const time = Date.parse(account && account.createdOn);
        return Number.isNaN(time) ? 0 : time;
    }

    // After accounts.json changes: newest character when the count changed, otherwise keep the
    // current one if it still exists. null means "None".
    function selectionAfterReload(accounts, previousCount, currentId) {
        if (accounts.length === 0) {
            return { accountId: null, changedCount: previousCount !== 0 };
        }
        if (accounts.length !== previousCount) {
            let newest = accounts[0];
            for (const account of accounts) {
                if (createdTime(account) > createdTime(newest)) {
                    newest = account;
                }
            }
            return { accountId: newest.accountId, changedCount: true };
        }
        if (currentId === null || accounts.some((account) => account.accountId === currentId)) {
            return { accountId: currentId, changedCount: false };
        }
        return { accountId: accounts[0].accountId, changedCount: false };
    }

    return { jarName, chooseVersion, rememberedSelection, selectionAfterReload };
});
