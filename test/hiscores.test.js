'use strict';

const fs = require('fs');
const path = require('path');
const { normaliseName, parseHiscores, summarise, SKILL_NAMES } = require('../src/main/hiscores');
const { createHiscoresService, HISCORES_URL, MAX_ENTRIES } = require('../src/main/hiscores-service');
const { makeTempDir, cleanupTempDirs, makeLog, makeFetch, textResponse, networkError, flush } = require('./helpers');

afterEach(cleanupTempDirs);

// Builds an index_lite page. skills: array of [rank, level, xp] for Overall then each skill.
function page(rows, activities = 3, eol = '\n') {
    const lines = rows.map((row) => row.join(','));
    for (let i = 0; i < activities; i++) {
        lines.push('-1,-1');
    }
    return lines.join(eol) + eol;
}

function uniform(level, xp, skillCount = 24) {
    const rows = [[1000, level * skillCount, xp * skillCount]];
    for (let i = 0; i < skillCount; i++) {
        rows.push([5000 + i, level, xp]);
    }
    return rows;
}

describe('name normalisation', () => {
    test('non-breaking spaces and underscores become spaces', () => {
        expect(normaliseName('Iron\u00A0Wick')).toBe('Iron Wick');
        expect(normaliseName('iron_wick')).toBe('iron wick');
        expect(normaliseName('  a   b  ')).toBe('a b');
    });

    test.each(['ThirteenChars', 'bad!name', '', '   ', null, 7])('rejects %p', (name) => {
        expect(normaliseName(name)).toBeNull();
    });
});

describe('parsing', () => {
    test('parses Overall and every skill by name, with CRLF', () => {
        const rows = parseHiscores(page(uniform(50, 101333), 5, '\r\n'));
        expect(rows).toHaveLength(25);
        expect(rows.map((row) => row.name)).toEqual(SKILL_NAMES);
        expect(rows[0]).toEqual({ name: 'Overall', rank: 1000, level: 1200, xp: 2431992, ranked: true });
    });

    test('stops at two-field rows', () => {
        const text = page(uniform(10, 1200, 23), 0) + '-1,-1\n5,5,5\n';
        expect(parseHiscores(text)).toHaveLength(24);
    });

    test('names an unknown extra skill "Skill <n>" without shifting the others', () => {
        const rows = parseHiscores(page(uniform(60, 273742, 25)));
        expect(rows).toHaveLength(26);
        expect(rows[24].name).toBe('Sailing');
        expect(rows[25].name).toBe('Skill 25');
    });

    test('unranked rows keep numbers out', () => {
        const data = uniform(40, 37224);
        data[0] = [-1, -1, -1];
        data[5] = [-1, 1, 0];
        const rows = parseHiscores(page(data));
        expect(rows[0]).toEqual({ name: 'Overall', rank: null, level: null, xp: null, ranked: false });
        expect(rows[5]).toMatchObject({ name: 'Ranged', level: null, xp: null, ranked: false });
    });

    test.each([
        ['too few rows', page(uniform(1, 0, 10))],
        ['non-numeric text', '<html>Service unavailable</html>'],
        ['empty', ''],
        ['not a string', 42]
    ])('rejects %s', (_label, text) => {
        expect(parseHiscores(text)).toBeNull();
    });
});

describe('summary', () => {
    function rowsWith(overrides, overall = [100, 2277, 4600000000]) {
        const rows = [overall];
        for (let i = 1; i < SKILL_NAMES.length; i++) {
            rows.push([1000, 99, 13034431]);
        }
        for (const [name, row] of Object.entries(overrides)) {
            rows[SKILL_NAMES.indexOf(name)] = row;
        }
        return parseHiscores(page(rows));
    }

    test('a maxed account is combat 126', () => {
        const summary = summarise(rowsWith({}));
        expect(summary).toMatchObject({ combatLevel: 126, combatApproximate: false, totalLevel: 2277, totalLevelApproximate: false, totalXp: 4600000000, overallRank: 100 });
        expect(summary.topSkills).toHaveLength(3);
        expect(summary.skills).toHaveLength(24);
    });

    test('a fresh account is combat 3 using floors, flagged approximate', () => {
        const rows = [[-1, -1, -1]];
        for (let i = 1; i < SKILL_NAMES.length; i++) {
            rows.push([-1, -1, -1]);
        }
        const summary = summarise(parseHiscores(page(rows)));
        expect(summary.combatLevel).toBe(3);
        expect(summary.combatApproximate).toBe(true);
        expect(summary.totalLevel).toBe(24);
        expect(summary.totalLevelApproximate).toBe(true);
        expect(summary.totalXp).toBeNull();
        expect(summary.overallRank).toBeNull();
        expect(summary.topSkills).toEqual([]);
    });

    test('a ranged pure uses the ranged term', () => {
        const low = [1000, 1, 0];
        const summary = summarise(rowsWith({ Attack: low, Strength: low, Magic: low, Defence: low, Prayer: [1000, 1, 0], Hitpoints: [1000, 99, 13034431], Ranged: [1000, 99, 13034431] }));
        // base 0.25*(1+99+0)=25, ranged 0.325*floor(148.5)=48.1 -> 73
        expect(summary.combatLevel).toBe(73);
    });

    test('top three by XP, then level', () => {
        const summary = summarise(rowsWith({
            Woodcutting: [1, 99, 200000000],
            Fishing: [1, 99, 150000000],
            Mining: [1, 99, 140000000]
        }));
        expect(summary.topSkills).toEqual([
            { name: 'Woodcutting', level: 99 },
            { name: 'Fishing', level: 99 },
            { name: 'Mining', level: 99 }
        ]);
    });

    test('sums ranked skills (unranked count as 1) when Overall is unranked', () => {
        const summary = summarise(rowsWith({ Cooking: [-1, -1, -1] }, [-1, -1, -1]));
        expect(summary.totalLevel).toBe(99 * 23 + 1);
        expect(summary.totalLevelApproximate).toBe(true);
    });
});

