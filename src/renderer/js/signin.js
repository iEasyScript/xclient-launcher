'use strict';

(function () {
    const PX = window.PX;

    function identityLabel(user) {
        const name = (user && (user.name || user.discordUsername)) || 'Signed in';
        const role = user && typeof user.role === 'string' ? user.role : 'USER';
        return role && role.toUpperCase() !== 'USER' ? name + ' (' + role.toLowerCase() + ')' : name;
    }

    // The sign-in gate. onSignedIn runs every time a session is confirmed.
    PX.createSignin = function createSignin({ onSignedIn, onSignedOut }) {
        const card = PX.$('signin');
        const discord = PX.$('discord-button');
        const pairing = PX.$('pairing');
        const code = PX.$('pairing-code');
        const error = PX.$('signin-error');
        const identity = PX.$('identity');
        const identityName = PX.$('identity-name');
        const signOut = PX.$('sign-out');

        function setError(message) {
            error.textContent = message || '';
        }

        function showDiscordView() {
            pairing.hidden = true;
            discord.hidden = false;
            discord.disabled = false;
            discord.textContent = 'Sign in with Discord';
        }

        function showCard(message) {
            showDiscordView();
            setError(message);
            identity.hidden = true;
            identityName.textContent = '';
            card.hidden = false;
            onSignedOut();
            discord.focus();
        }

        // keepError leaves a message from the sign-in itself in place after a successful check.
        async function check(options = {}) {
            let session;
            try {
                session = await PX.api.getSession();
            } catch (err) {
                PX.log('error', 'Session check failed: ' + err.message);
                showCard('Something went wrong checking your sign-in. Please try again.');
                return;
            }
            if (!session || !session.signedIn) {
                showCard(session && session.message);
                return;
            }
            card.hidden = true;
            if (!options.keepError) {
                setError('');
            }
            identityName.textContent = identityLabel(session.user);
            identityName.title = identityName.textContent;
            identity.hidden = false;
            onSignedIn(session.user);
        }

        discord.addEventListener('click', async () => {
            setError('');
            discord.disabled = true;
            discord.textContent = 'Opening browser...';
            let result;
            try {
                result = await PX.api.startPairing();
            } catch (err) {
                result = { ok: false, error: 'The sign-in could not be started. Please try again.' };
                PX.log('error', 'Pairing start failed: ' + err.message);
            }
            if (!result || !result.ok) {
                showDiscordView();
                setError(result && result.error);
                return;
            }
            code.textContent = result.userCode || '';
            PX.$('pairing-reopen').hidden = !result.verificationUrl;
            discord.hidden = true;
            pairing.hidden = false;
        });

        PX.$('pairing-reopen').addEventListener('click', (event) => {
            event.preventDefault();
            PX.api.reopenPairingPage().catch(() => {});
        });

        PX.$('pairing-cancel').addEventListener('click', () => {
            PX.api.cancelPairing().catch(() => {});
            showDiscordView();
            setError('');
        });

        PX.api.onPairingResult((payload) => {
            showDiscordView();
            if (!payload) {
                return;
            }
            if (payload.type === 'signed-in') {
                setError('');
                check();
            } else if (payload.type === 'error') {
                // Signed in, but the session was not saved: the card closes, so say it in a dialog too.
                setError(payload.message);
                PX.showError(payload.message);
                check({ keepError: true });
            } else {
                setError(payload.message || 'The sign-in could not be completed. Please try again.');
            }
        });

        signOut.addEventListener('click', async () => {
            signOut.disabled = true;
            signOut.textContent = 'Signing Out...';
            try {
                const result = await PX.api.signOut();
                if (result && result.ok === false) {
                    await PX.showError('Could not sign out: ' + result.error);
                } else {
                    showCard('');
                }
            } catch (err) {
                await PX.showError('Could not sign out: ' + err.message);
            } finally {
                signOut.disabled = false;
                signOut.textContent = 'Sign Out';
            }
        });

        return { check, identityLabel };
    };
})();
