const fs = require('fs');
const os = require('os');
const path = require('path');

const setupProjectXAccount = require('../libs/projectx-account.js');

/**
 * The pairing flow is the launcher's whole account system, so these cover the
 * paths that decide whether a user ends up signed in: what is stored, what is
 * handed to the client, and what happens when the site says no.
 */
describe('projectx-account', () => {
    let tempDir;
    let handlers;
    let account;
    let sender;
    let sent;

    const sessionFile = () => path.join(tempDir, 'projectx-session.json');
    const readSession = () => JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxacct-'));
        handlers = {};
        sent = [];

        sender = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };

        account = setupProjectXAccount({
            ipcMain: {
                handle: (channel, fn) => {
                    handlers[channel] = fn;
                }
            },
            app: { getPath: () => tempDir },
            shell: { openExternal: jest.fn().mockResolvedValue(undefined) },
            log: { info: jest.fn(), error: jest.fn() }
        });

        process.env.PROJECTX_SITE_URL = 'https://site.test';
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete process.env.PROJECTX_SITE_URL;
        delete global.fetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
        jest.useRealTimers();
    });

    const jsonResponse = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    });

    /** Polling is floored at one second, so wait for the result rather than a clock. */
    const waitForUpdate = async (timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (sent.length > 0) return sent[0].payload;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('the pairing loop never reported a result');
    };

    describe('currentToken', () => {
        it('is null when nobody has signed in', () => {
            expect(account.currentToken()).toBeNull();
        });

        it('is the stored token once a session exists', () => {
            fs.writeFileSync(sessionFile(), JSON.stringify({ token: 'px_stored' }));
            expect(account.currentToken()).toBe('px_stored');
        });

        it('is null rather than throwing when the session file is corrupt', () => {
            fs.writeFileSync(sessionFile(), 'not json');
            expect(account.currentToken()).toBeNull();
        });
    });

    describe('projectx:session', () => {
        it('reports signed out with no session file', async () => {
            const result = await handlers['projectx:session']();
            expect(result).toEqual({ signedIn: false, siteUrl: 'https://site.test' });
        });

        it('refreshes the cached identity from the site', async () => {
            fs.writeFileSync(
                sessionFile(),
                JSON.stringify({ token: 'px_live', user: { name: 'old', role: 'USER' } })
            );
            global.fetch.mockResolvedValue(
                jsonResponse(200, { id: 'u1', name: 'new', role: 'DEVELOPER' })
            );

            const result = await handlers['projectx:session']();

            expect(result.signedIn).toBe(true);
            expect(result.user.role).toBe('DEVELOPER');
            // The refreshed identity is written back, so the next cold start of
            // the launcher already knows about the new role.
            expect(readSession().user.role).toBe('DEVELOPER');
        });

        it('drops a token the site rejects', async () => {
            fs.writeFileSync(sessionFile(), JSON.stringify({ token: 'px_revoked' }));
            global.fetch.mockResolvedValue(jsonResponse(401, {}));

            const result = await handlers['projectx:session']();

            expect(result.signedIn).toBe(false);
            expect(result.message).toMatch(/sign in again/i);
            expect(fs.existsSync(sessionFile())).toBe(false);
        });

        it('keeps the session when the site is unreachable', async () => {
            fs.writeFileSync(
                sessionFile(),
                JSON.stringify({ token: 'px_live', user: { name: 'cached' } })
            );
            global.fetch.mockRejectedValue(new Error('ENOTFOUND'));

            const result = await handlers['projectx:session']();

            // Offline is not signed out: the token is still good.
            expect(result).toMatchObject({ signedIn: true, stale: true });
            expect(result.user.name).toBe('cached');
            expect(account.currentToken()).toBe('px_live');
        });
    });

    describe('projectx:pair-start', () => {
        it('returns the code and opens the browser at the approval page', async () => {
            global.fetch.mockResolvedValueOnce(
                jsonResponse(200, {
                    userCode: 'BCDF-2345',
                    deviceCode: 'device-secret',
                    verificationUrlComplete: 'https://site.test/pair?code=BCDF-2345',
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                    pollSeconds: 3
                })
            );
            // Cancelled below, before the first poll is due.
            global.fetch.mockResolvedValue(jsonResponse(202, { status: 'pending' }));

            const result = await handlers['projectx:pair-start']({ sender });

            expect(result.userCode).toBe('BCDF-2345');
            expect(result.verificationUrl).toContain('/pair?code=BCDF-2345');

            await handlers['projectx:pair-cancel']();
        });

        it('surfaces a refusal from the site instead of a code', async () => {
            global.fetch.mockResolvedValueOnce(jsonResponse(503, { message: 'Down for maintenance.' }));

            const result = await handlers['projectx:pair-start']({ sender });

            expect(result.error).toBe('Down for maintenance.');
        });

        it('reports a network failure as an error the user can act on', async () => {
            global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const result = await handlers['projectx:pair-start']({ sender });

            expect(result.error).toMatch(/could not reach/i);
        });

        it('stores the token and announces the sign-in once approved', async () => {
            global.fetch
                .mockResolvedValueOnce(
                    jsonResponse(200, {
                        userCode: 'BCDF-2345',
                        deviceCode: 'device-secret',
                        verificationUrlComplete: 'https://site.test/pair?code=BCDF-2345',
                        pollSeconds: 1
                    })
                )
                .mockResolvedValueOnce(jsonResponse(202, { status: 'pending' }))
                .mockResolvedValueOnce(
                    jsonResponse(200, {
                        status: 'approved',
                        token: 'px_minted',
                        user: { id: 'u1', name: 'Cryptic', role: 'ADMIN' }
                    })
                )
                // Anything after the approval would mean the loop failed to stop.
                .mockResolvedValue(jsonResponse(410, { message: 'polled after approval' }));

            await handlers['projectx:pair-start']({ sender });

            // One pending poll, then the approval.
            await expect(waitForUpdate()).resolves.toEqual({
                state: 'signed-in',
                user: { id: 'u1', name: 'Cryptic', role: 'ADMIN' }
            });
            // This is what the client is launched with.
            expect(account.currentToken()).toBe('px_minted');
        });

        it('tells the user when the pairing expired rather than polling forever', async () => {
            global.fetch
                .mockResolvedValueOnce(
                    jsonResponse(200, {
                        userCode: 'BCDF-2345',
                        deviceCode: 'device-secret',
                        verificationUrlComplete: 'https://site.test/pair',
                        pollSeconds: 1
                    })
                )
                .mockResolvedValue(jsonResponse(410, { message: 'This pairing expired.' }));

            await handlers['projectx:pair-start']({ sender });

            await expect(waitForUpdate()).resolves.toEqual({
                state: 'error',
                message: 'This pairing expired.'
            });
            expect(account.currentToken()).toBeNull();
        });
    });

    describe('projectx:signout', () => {
        it('forgets the token so the client stops launching signed in', async () => {
            fs.writeFileSync(sessionFile(), JSON.stringify({ token: 'px_live' }));

            const result = await handlers['projectx:signout']();

            expect(result).toEqual({ signedIn: false });
            expect(account.currentToken()).toBeNull();
        });
    });
});