describe('hiscores service', () => {
    const okPage = page(uniform(50, 101333));

    function setup({ handler, cacheFile, startAt = 1_000_000 } = {}) {
        let clock = startAt;
        const sleeps = [];
        const fetch = makeFetch(handler || (() => textResponse(200, okPage)));
        const log = makeLog();
        const service = createHiscoresService({
            fetch,
            cacheFile,
            log,
            now: () => clock,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock += ms;
            }
        });
        return { service, fetch, log, sleeps, advance: (ms) => { clock += ms; }, now: () => clock };
    }

    test('requests the right URL with only the name, and the user agent', async () => {
        const { service, fetch } = setup();
        const result = await service.lookup('Iron Wick', false);
        expect(result).toMatchObject({ status: 'ok', name: 'Iron Wick', cached: false });
        expect(fetch.calls[0].url).toBe(HISCORES_URL + 'Iron%20Wick');
        expect(fetch.calls[0].url).toBe('https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=Iron%20Wick');
        expect(fetch.calls[0].options.headers['User-Agent']).toBe('Project X Launcher');
    });

    test('invalid names never reach the network', async () => {
        const { service, fetch } = setup();
        await expect(service.lookup('ThisNameIsTooLong', false)).resolves.toMatchObject({ status: 'invalid' });
        await expect(service.lookup('<b>x</b>', false)).resolves.toMatchObject({ status: 'invalid' });
        expect(fetch.calls).toHaveLength(0);
    });

    test('cache hit, then refetch after 30 minutes', async () => {
        const { service, fetch, advance } = setup();
        await service.lookup('Iron Wick', false);
        advance(29 * 60 * 1000);
        await expect(service.lookup('iron_wick', false)).resolves.toMatchObject({ cached: true });
        expect(fetch.calls).toHaveLength(1);
        advance(2 * 60 * 1000);
        await expect(service.lookup('Iron Wick', false)).resolves.toMatchObject({ cached: false });
        expect(fetch.calls).toHaveLength(2);
    });

    test('force skips the cache, but not inside two minutes', async () => {
        const { service, fetch, advance } = setup();
        await service.lookup('Iron Wick', false);
        advance(60 * 1000);
        await expect(service.lookup('Iron Wick', true)).resolves.toMatchObject({ cached: true });
        advance(61 * 1000);
        await expect(service.lookup('Iron Wick', true)).resolves.toMatchObject({ cached: false });
        expect(fetch.calls).toHaveLength(2);
    });

    test('not-found is cached for 30 minutes; errors are retried after 2', async () => {
        let status = 404;
        const { service, fetch, advance } = setup({ handler: () => textResponse(status, '') });
        await expect(service.lookup('Nobody', false)).resolves.toMatchObject({ status: 'not-found' });
        advance(10 * 60 * 1000);
        await expect(service.lookup('Nobody', false)).resolves.toMatchObject({ status: 'not-found', cached: true });
        status = 500;
        await expect(service.lookup('Broken', false)).resolves.toMatchObject({ status: 'error', message: 'The hiscores returned HTTP 500.' });
        advance(60 * 1000);
        await expect(service.lookup('Broken', false)).resolves.toMatchObject({ cached: true });
        advance(61 * 1000);
        await service.lookup('Broken', false);
        expect(fetch.calls).toHaveLength(3);
    });

    test('network errors and unexpected pages become error entries', async () => {
        let mode = 'network';
        const { service, advance } = setup({
            handler: () => {
                if (mode === 'network') {
                    throw networkError();
                }
                return textResponse(200, '<html>maintenance</html>');
            }
        });
        await expect(service.lookup('Alpha', false)).resolves.toMatchObject({ status: 'error', message: 'The hiscores could not be reached.' });
        mode = 'garbage';
        advance(3 * 60 * 1000);
        await expect(service.lookup('Alpha', false)).resolves.toMatchObject({ status: 'error', message: 'The hiscores sent something unexpected.' });
    });

    test('requests are spaced 1.5 s apart and run one at a time', async () => {
        let active = 0;
        let maxActive = 0;
        const { service, sleeps } = setup({
            handler: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await flush();
                active--;
                return textResponse(200, okPage);
            }
        });
        await Promise.all(['Alpha', 'Bravo', 'Charlie'].map((name) => service.lookup(name, false)));
        expect(maxActive).toBe(1);
        expect(sleeps).toEqual([1500, 1500]);
    });

    test('concurrent lookups for one name fetch once', async () => {
        const { service, fetch } = setup();
        const [a, b] = await Promise.all([service.lookup('Iron Wick', false), service.lookup('iron wick', false)]);
        expect(fetch.calls).toHaveLength(1);
        expect(a).toEqual(b);
    });

    test('429 and 503 back off for 60 seconds', async () => {
        let status = 429;
        const { service, sleeps, advance } = setup({ handler: () => textResponse(status, '') });
        await expect(service.lookup('Alpha', false)).resolves.toMatchObject({ status: 'error', message: expect.stringMatching(/busy/) });
        status = 200;
        advance(1000);
        await service.lookup('Bravo', false);
        expect(sleeps[sleeps.length - 1]).toBe(59000);
    });

    test('a failing lookup does not stall the queue', async () => {
        let calls = 0;
        const { service } = setup({
            handler: () => {
                calls++;
                if (calls === 1) {
                    return { status: 200, text: () => Promise.reject(new Error('boom')) };
                }
                return textResponse(200, okPage);
            }
        });
        const results = await Promise.all([service.lookup('Alpha', false), service.lookup('Bravo', false)]);
        expect(results[0]).toMatchObject({ status: 'error' });
        expect(results[1]).toMatchObject({ status: 'ok' });
    });

    test('the cache is bounded at 300 entries', async () => {
        const { service } = setup({ handler: () => textResponse(404, '') });
        for (let i = 0; i < MAX_ENTRIES + 5; i++) {
            await service.lookup('n' + i, false);
        }
        expect(service._cache.size).toBe(MAX_ENTRIES);
        expect(service._cache.has('n0')).toBe(false);
        expect(service._cache.has('n304')).toBe(true);
    });
});

