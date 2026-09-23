module.exports = async function (deps) {
    const {
        ipcMain,
        axios,
        projectxDir,
        packageJson,
        path,
        log,
        dialog,
        fs,
        projectDir,
        app
    } = deps;

    const site = 'https://xclient.dev';
    // Releases are served from GitHub, so the launcher needs no file host of its own.
    const releases = 'https://github.com/iEasyScript/xclient/releases/download';
    const releasesApi = 'https://api.github.com/repos/iEasyScript';

    const { startAuthFlow } = require(path.join(
        projectDir,
        'libs',
        'oauth-jagex.js'
    ));
    const { isBrowserDownloaded } = require(path.join(
        projectDir,
        'libs',
        'browser-util.js'
    ));

    ipcMain.handle('start-auth-flow', async () => {
        try {
            return await startAuthFlow();
        } catch (error) {
            log.error(`Error during authentication flow: ${error.message}`);
            return { error: error.message };
        }
    });

    ipcMain.handle('is-browser-downloaded', async () => {
        try {
            return await isBrowserDownloaded();
        } catch (error) {
            log.error(`Error checking if browser is downloaded: ${error}`);
            return { error: error.message };
        }
    });

    const propertiesHandler = require(path.join(
        projectDir,
        'libs',
        'properties.js'
    ));
    await propertiesHandler(deps);
    const overwriteCredentialsHandler = require(path.join(
        projectDir,
        'libs',
        'overwrite-credential-properties.js'
    ));
    await overwriteCredentialsHandler(deps);
    const accountLoaderHandler = require(path.join(
        projectDir,
        'libs',
        'accounts-loader.js'
    ));
    await accountLoaderHandler(deps);
    const jarExecutorHandler = require(path.join(
        projectDir,
        'libs',
        'jar-executor.js'
    ));
    await jarExecutorHandler(deps);
    const packageVersion = packageJson.version;

    ipcMain.handle('refresh-accounts', async () => {
        try {
            const { writeAccountsToFile } = require(path.join(
                projectDir,
                'libs',
                'oauth-jagex.js'
            ));

            const accountsPath = path.join(projectxDir, 'accounts.json');
            if (!fs.existsSync(accountsPath)) {
                return { error: 'accounts.json does not exist' };
            }

            let accountsData = [];
            try {
                const raw = fs.readFileSync(accountsPath, 'utf8');
                accountsData = JSON.parse(raw);
            } catch (err) {
                log.error('Failed to read accounts.json for refresh:', err.message);
                return { error: 'Failed to read accounts.json' };
            }

            if (!Array.isArray(accountsData) || accountsData.length === 0) {
                return { error: 'No accounts found to refresh' };
            }

            // Use first account's sessionId (assuming all accounts share the same session scope)
            const firstAccount = accountsData[0];
            const sessionId = firstAccount && firstAccount.sessionId;
            if (!sessionId) {
                return { error: 'No sessionId found in accounts.json' };
            }

            await writeAccountsToFile(sessionId);

            // Re-read accounts after refresh
            try {
                const updatedRaw = fs.readFileSync(accountsPath, 'utf8');
                const updatedAccounts = JSON.parse(updatedRaw);
                return { success: true, accounts: updatedAccounts };
            } catch (err) {
                log.error('Failed to read updated accounts.json after refresh:', err.message);
                return { success: true };
            }
        } catch (error) {
            log.error('Error refreshing accounts:', error.message);
            return { error: error.message };
        }
    });

    ipcMain.handle('download-client', async (event, version) => {
        const url = `${releases}/${version}/projectx-${version}.jar`;
        try {
            event.sender.send('progress', {
                percent: 90,
                status: 'Downloading Project X ' + version
            });
            if (
                fs.existsSync(path.join(projectxDir, `projectx-${version}.jar`))
            ) {
                return {
                    success: true,
                    path: path.join(projectxDir, `projectx-${version}.jar`)
                };
            }
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'arraybuffer',
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const progress = (
                            (progressEvent.loaded * 100) /
                            progressEvent.total
                        ).toFixed(2);
                        // Scale from 10% to 90% for download progress
                        let currentPercent = (10 + progress * 0.8).toFixed(2);
                        event.sender.send('progress', {
                            percent: currentPercent,
                            status: `Downloading client ${version}... (${progress}%)`
                        });
                    } else {
                        // Fallback
                        const downloadedMB = (
                            progressEvent.loaded /
                            (1024 * 1024)
                        ).toFixed(1);
                        event.sender.send('progress', {
                            percent: 50,
                            status: `Downloading client ${version}... (${downloadedMB}MB)`
                        });
                    }
                }
            });
            const filePath = path.join(projectxDir, `projectx-${version}.jar`);
            fs.writeFileSync(filePath, response.data);
            event.sender.send('progress', {
                percent: 100,
                status: 'Completed!'
            });
            return { success: true, path: filePath };
        } catch (error) {
            log.error(
                `Error downloading client ${version} from ${url}:`,
                error
            );
            return { error: error.message };
        }
    });

    ipcMain.handle('fetch-launcher-version', async () => {
        try {
            // The newest published launcher is whatever the latest release is tagged.
            const response = await axios.get(`${releasesApi}/xclient-launcher/releases/latest`);
            return String(response.data.tag_name ?? '').replace(/^v/, '');
        } catch (error) {
            log.error(`Error fetching launcher version: ${error}`);
            return { error: error.message };
        }
    });

    ipcMain.handle('fetch-client-version', async () => {
        // A locally built client wins over the published one, so a development
        // build is not treated as out of date and deleted by the cleanup.
        const localVersion = newestInstalledClientVersion();
        if (localVersion) {
            return localVersion;
        }
        try {
            const response = await axios.get(`${releasesApi}/xclient/releases/latest`);
            return String(response.data.tag_name ?? '').replace(/^v/, '');
        } catch (error) {
            log.error(`Error fetching client version: ${error}`);
            return { error: error.message };
        }
    });

    function newestInstalledClientVersion() {
        let files;
        try {
            files = fs.readdirSync(projectxDir);
        } catch (error) {
            return null;
        }
        const versions = files
            .map((file) => /^projectx-(\d+(?:\.\d+)*)\.jar$/.exec(file))
            .filter(Boolean)
            .map((match) => match[1]);
        if (versions.length === 0) {
            return null;
        }
        const parts = (v) => v.split('.').map(Number);
        return versions.sort((a, b) => {
            const pa = parts(a);
            const pb = parts(b);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const diff = (pb[i] || 0) - (pa[i] || 0);
                if (diff !== 0) {
                    return diff;
                }
            }
            return 0;
        })[0];
    }

    ipcMain.handle('client-exists', async (event, version) => {
        try {
            const filePath = path.join(projectxDir, `projectx-${version}.jar`);
            log.info(filePath);
            return fs.existsSync(filePath);
        } catch (error) {
            log.error(`Error checking if client exists: ${error}`);
            return { error: error.message };
        }
    });

    ipcMain.handle('list-jars', async () => {
        const files = fs.readdirSync(projectxDir, (err) => {
            if (err) {
                return log.error(`Unable to scan directory: ${err}`);
            }
        });
        const regex = /\d/;
        return files.filter(
            (file) =>
                file.startsWith('projectx-') &&
                file.endsWith('.jar') &&
                regex.test(file)
        );
    });

    /*
     * Read the profiles from the %USERPROFILE%/.runelite/profiles.json
     * and filter out profiles with negative ID, returning the name strings
     * so that the frontend can populate the profile select element
     */
    ipcMain.handle('list-profiles', async () => {
        const user = process.env.USERPROFILE || process.env.HOME;
        const profilesPath = path.join(
            user,
            '.runelite',
            'projectx-profiles',
            'profiles.json'
        );
        if (fs.existsSync(profilesPath)) {
            try {
                const data = fs.readFileSync(profilesPath, 'utf8');
                const object = JSON.parse(data);
                return object.profiles
                    .filter(
                        (profile) =>
                            profile.id > 0 && profile.name !== 'default'
                    )
                    .map((profile) => profile.name);
            } catch (error) {
                log.error(`Error reading profiles file: ${error}`);
                return { error: error.message };
            }
        } else {
            log.error('Profiles file does not exist');
            return { error: 'Profiles file does not exist' };
        }
    });

    ipcMain.handle('read-non-jagex-profile', async () => {
        const profileFilePath = path.join(
            projectxDir,
            'non-jagex-preferred-profile.json'
        );
        if (fs.existsSync(profileFilePath)) {
            try {
                const data = fs.readFileSync(profileFilePath, 'utf8');
                const profile = JSON.parse(data);
                return profile?.profile;
            } catch (error) {
                log.error(`Error reading non-Jagex profile file: ${error}`);
                return { error: error.message };
            }
        } else {
            log.error('Non-Jagex profile file does not exist');
            return { error: 'Non-Jagex profile file does not exist' };
        }
    });

    ipcMain.handle('launcher-version', async () => {
        return packageVersion;
    });

    ipcMain.handle('log-error', async (event, message) => {
        log.error(message);
    });

    ipcMain.handle('error-alert', async (event, message) => {
        try {
            const result = await dialog.showMessageBox({
                type: 'error',
                title: 'Error',
                message: message
            });
            return result;
        } catch (error) {
            log.error(`Error showing error alert: ${error}`);
            return { error: error.message };
        }
    });

    /**
     * Show a confirmation dialog with the given message and options
     * @param {string} message - The message to display in the dialog
     * @param {string} [defaultTitle="Confirm"] - The title of the dialog
     * @param {string} [yesButton="Yes"] - The text for the "Yes" button
     * @param {string} [noButton="No"] - The text for the "No" button
     */
    ipcMain.handle(
        'show-confirmation-dialog',
        async (
            event,
            message,
            detail,
            defaultTitle = 'Confirm',
            yesButton = 'Yes',
            noButton = 'No',
            options = {}
        ) => {
            try {
                const dialogOptions = {
                    type: options?.type || 'warning',
                    title: defaultTitle,
                    message: message,
                    detail: detail,
                    buttons: [yesButton, noButton],
                    defaultId:
                        typeof options?.defaultId === 'number'
                            ? options.defaultId
                            : 1,
                    cancelId:
                        typeof options?.cancelId === 'number'
                            ? options.cancelId
                            : 1,
                    noLink: false
                };

                const confirmIndex =
                    typeof options?.confirmIndex === 'number'
                        ? options.confirmIndex
                        : 0;

                const result = await dialog.showMessageBox(dialogOptions);
                return result.response === confirmIndex; // Return true if confirm button is clicked
            } catch (error) {
                log.error(`Error showing confirmation dialog: ${error}`);
                return { error: error.message };
            }
        }
    );

    /**
     * Cleans up unused client jar files in the projectxDir that haven't been used
     * in the past 3 days, except for the latest version which is always kept.
     * Uses a JSON file to track the last used timestamps for each version.
     * @param {string} latestVersion - The latest version string to exclude from deletion.
     * @returns {Object} Result object with success status or error message.
     */
    ipcMain.handle(
        'cleanup-unused-clients-jar',
        async (event, latestVersion) => {
            const { cleanupUnusedClientsJar } = require(path.join(
                projectDir,
                'libs',
                'dir-module.js'
            ));
            return await cleanupUnusedClientsJar(latestVersion);
        }
    );

    /**
     * Updates the last used timestamp for a specific client version.
     * @param {string} version - The client version to update.
     * @returns {Object} Result object indicating success or failure.
     */
    ipcMain.handle('update-client-jar-ttl', async (event, version) => {
        const { updateClientJarTTL } = require(path.join(
            projectDir,
            'libs',
            'dir-module.js'
        ));
        return await updateClientJarTTL(version);
    });
};
