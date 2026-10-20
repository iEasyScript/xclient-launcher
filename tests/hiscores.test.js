const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    HISCORES_URL,
    SKILL_NAMES,
    normalizeName,
    cacheKey,
    parseHiscoresLite,
    combatLevel,
    summarize,
    createHiscoresService,
    fileStore,
    registerHiscoresHandlers
} = require('../libs/hiscores.js');

/** A response shaped like index_lite.ws: 25 skill rows, then activity rows. */
function liteResponse(skillRows, activityRows = 5) {
    const lines = [...skillRows];
    for (let i = 0; i < activityRows; i++) lines.push('-1,-1');
    return lines.join('\n') + '\n';
}

/** Overall then 24 skills, every skill at `level`. */
function uniform(level, xp = 1000000, rank = 5000) {
    const rows = [`${rank},${level * 24},${xp * 24}`];
    for (let i = 0; i < 24; i++) rows.push(`${rank},${level},${xp}`);
    return rows;
}

describe('hiscores parsing', () => {
    test('reads overall and every skill by name', () => {
        // Trimmed from a real response: maxed except Sailing, which is unranked.
        const rows = ['125207,2278,4600000000'];
        for (let i = 0; i < 23; i++) rows.push(`${i + 1},99,200000000`);
        rows.push('-1,1,0');

        const parsed = parseHiscoresLite(liteResponse(rows));
        expect(parsed.overall).toEqual({
            name: 'Overall',
            rank: 125207,
            level: 2278,
            xp: 4600000000,
            ranked: true
        });
        expect(parsed.skills).toHaveLength(24);
        expect(parsed.skills[0]).toMatchObject({ name: 'Attack', level: 99, ranked: true });
        expect(parsed.skills[8]).toMatchObject({ name: 'Woodcutting', level: 99 });
        expect(parsed.skills[23]).toEqual({
            name: 'Sailing',
            rank: null,
            level: null,
            xp: null,
            ranked: false
        });
    });

    test('handles Windows line endings', () => {
        const parsed = parseHiscoresLite(liteResponse(uniform(50)).replace(/\n/g, '\r\n'));
        expect(parsed.skills).toHaveLength(24);
        expect(parsed.skills.every((s) => s.level === 50)).toBe(true);
    });

    test('stops at the two-field activity rows', () => {
        const parsed = parseHiscoresLite(liteResponse(uniform(40), 60));
        expect(parsed.skills).toHaveLength(24);
    });

    test('names a skill it does not know yet instead of shifting the rest', () => {
        const parsed = parseHiscoresLite(liteResponse([...uniform(30), '10,5,400']));
        expect(parsed.skills).toHaveLength(25);
        expect(parsed.skills[24]).toMatchObject({ name: `Skill ${SKILL_NAMES.length}`, level: 5 });
    });

    test('an unranked Overall keeps its numbers out', () => {
        const rows = uniform(20);
        rows[0] = '-1,-1,-1';
        const parsed = parseHiscoresLite(liteResponse(rows));
        expect(parsed.overall).toMatchObject({ ranked: false, level: null, xp: null });
    });

    test('rejects anything that is not a hiscores page', () => {
        expect(parseHiscoresLite('<html>Page not found</html>')).toBeNull();
        expect(parseHiscoresLite('')).toBeNull();
        expect(parseHiscoresLite(undefined)).toBeNull();
        // Too few skill rows.
        expect(parseHiscoresLite('1,2,3\n4,5,6\n')).toBeNull();
        // Junk in a row ends the skills early, and that is too few.
        const rows = uniform(10);
        rows[5] = '1,abc,3';
        expect(parseHiscoresLite(liteResponse(rows))).toBeNull();
    });
});

