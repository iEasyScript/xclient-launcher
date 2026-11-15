'use strict';

const SKILL_NAMES = [
    'Overall', 'Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking',
    'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore',
    'Agility', 'Thieving', 'Slayer', 'Farming', 'Runecraft', 'Hunter', 'Construction', 'Sailing'
];

// Overall plus the 23 skills the game launched with.
const MIN_ROWS = 24;

const COMBAT_FLOORS = { Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Ranged: 1, Prayer: 1, Magic: 1 };

function normaliseName(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const name = raw.replace(/[\u00A0_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9 -]{1,12}$/.test(name)) {
        return null;
    }
    return name;
}

function cacheKey(name) {
    const normalised = normaliseName(name);
    return normalised ? normalised.toLowerCase() : null;
}

function nonNegative(value) {
    return value >= 0 ? value : null;
}

// Returns an array of { name, rank, level, xp, ranked } or null when the text is not a hiscores page.
function parseHiscores(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const rows = [];
    for (const line of lines) {
        const match = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(line);
        if (!match) {
            break;
        }
        rows.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
    if (rows.length < MIN_ROWS) {
        return null;
    }
    return rows.map(([rank, level, xp], index) => {
        const name = SKILL_NAMES[index] || 'Skill ' + index;
        const ranked = rank >= 0;
        return {
            name,
            rank: ranked ? rank : null,
            level: ranked ? nonNegative(level) : null,
            xp: ranked ? nonNegative(xp) : null,
            ranked
        };
    });
}

function combatLevel(byName) {
    let approximate = false;
    const level = (name) => {
        const row = byName[name];
        if (row && row.ranked && row.level !== null) {
            return row.level;
        }
        approximate = true;
        return COMBAT_FLOORS[name];
    };
    const attack = level('Attack');
    const strength = level('Strength');
    const defence = level('Defence');
    const hitpoints = level('Hitpoints');
    const ranged = level('Ranged');
    const prayer = level('Prayer');
    const magic = level('Magic');
    const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
    const melee = 0.325 * (attack + strength);
    const range = 0.325 * Math.floor(ranged * 1.5);
    const mage = 0.325 * Math.floor(magic * 1.5);
    return { level: Math.floor(base + Math.max(melee, range, mage)), approximate };
}

function summarise(rows) {
    const overall = rows[0];
    const skills = rows.slice(1);
    const byName = {};
    for (const row of skills) {
        byName[row.name] = row;
    }
    const combat = combatLevel(byName);
    let totalLevel;
    let totalLevelApproximate = false;
    if (overall.ranked && overall.level !== null) {
        totalLevel = overall.level;
    } else {
        totalLevel = skills.reduce((sum, row) => sum + (row.ranked && row.level !== null ? row.level : 1), 0);
        totalLevelApproximate = true;
    }
    const topSkills = skills
        .filter((row) => row.ranked && row.level !== null)
        .sort((a, b) => (b.xp || 0) - (a.xp || 0) || b.level - a.level)
        .slice(0, 3)
        .map((row) => ({ name: row.name, level: row.level }));
    return {
        totalLevel,
        totalLevelApproximate,
        totalXp: overall.ranked ? overall.xp : null,
        overallRank: overall.ranked ? overall.rank : null,
        combatLevel: combat.level,
        combatApproximate: combat.approximate,
        topSkills,
        skills: skills.map((row) => ({ name: row.name, level: row.level, xp: row.xp, ranked: row.ranked }))
    };
}

module.exports = { SKILL_NAMES, MIN_ROWS, normaliseName, cacheKey, parseHiscores, combatLevel, summarise };
