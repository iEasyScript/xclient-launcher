const {
    DEFAULT_PROPERTIES,
    protectOwnedKeys
} = require('./account-nicknames.js');

module.exports = async function (deps) {
    const { fs, path, projectxDir, ipcMain, log } = deps;

    const filePath = path.resolve(projectxDir, 'resource_versions.json');

    // Define your default values here
    const defaultProperties = { ...DEFAULT_PROPERTIES };

    /** The file as it stands, or null if it is missing or unreadable. */
    function readOnDisk() {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (_) {
            return null;
        }
    }

    ipcMain.handle('write-properties', async (event, data) => {
        try {
            try {
                // Nicknames and the accounts panel settings are written by
                // their own handlers; keep what is on disk for those so a
                // stale copy from the renderer cannot undo a change.
                const toWrite = protectOwnedKeys(data, readOnDisk());
                fs.writeFileSync(
                    filePath,
                    JSON.stringify(toWrite, null, 2),
                    'utf8'
                );
            } catch (err) {
                console.error('Error writing to properties file:', err);
            }
        } catch (error) {
            logMessage(error.message);
            return { error: error.message };
        }
    });

    ipcMain.handle('read-properties', async () => {
        try {
            try {
                if (fs.existsSync(filePath)) {
                    const data = fs.readFileSync(filePath, 'utf8');
                    return JSON.parse(data);
                }
                fs.writeFileSync(
                    filePath,
                    JSON.stringify(defaultProperties, null, 2),
                    'utf8'
                );
                log.info('Properties file created with default values.');
                return defaultProperties;
            } catch (err) {
                console.error('Error reading properties file:', err);
                return {};
            }
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });
};
