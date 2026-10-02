// mergeAccounts is pure; keep the browser and logger out of the test.
jest.mock('patchright', () => ({ chromium: {} }));
jest.mock('electron-log', () => ({ info: jest.fn(), error: jest.fn() }));

const { mergeAccounts } = require('../libs/oauth-jagex.js');

describe('mergeAccounts', () => {
    const saved = [
        {
            accountId: 'acc1',
            displayName: 'OldName',
            sessionId: 'SESSION1',
            createdOn: '2026-01-01T00:00:00.000Z',
            profile: 'main'
        },
        {
            accountId: 'acc2',
            displayName: 'Other',
            sessionId: 'SESSION2',
            createdOn: '2026-01-02T00:00:00.000Z',
            profile: 'alt'
        }
    ];

    test('a renamed character takes the new name and keeps its profile', () => {
        const { accounts, added, updated } = mergeAccounts(
            saved,
            [{ accountId: 'acc1', displayName: 'NewName' }],
            'SESSION1'
        );

        expect(added).toBe(0);
        expect(updated).toBe(1);
        expect(accounts).toHaveLength(2);
        expect(accounts[0]).toEqual({
            accountId: 'acc1',
            displayName: 'NewName',
            sessionId: 'SESSION1',
            createdOn: '2026-01-01T00:00:00.000Z',
            profile: 'main'
        });
    });

    test('characters from another session are left alone', () => {
        const { accounts } = mergeAccounts(
            saved,
            [{ accountId: 'acc1', displayName: 'NewName' }],
            'SESSION1'
        );

        expect(accounts[1]).toBe(saved[1]);
    });

    test('a new character is appended with a createdOn', () => {
        const { accounts, added, updated } = mergeAccounts(
            saved,
            [{ accountId: 'acc3', displayName: 'Brand New' }],
            'SESSION1'
        );

        expect(added).toBe(1);
        expect(updated).toBe(0);
        expect(accounts).toHaveLength(3);
        expect(accounts[2]).toMatchObject({
            accountId: 'acc3',
            displayName: 'Brand New',
            sessionId: 'SESSION1'
        });
        expect(typeof accounts[2].createdOn).toBe('string');
    });

    test('nothing changed reports nothing to write', () => {
        const withMembership = [
            { ...saved[0], membership: { tier: 'member', expiry: null } }
        ];
        const { added, updated } = mergeAccounts(
            withMembership,
            [
                {
                    accountId: 'acc1',
                    displayName: 'OldName',
                    membership: { tier: 'member', expiry: null }
                }
            ],
            'SESSION1'
        );

        expect(added).toBe(0);
        expect(updated).toBe(0);
    });

    test('signing in again moves a character to the new session', () => {
        const { accounts, updated } = mergeAccounts(
            saved,
            [{ accountId: 'acc1', displayName: 'OldName' }],
            'SESSION9'
        );

        expect(updated).toBe(1);
        expect(accounts[0].sessionId).toBe('SESSION9');
        expect(accounts[0].profile).toBe('main');
    });
});
