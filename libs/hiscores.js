/**
 * Old School hiscores for the accounts panel.
 *
 * The panel shows how far each saved account has got without logging in, and
 * the only place that is public is the hiscores. This asks for nothing but a
 * display name: no session, no token, nothing from accounts.json beyond the
 * name a stranger could type into the hiscores page themselves.
 *
 * Jagex throttles the hiscores, so lookups go out one at a time with a gap
 * between them, back off when told to slow down, and are cached -- in memory
 * and on disk, so restarting the launcher does not refetch every account.
 */

const HISCORES_URL =
    'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws';

/**
 * The order index_lite.ws lists skills in. Overall first, then the skills;
 * the activity and boss rows that follow have two fields, not three, and are
 * not used. A skill Jagex adds later appears as "Skill 25" until it is named
 * here, rather than shifting everything after it.
 */
const SKILL_NAMES = [
    'Overall',
    'Attack',
    'Defence',
    'Strength',
    'Hitpoints',
    'Ranged',
    'Prayer',
    'Magic',
    'Cooking',
    'Woodcutting',
    'Fletching',
    'Fishing',
    'Firemaking',
    'Crafting',
    'Smithing',
    'Mining',
    'Herblore',
    'Agility',
    'Thieving',
    'Slayer',
    'Farming',
    'Runecraft',
    'Hunter',
    'Construction',
    'Sailing'
];

/** OSRS display names: letters, digits, spaces, hyphens; at most 12. */
const NAME_PATTERN = /^[A-Za-z0-9 -]{1,12}$/;

const MINUTE = 60 * 1000;

const DEFAULTS = {
    /** A found account is good for half an hour; levels do not move that fast. */
    ttlMs: 30 * MINUTE,
    /** A name not on the hiscores: maybe brand new, maybe renamed. */
    notFoundTtlMs: 30 * MINUTE,
    /** Network failures and odd responses: try again soon, but not every render. */
    errorTtlMs: 2 * MINUTE,
    /** The refresh button can skip the cache, but not hammer the hiscores. */
    forceMinAgeMs: 2 * MINUTE,
    /** Between any two requests, whoever made them. */
    minGapMs: 1500,
    /** After a 429 or 503: everything waits this long. */
    rateLimitBackoffMs: 60 * 1000,
    /** Disk entries older than this are dropped when the cache loads. */
    diskMaxAgeMs: 24 * 60 * MINUTE,
    /** Upper bound on cached names, oldest dropped first. */
    maxEntries: 300,
    requestTimeoutMs: 10 * 1000
};

/**
 * The name as the hiscores want it, or null if it cannot be an OSRS name.
 * The game hands out names with non-breaking spaces, and underscores are
 * interchangeable with spaces on the hiscores, so both become spaces.
 * @param {unknown} name
 * @returns {string|null}
 */