describe('combat level', () => {
    const skills = (levels) =>
        Object.entries(levels).map(([name, level]) => ({ name, level }));

    test('a fresh account is level 3', () => {
        expect(
            combatLevel(
                skills({ Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 1, Ranged: 1, Magic: 1 })
            )
        ).toEqual({ level: 3, approximate: false });
    });

    test('a maxed account is level 126', () => {
        expect(
            combatLevel(
                skills({ Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Ranged: 99, Magic: 99 })
            )
        ).toEqual({ level: 126, approximate: false });
    });

    test('a ranged pure uses the ranged formula', () => {
        // 0.25 * (1 + 60 + 22) + 0.325 * floor(99 * 1.5) = 20.75 + 48.1 = 68.85
        expect(
            combatLevel(
                skills({ Attack: 1, Strength: 1, Defence: 1, Hitpoints: 60, Prayer: 44, Ranged: 99, Magic: 1 })
            ).level
        ).toBe(68);
    });

    test('unranked combat skills count at their floor and flag it', () => {
        const result = combatLevel(
            skills({ Attack: 40, Strength: 40, Defence: null, Hitpoints: null, Prayer: 1, Ranged: 1, Magic: 1 })
        );
        expect(result.approximate).toBe(true);
        // 0.25 * (1 + 10 + 0) + 0.325 * 80 = 2.75 + 26 = 28.75
        expect(result.level).toBe(28);
    });
});

describe('summarize', () => {
    test('totals, combat and the three best skills by XP', () => {
        const rows = uniform(10, 1200);
        rows[0] = '90000,500,3000000';
        // rows[i] is SKILL_NAMES[i]: row 0 is Overall.
        rows[9] = '1,85,3000000'; // Woodcutting
        rows[11] = '1,80,2000000'; // Fishing
        rows[15] = '1,70,800000'; // Mining
        const summary = summarize(parseHiscoresLite(liteResponse(rows)));

        expect(summary.totalLevel).toBe(500);
        expect(summary.totalLevelApproximate).toBe(false);
        expect(summary.totalXp).toBe(3000000);
        expect(summary.overallRank).toBe(90000);
        expect(summary.topSkills).toEqual([
            { name: 'Woodcutting', level: 85 },
            { name: 'Fishing', level: 80 },
            { name: 'Mining', level: 70 }
        ]);
        expect(summary.skills).toHaveLength(24);
    });

    test('falls back to summing the skills when Overall is unranked', () => {
        const rows = uniform(5);
        rows[0] = '-1,-1,-1';
        const summary = summarize(parseHiscoresLite(liteResponse(rows)));
        expect(summary.totalLevel).toBe(5 * 24);
        expect(summary.totalLevelApproximate).toBe(true);
        expect(summary.totalXp).toBeNull();
    });
});

describe('names', () => {
    test('normalises the way the hiscores do', () => {
        expect(normalizeName('  Zezima ')).toBe('Zezima');
        expect(normalizeName('Iron_Man\u00A0btw')).toBe('Iron Man btw');
        expect(normalizeName('a-b c')).toBe('a-b c');
        expect(cacheKey('IRON_man')).toBe(cacheKey('iron man'));
    });

    test('refuses what cannot be an OSRS name', () => {
        expect(normalizeName('')).toBeNull();
        expect(normalizeName('Not set!')).toBeNull();
        expect(normalizeName('thirteenchars')).toBeNull();
        expect(normalizeName('x&y=1')).toBeNull();
        expect(normalizeName(null)).toBeNull();
        expect(normalizeName({ name: 'Zezima' })).toBeNull();
    });
});

