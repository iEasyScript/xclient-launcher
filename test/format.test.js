'use strict';

const F = require('../src/shared/format');
const { scrub, scrubValue } = require('../src/main/redact');
const { readClientProfiles, readNonJagexProfile, writeNonJagexProfile } = require('../src/main/profiles');
const path = require('path');
const fs = require('fs');
const { makeTempDir, cleanupTempDirs, makeLog, writeJsonFile, readJsonFile } = require('./helpers');

afterEach(cleanupTempDirs);

describe('number formatting', () => {
    test('en-GB thousands separators and dashes for missing values', () => {
        expect(F.formatNumber(1234567)).toBe('1,234,567');
        expect(F.formatNumber(null)).toBe('\u2013');
    });

    test('compact XP', () => {
        expect(F.formatXpCompact(1234567890)).toBe('1.23B');
        expect(F.formatXpCompact(15432100)).toBe('15.4M');
        expect(F.formatXpCompact(737627)).toBe('738K');
        expect(F.formatXpCompact(999)).toBe('999');
        expect(F.formatXpCompact(undefined)).toBe('\u2013');
    });

    test('relative time', () => {
        const now = 10_000_000;
        expect(F.relativeTime(now - 20_000, now)).toBe('just now');
        expect(F.relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
        expect(F.relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago');
        expect(F.relativeTime(now - 3 * 60 * 60_000, now)).toBe('3 hours ago');
    });

    test('skill abbreviations', () => {
        expect(F.skillAbbreviation('Woodcutting')).toBe('WC');
        expect(F.skillAbbreviation('Sailing')).toBe('Sail');
        expect(F.skillAbbreviation('Skill 25')).toBe('Skill 25');
    });
});

describe('account labels and order', () => {
    const accounts = [
        { accountId: '3', displayName: 'zed', createdOn: '2026-01-03T00:00:00Z' },
        { accountId: '1', displayName: ' Alpha ', createdOn: '2026-01-01T00:00:00Z' },
        { accountId: '2', displayName: null, createdOn: '2026-01-05T00:00:00Z' }
    ];

    test('nickname (name), name, or Not set', () => {
        expect(F.accountLabel(accounts[0], { 3: 'WC account' })).toBe('WC account (zed)');
        expect(F.accountLabel(accounts[0], {})).toBe('zed');
        expect(F.accountLabel(accounts[2], {})).toBe('Not set');
    });

    test('alphabetical, case-insensitive, trimmed, falling back to the id', () => {
        expect(F.sortAccountsAlphabetically(accounts).map((a) => a.accountId)).toEqual(['2', '1', '3']);
    });

    test('newest by createdOn, not alphabetical', () => {
        expect(F.newestAccount(accounts).accountId).toBe('2');
    });
});

describe('log scrubbing', () => {
    test('tokens, codes and session ids are replaced', () => {
        const text = scrub('token px_AbCdEf123456 url https://x.test/cb?code=SECRETCODE&state=S1#id_token=IDT Bearer sess-123 "deviceCode":"dev-1" socks5://bob:pw@h:1');
        for (const secret of ['px_AbCdEf123456', 'SECRETCODE', 'IDT', 'sess-123', 'dev-1', 'bob:pw']) {
            expect(text).not.toContain(secret);
        }
        expect(text).toContain('px_***');
    });

    test('errors are scrubbed too', () => {
        const err = scrubValue(new Error('failed at https://a.test/?code=XYZ'));
        expect(err.message).not.toContain('XYZ');
        expect(scrubValue(42)).toBe(42);
    });
});

describe('profiles', () => {
    test('client profiles skip internal entries and default', () => {
        const file = path.join(makeTempDir(), 'profiles.json');
        writeJsonFile(file, { profiles: [
            { id: -1, name: '$rsprofile', active: false },
            { id: 3353058880900, name: 'default', active: true },
            { id: 4410293847112, name: 'Woodcutting alt', active: false },
            { id: 5, name: 'Woodcutting alt' },
            { id: '7', name: 'string id' }
        ] });
        expect(readClientProfiles(file, makeLog())).toEqual(['Woodcutting alt']);
    });

    test('missing or unreadable profile files give nothing extra', () => {
        const dir = makeTempDir();
        expect(readClientProfiles(path.join(dir, 'none.json'), makeLog())).toEqual([]);
        const bad = path.join(dir, 'bad.json');
        fs.writeFileSync(bad, '{');
        const log = makeLog();
        expect(readClientProfiles(bad, log)).toEqual([]);
        expect(log.lines.length).toBe(1);
    });

    test('normal-account profile round trip', () => {
        const file = path.join(makeTempDir(), 'non-jagex-preferred-profile.json');
        expect(readNonJagexProfile(file, makeLog())).toBeNull();
        writeNonJagexProfile(file, 'Woodcutting alt');
        expect(readJsonFile(file)).toEqual({ profile: 'Woodcutting alt' });
        expect(readNonJagexProfile(file, makeLog())).toBe('Woodcutting alt');
    });
});