function normalizeName(name) {
    if (typeof name !== 'string') {
        return null;
    }
    const cleaned = name
        .replace(/[\u00A0_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return NAME_PATTERN.test(cleaned) ? cleaned : null;
}

/** Cache key: hiscores names are case-insensitive. */
function cacheKey(name) {
    const normalized = normalizeName(name);
    return normalized ? normalized.toLowerCase() : null;
}

/** -1 on the hiscores means "not ranked", which is not the same as zero. */
function nonNegative(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parses an index_lite.ws response.
 *
 * Each skill row is "rank,level,xp". Unranked skills come back as rank -1;
 * depending on the row the level and xp are then -1 or a floor value (1 / 0),
 * so a skill is only trusted when its rank is not -1.
 *
 * @param {string} text
 * @returns {{overall: {rank: number|null, level: number|null, xp: number|null, ranked: boolean},
 *            skills: Array<{name: string, rank: number|null, level: number|null, xp: number|null, ranked: boolean}>}|null}
 *          null when the text does not look like a hiscores response at all.
 */
function parseHiscoresLite(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const rows = [];
    for (const line of text.trim().split(/\r?\n/)) {
        const parts = line.trim().split(',');
        // The skills are the leading run of three-field rows.
        if (parts.length !== 3) {
            break;
        }
        const numbers = parts.map((part) =>
            /^-?\d+$/.test(part.trim()) ? Number(part.trim()) : NaN
        );
        if (numbers.some((n) => !Number.isFinite(n))) {
            break;
        }
        const [rank, level, xp] = numbers;
        const ranked = rank >= 0;
        rows.push({
            name: SKILL_NAMES[rows.length] || `Skill ${rows.length}`,
            rank: nonNegative(rank),
            level: ranked ? nonNegative(level) : null,
            xp: ranked ? nonNegative(xp) : null,
            ranked
        });
    }

    // Overall plus at least the 23 original skills, or it is not a hiscores page.
    if (rows.length < 24) {
        return null;
    }

    const [overall, ...skills] = rows;
    return { overall, skills };
}

/**
 * Combat level from the hiscores. An unranked combat skill counts at its
 * floor (10 Hitpoints, 1 for the rest), which can only undercount, so the
 * result is flagged approximate when that happened.
 * @param {Array<{name: string, level: number|null}>} skills
 * @returns {{level: number, approximate: boolean}}
 */
function combatLevel(skills) {
    const byName = new Map((skills || []).map((s) => [s.name, s.level]));
    let approximate = false;
    const level = (name, floor) => {
        const value = byName.get(name);
        if (!Number.isFinite(value)) {
            approximate = true;
            return floor;
        }
        return value;
    };

    const attack = level('Attack', 1);
    const strength = level('Strength', 1);
    const defence = level('Defence', 1);
    const hitpoints = level('Hitpoints', 10);
    const prayer = level('Prayer', 1);
    const ranged = level('Ranged', 1);
    const magic = level('Magic', 1);

    const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
    const melee = 0.325 * (attack + strength);
    const range = 0.325 * Math.floor(ranged * 1.5);
    const mage = 0.325 * Math.floor(magic * 1.5);

    return {
        level: Math.floor(base + Math.max(melee, range, mage)),
        approximate
    };
}

/**
 * What the panel shows, from a parsed response.
 * @param {ReturnType<typeof parseHiscoresLite>} parsed
 */
function summarize(parsed) {
    const skills = parsed.skills.map((s) => ({
        name: s.name,
        level: s.level,
        xp: s.xp,
        ranked: s.ranked
    }));
    const combat = combatLevel(skills);

    // Highest by XP: a level 70 with more XP than another 70 is further along.
    const topSkills = skills
        .filter((s) => s.ranked && s.level !== null)
        .sort((a, b) => (b.xp ?? 0) - (a.xp ?? 0) || b.level - a.level)
        .slice(0, 3)
        .map((s) => ({ name: s.name, level: s.level }));

    // When Overall itself is unranked, the sum of what is ranked is a floor.
    const summed = skills.reduce((sum, s) => sum + (s.level ?? 1), 0);
    const totalLevel = parsed.overall.ranked && parsed.overall.level !== null
        ? parsed.overall.level
        : summed;

    return {
        totalLevel,
        totalLevelApproximate: !parsed.overall.ranked,
        totalXp: parsed.overall.ranked ? parsed.overall.xp : null,
        overallRank: parsed.overall.rank,
        combatLevel: combat.level,
        combatApproximate: combat.approximate,
        topSkills,
        skills
    };
}

/**
 * The lookup queue and cache.
 *
 * @param {object} options
 * @param {(url: string) => Promise<{status: number, body: string}>} options.fetchText
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.wait]
 * @param {{load: () => object|null, save: (data: object) => void}} [options.store]
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.log]
 */
function createHiscoresService(options) {
    const config = { ...DEFAULTS, ...options };
    const { fetchText } = config;
    const now = config.now || Date.now;
    const wait =
        config.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const store = config.store || null;
    const log = config.log || {};

    if (typeof fetchText !== 'function') {
        throw new Error('createHiscoresService needs fetchText');
    }

    /** key -> {status, name, data?, message?, fetchedAt} */
    const cache = new Map();
    /** key -> Promise of the lookup already under way for it. */
    const inflight = new Map();

    let chain = Promise.resolve();
    let lastRequestAt = -Infinity;
    let blockedUntil = -Infinity;

    loadFromDisk();

    function loadFromDisk() {
        if (!store) return;
        let saved;
        try {
            saved = store.load();
        } catch (error) {
            log.warn?.(`Ignoring unreadable hiscores cache: ${error.message}`);
            return;
        }
        const entries = saved && typeof saved === 'object' ? saved.entries : null;
        if (!entries || typeof entries !== 'object') return;
        const cutoff = now() - config.diskMaxAgeMs;
        for (const [key, entry] of Object.entries(entries)) {
            if (
                entry &&
                (entry.status === 'ok' || entry.status === 'not-found') &&
                Number.isFinite(entry.fetchedAt) &&
                entry.fetchedAt > cutoff &&
                cacheKey(entry.name) === key
            ) {
                cache.set(key, entry);
            }
        }
    }

    function saveToDisk() {
        if (!store) return;
        const entries = {};
        for (const [key, entry] of cache) {
            // Failures are worth remembering for minutes, not across restarts.
            if (entry.status === 'ok' || entry.status === 'not-found') {
                entries[key] = entry;
            }
        }
        try {
            store.save({ version: 1, entries });
        } catch (error) {
            log.warn?.(`Could not save the hiscores cache: ${error.message}`);
        }
    }

    function remember(key, entry) {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > config.maxEntries) {
            cache.delete(cache.keys().next().value);
        }
        saveToDisk();
        return entry;
    }

    function ttlFor(entry) {
        if (entry.status === 'ok') return config.ttlMs;
        if (entry.status === 'not-found') return config.notFoundTtlMs;
        return config.errorTtlMs;
    }

    function isFresh(entry, force) {
        const ttl = force
            ? Math.min(ttlFor(entry), config.forceMinAgeMs)
            : ttlFor(entry);
        return now() - entry.fetchedAt < ttl;
    }

    function view(entry, cached) {
        return { ...entry, cached };
    }

    /** Runs tasks one at a time, spaced out, and paused during a backoff. */
    function schedule(task) {
        const run = chain.then(async () => {
            const delay = Math.max(
                lastRequestAt + config.minGapMs - now(),
                blockedUntil - now(),
                0
            );
            if (delay > 0) {
                await wait(delay);
            }
            lastRequestAt = now();
            return task();
        });
        // One failed lookup must not stall every one queued behind it.
        chain = run.catch(() => {});
        return run;
    }

    async function fetchOne(name, key) {
        const url = `${HISCORES_URL}?player=${encodeURIComponent(name)}`;
        let response;
        try {
            response = await fetchText(url);
        } catch (error) {
            log.info?.(`Hiscores lookup failed: ${error.message}`);
            return remember(key, {
                status: 'error',
                name,
                message: 'Could not reach the hiscores.',
                fetchedAt: now()
            });
        }

        const status = Number(response?.status);
        if (status === 200) {
            const parsed = parseHiscoresLite(String(response.body ?? ''));
            if (!parsed) {
                return remember(key, {
                    status: 'error',
                    name,
                    message: 'The hiscores sent something unexpected.',
                    fetchedAt: now()
                });
            }
            return remember(key, {
                status: 'ok',
                name,
                data: summarize(parsed),
                fetchedAt: now()
            });
        }

        if (status === 404) {
            return remember(key, { status: 'not-found', name, fetchedAt: now() });
        }

        if (status === 429 || status === 503) {
            blockedUntil = now() + config.rateLimitBackoffMs;
            log.info?.(`Hiscores asked us to slow down (HTTP ${status}).`);
            return remember(key, {
                status: 'error',
                name,
                message: 'The hiscores are busy. Trying again shortly.',
                fetchedAt: now()
            });
        }

        log.info?.(`Hiscores lookup returned HTTP ${status}.`);
        return remember(key, {
            status: 'error',
            name,
            message: `The hiscores returned HTTP ${status}.`,
            fetchedAt: now()
        });
    }

    /**
     * Looks a display name up, from cache where it is fresh enough.
     * @param {string} rawName
     * @param {{force?: boolean}} [lookupOptions]
     */
    async function lookup(rawName, lookupOptions = {}) {
        const name = normalizeName(rawName);
        if (!name) {
            return { status: 'invalid', name: null, fetchedAt: now(), cached: false };
        }
        const key = name.toLowerCase();

        const cached = cache.get(key);
        if (cached && isFresh(cached, Boolean(lookupOptions.force))) {
            return view(cached, true);
        }

        if (inflight.has(key)) {
            return inflight.get(key);
        }

        const pending = schedule(() => fetchOne(name, key))
            .then((entry) => view(entry, false))
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
        return pending;
    }

    return { lookup, _cache: cache };
}

/**
 * A JSON file store for the cache. Levels and public names only.
 * @param {typeof import('fs')} fs
 * @param {string} filePath
 */
function fileStore(fs, filePath) {
    return {
        load() {
            if (!fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        },
        save(data) {
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
        }
    };
}

/**
 * Registers 'hiscores:lookup' with the main process.
 * @param {{ipcMain: import('electron').IpcMain, axios: import('axios').AxiosStatic,
 *          fs: typeof import('fs'), path: typeof import('path'), projectxDir: string, log: object}} deps
 */
function registerHiscoresHandlers(deps) {
    const { ipcMain, axios, fs, path, projectxDir, log } = deps;

    const service = createHiscoresService({
        fetchText: async (url) => {
            const response = await axios.get(url, {
                responseType: 'text',
                transformResponse: (body) => body,
                timeout: DEFAULTS.requestTimeoutMs,
                validateStatus: () => true,
                headers: { 'User-Agent': 'Project X Launcher' }
            });
            return { status: response.status, body: response.data };
        },
        store: fileStore(fs, path.join(projectxDir, 'hiscores-cache.json')),
        log
    });

    ipcMain.handle('hiscores:lookup', async (_event, name, options) => {
        try {
            return await service.lookup(name, { force: Boolean(options?.force) });
        } catch (error) {
            log.error(`Hiscores lookup failed: ${error.message}`);
            return { status: 'error', name: null, message: 'Lookup failed.' };
        }
    });

    return service;
}

module.exports = {
    HISCORES_URL,
    SKILL_NAMES,
    DEFAULTS,
    normalizeName,
    cacheKey,
    parseHiscoresLite,
    combatLevel,
    summarize,
    createHiscoresService,
    fileStore,
    registerHiscoresHandlers
};
