// Display helpers shared by the renderer and the tests. No imports on purpose (see ram.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PXFormat = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DASH = '\u2013';

    const SKILL_ABBREVIATIONS = {
        Attack: 'Att',
        Defence: 'Def',
        Strength: 'Str',
        Hitpoints: 'HP',
        Ranged: 'Rng',
        Prayer: 'Pray',
        Magic: 'Mage',
        Cooking: 'Cook',
        Woodcutting: 'WC',
        Fletching: 'Fletch',
        Fishing: 'Fish',
        Firemaking: 'FM',
        Crafting: 'Craft',
        Smithing: 'Smith',
        Mining: 'Mine',
        Herblore: 'Herb',
        Agility: 'Agil',
        Thieving: 'Thiev',
        Slayer: 'Slay',
        Farming: 'Farm',
        Runecraft: 'RC',
        Hunter: 'Hunt',
        Construction: 'Con',
        Sailing: 'Sail'
    };

    function isNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function formatNumber(value) {
        return isNumber(value) ? Math.round(value).toLocaleString('en-GB') : DASH;
    }

    function formatXpCompact(value) {
        if (!isNumber(value)) {
            return DASH;
        }
        if (value >= 1e9) {
            return (value / 1e9).toFixed(2) + 'B';
        }
        if (value >= 1e6) {
            return (value / 1e6).toFixed(1) + 'M';
        }
        if (value >= 1e3) {
            return Math.round(value / 1e3) + 'K';
        }
        return String(Math.round(value));
    }

    function relativeTime(epochMs, nowMs) {
        if (!isNumber(epochMs)) {
            return '';
        }
        const minutes = Math.floor(Math.max(0, nowMs - epochMs) / 60000);
        if (minutes < 1) {
            return 'just now';
        }
        if (minutes < 60) {
            return minutes + ' min ago';
        }
        const hours = Math.floor(minutes / 60);
        return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    }

    function skillAbbreviation(name) {
        return SKILL_ABBREVIATIONS[name] || name;
    }

    function displayName(account) {
        const name = account && typeof account.displayName === 'string' ? account.displayName.trim() : '';
        return name || null;
    }

    function accountLabel(account, nicknames) {
        const name = displayName(account) || 'Not set';
        const nickname = nicknames && account ? nicknames[account.accountId] : undefined;
        return nickname ? nickname + ' (' + name + ')' : name;
    }

    function sortKey(account) {
        return (displayName(account) || String(account.accountId || '')).trim().toLowerCase();
    }

    function sortAccountsAlphabetically(accounts) {
        return accounts.slice().sort((a, b) => {
            const left = sortKey(a);
            const right = sortKey(b);
            return left < right ? -1 : left > right ? 1 : 0;
        });
    }

    function createdTime(account) {
        const time = Date.parse(account && account.createdOn);
        return Number.isNaN(time) ? 0 : time;
    }

    function newestAccount(accounts) {
        let newest = null;
        for (const account of accounts) {
            if (!newest || createdTime(account) > createdTime(newest)) {
                newest = account;
            }
        }
        return newest;
    }

    return {
        DASH,
        SKILL_ABBREVIATIONS,
        formatNumber,
        formatXpCompact,
        relativeTime,
        skillAbbreviation,
        displayName,
        accountLabel,
        sortAccountsAlphabetically,
        newestAccount
    };
});
