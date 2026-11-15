// Runs several Jagex launches one after another. Shared with the tests, so no imports.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PXMultiLaunch = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const GAP_CHOICES = [15, 25, 40, 60];
    const DEFAULT_GAP = 25;

    function sanitizeGap(value) {
        const gap = Number(value);
        return GAP_CHOICES.indexOf(gap) >= 0 ? gap : DEFAULT_GAP;
    }

    function summary(started, total) {
        const base = 'Started ' + started + ' of ' + total + '.';
        return started === total ? base : 'Started ' + started + ' of ' + total + ' \u2014 see the launcher log for the rest.';
    }

    // deps: prepare() -> version or null, launchOne(accountId, version) -> { ok, error },
    // sleep(ms), onStatus(text), log(level, message)
    function createMultiLauncher(deps) {
        let running = false;

        async function run(characters, gapSeconds) {
            if (running) {
                return { started: false, reason: 'already-running' };
            }
            running = true;
            try {
                const total = characters.length;
                if (total === 0) {
                    return { started: false, reason: 'nothing-selected' };
                }
                const version = await deps.prepare();
                if (!version) {
                    return { started: false, reason: 'prepare-failed' };
                }
                const gap = sanitizeGap(gapSeconds);
                let started = 0;
                for (let i = 0; i < total; i++) {
                    const character = characters[i];
                    deps.onStatus('Starting ' + character.label + ' (' + (i + 1) + ' of ' + total + ')\u2026');
                    try {
                        const result = await deps.launchOne(character.accountId, version);
                        if (result && result.ok) {
                            started++;
                        } else {
                            const error = (result && result.error) || 'Unknown error';
                            deps.log('warn', character.label + ': ' + error);
                            deps.onStatus(character.label + ' failed to start: ' + error);
                        }
                    } catch (err) {
                        deps.log('error', character.label + ': ' + (err && err.message ? err.message : String(err)));
                    }
                    if (i < total - 1) {
                        for (let s = gap; s > 0; s--) {
                            deps.onStatus('Next account in ' + s + 's\u2026');
                            await deps.sleep(1000);
                        }
                    }
                }
                deps.onStatus(summary(started, total));
                return { started: true, count: started, total };
            } finally {
                running = false;
            }
        }

        return {
            run,
            isRunning: () => running
        };
    }

    return { GAP_CHOICES, DEFAULT_GAP, sanitizeGap, summary, createMultiLauncher };
});