describe('hiscores service', () => {
    let clock;
    let waits;
    let fetchText;

    const now = () => clock;
    // Waiting moves the clock instead of sleeping, so the tests are instant.
    const wait = async (ms) => {
        waits.push(ms);
        clock += ms;
    };

    const ok = (level = 50) => ({ status: 200, body: liteResponse(uniform(level)) });

    function service(extra = {}) {
        return createHiscoresService({ fetchText, now, wait, minGapMs: 1500, ...extra });
    }

    beforeEach(() => {
        clock = 1_000_000;
        waits = [];
        fetchText = jest.fn(async () => ok());
    });

    test('asks for the right URL with only the display name', async () => {
        await service().lookup('Iron_Man btw');
        expect(fetchText).toHaveBeenCalledTimes(1);
        expect(fetchText).toHaveBeenCalledWith(`${HISCORES_URL}?player=Iron%20Man%20btw`);
    });

    test('returns a summary and serves repeats from the cache', async () => {
        const hiscores = service();
        const first = await hiscores.lookup('Zezima');
        expect(first).toMatchObject({ status: 'ok', name: 'Zezima', cached: false });
        expect(first.data.totalLevel).toBe(50 * 24);

        clock += 10 * 60 * 1000;
        const second = await hiscores.lookup('zezima');
        expect(second).toMatchObject({ status: 'ok', cached: true });
        expect(fetchText).toHaveBeenCalledTimes(1);
    });

    test('refetches once the cache entry is 30 minutes old', async () => {
        const hiscores = service();
        await hiscores.lookup('Zezima');
        clock += 30 * 60 * 1000;
        await hiscores.lookup('Zezima');
        expect(fetchText).toHaveBeenCalledTimes(2);
    });

    test('force skips the cache, but not inside two minutes', async () => {
        const hiscores = service();
        await hiscores.lookup('Zezima');

        clock += 60 * 1000;
        await hiscores.lookup('Zezima', { force: true });
        expect(fetchText).toHaveBeenCalledTimes(1);

        clock += 2 * 60 * 1000;
        await hiscores.lookup('Zezima', { force: true });
        expect(fetchText).toHaveBeenCalledTimes(2);
    });

    test('a name not on the hiscores is reported and cached', async () => {
        fetchText.mockResolvedValue({ status: 404, body: '' });
        const hiscores = service();
        expect(await hiscores.lookup('Brand New')).toMatchObject({ status: 'not-found' });
        clock += 5 * 60 * 1000;
        expect(await hiscores.lookup('Brand New')).toMatchObject({
            status: 'not-found',
            cached: true
        });
        expect(fetchText).toHaveBeenCalledTimes(1);
    });

    test('an invalid name never reaches the network', async () => {
        const result = await service().lookup('Not set!');
        expect(result.status).toBe('invalid');
        expect(fetchText).not.toHaveBeenCalled();
    });

    test('network errors and odd responses are retried after a short wait', async () => {
        fetchText.mockRejectedValueOnce(new Error('ECONNRESET'));
        fetchText.mockResolvedValueOnce({ status: 200, body: '<html>maintenance</html>' });
        const hiscores = service();

        expect(await hiscores.lookup('Zezima')).toMatchObject({ status: 'error' });
        clock += 30 * 1000;
        expect(await hiscores.lookup('Zezima')).toMatchObject({ status: 'error', cached: true });

        clock += 2 * 60 * 1000;
        expect(await hiscores.lookup('Zezima')).toMatchObject({
            status: 'error',
            message: 'The hiscores sent something unexpected.'
        });

        clock += 2 * 60 * 1000;
        expect(await hiscores.lookup('Zezima')).toMatchObject({ status: 'ok' });
        expect(fetchText).toHaveBeenCalledTimes(3);
    });

    test('spaces requests out, one at a time', async () => {
        const hiscores = service();
        const names = ['Alpha', 'Bravo', 'Charlie'];
        let active = 0;
        let maxActive = 0;
        const startedAt = [];
        fetchText.mockImplementation(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            startedAt.push(clock);
            await Promise.resolve();
            active--;
            return ok();
        });

        await Promise.all(names.map((n) => hiscores.lookup(n)));

        expect(maxActive).toBe(1);
        expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(1500);
        expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(1500);
    });

    test('the same name asked for twice at once is fetched once', async () => {
        const hiscores = service();
        const [a, b] = await Promise.all([hiscores.lookup('Zezima'), hiscores.lookup('ZEZIMA')]);
        expect(fetchText).toHaveBeenCalledTimes(1);
        expect(a.status).toBe('ok');
        expect(b.status).toBe('ok');
    });

    test('backs off for a minute when rate limited', async () => {
        fetchText.mockResolvedValueOnce({ status: 429, body: '' });
        const hiscores = service();

        expect(await hiscores.lookup('Alpha')).toMatchObject({ status: 'error' });
        const before = clock;
        await hiscores.lookup('Bravo');
        expect(clock - before).toBeGreaterThanOrEqual(60 * 1000);
    });

    test('one failing lookup does not stall the queue', async () => {
        fetchText.mockRejectedValueOnce(new Error('boom'));
        const hiscores = service();
        const results = await Promise.all([hiscores.lookup('Alpha'), hiscores.lookup('Bravo')]);
        expect(results.map((r) => r.status)).toEqual(['error', 'ok']);
    });

    test('keeps the cache bounded', async () => {
        const hiscores = service({ maxEntries: 2 });
        await hiscores.lookup('Alpha');
        await hiscores.lookup('Bravo');
        await hiscores.lookup('Charlie');
        expect([...hiscores._cache.keys()]).toEqual(['bravo', 'charlie']);
    });

    describe('on disk', () => {
        let tempDir;
        let cachePath;

        beforeEach(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxhs-'));
            cachePath = path.join(tempDir, 'hiscores-cache.json');
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        test('survives a restart, without the failures', async () => {
            fetchText.mockImplementation(async (url) =>
                url.includes('Broken') ? { status: 500, body: '' } : ok(60)
            );
            const first = service({ store: fileStore(fs, cachePath) });
            await first.lookup('Zezima');
            await first.lookup('Broken');

            const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            expect(Object.keys(saved.entries)).toEqual(['zezima']);
            // Names and levels, nothing that could sign anyone in.
            expect(JSON.stringify(saved)).not.toMatch(/session|token|password/i);

            fetchText.mockClear();
            const second = service({ store: fileStore(fs, cachePath) });
            expect(await second.lookup('Zezima')).toMatchObject({ status: 'ok', cached: true });
            expect(fetchText).not.toHaveBeenCalled();
        });

        test('ignores a corrupt or outdated cache file', async () => {
            fs.writeFileSync(cachePath, '{oops');
            const log = { warn: jest.fn() };
            const hiscores = service({ store: fileStore(fs, cachePath), log });
            expect(log.warn).toHaveBeenCalled();
            await hiscores.lookup('Zezima');
            expect(fetchText).toHaveBeenCalledTimes(1);

            fs.writeFileSync(
                cachePath,
                JSON.stringify({
                    entries: {
                        zezima: { status: 'ok', name: 'Zezima', data: {}, fetchedAt: clock - 25 * 3600 * 1000 }
                    }
                })
            );
            fetchText.mockClear();
            await service({ store: fileStore(fs, cachePath) }).lookup('Zezima');
            expect(fetchText).toHaveBeenCalledTimes(1);
        });
    });
});

describe('hiscores IPC', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxhsipc-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('registers hiscores:lookup and fetches through axios', async () => {
        const handlers = {};
        const axios = {
            get: jest.fn(async () => ({ status: 200, data: liteResponse(uniform(70)) }))
        };
        registerHiscoresHandlers({
            ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
            axios,
            fs,
            path,
            projectxDir: tempDir,
            log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        });

        const result = await handlers['hiscores:lookup']({}, 'Zezima');
        expect(result).toMatchObject({ status: 'ok', name: 'Zezima' });
        expect(result.data.combatLevel).toBeGreaterThan(3);

        const [url, options] = axios.get.mock.calls[0];
        expect(url).toBe(`${HISCORES_URL}?player=Zezima`);
        // No credentials of any kind on the request.
        expect(options.headers).toEqual({ 'User-Agent': 'Project X Launcher' });
        expect(fs.existsSync(path.join(tempDir, 'hiscores-cache.json'))).toBe(true);
    });
});