describe('hiscores disk cache', () => {
    const okPage = page(uniform(50, 101333));

    function make(cacheFile, clock, handler) {
        const fetch = makeFetch(handler || (() => textResponse(200, okPage)));
        const service = createHiscoresService({ fetch, cacheFile, log: makeLog(), now: () => clock.value, sleep: async () => {} });
        return { service, fetch };
    }

    test('survives a restart and saves compact JSON without failures', async () => {
        const file = path.join(makeTempDir(), 'hiscores-cache.json');
        const clock = { value: 1_763_215_200_000 };
        const first = make(file, clock, (url) => (url.includes('Broken') ? textResponse(500, '') : textResponse(200, okPage)));
        await first.service.lookup('Iron Wick', false);
        await first.service.lookup('Broken', false);
        const text = fs.readFileSync(file, 'utf8');
        expect(text).not.toContain('\n');
        const saved = JSON.parse(text);
        expect(saved.version).toBe(1);
        expect(Object.keys(saved.entries)).toEqual(['iron wick']);
        expect(saved.entries['iron wick']).toMatchObject({ status: 'ok', name: 'Iron Wick', fetchedAt: clock.value });

        clock.value += 60 * 1000;
        const second = make(file, clock);
        await expect(second.service.lookup('Iron Wick', false)).resolves.toMatchObject({ cached: true, status: 'ok' });
        expect(second.fetch.calls).toHaveLength(0);
    });

    test('ignores corrupt files, old entries and entries whose key does not match', async () => {
        const dir = makeTempDir();
        const file = path.join(dir, 'hiscores-cache.json');
        fs.writeFileSync(file, '{oops');
        const clock = { value: 1_763_215_200_000 };
        expect(() => make(file, clock)).not.toThrow();

        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            entries: {
                'old name': { status: 'ok', name: 'Old Name', data: {}, fetchedAt: clock.value - 25 * 60 * 60 * 1000 },
                mismatch: { status: 'ok', name: 'Other', data: {}, fetchedAt: clock.value },
                'bad status': { status: 'error', name: 'Bad Status', fetchedAt: clock.value },
                'no time': { status: 'ok', name: 'No Time' },
                'good one': { status: 'not-found', name: 'Good One', fetchedAt: clock.value }
            }
        }));
        const { service } = make(file, clock);
        expect([...service._cache.keys()]).toEqual(['good one']);
    });
});
