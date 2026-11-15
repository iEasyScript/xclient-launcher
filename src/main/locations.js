'use strict';

const fs = require('fs');

const LOCATION_KEYS = ['projectx', 'runelite', 'launcherLogs', 'clientLogs'];

// The renderer only ever sends one of these keys; paths never cross the bridge.
function createLocations({ paths, shell, launcherLogFile, log }) {
    async function openPath(target) {
        const error = await shell.openPath(target);
        if (error) {
            throw new Error(error);
        }
    }

    async function open(key) {
        switch (key) {
            case 'projectx':
                fs.mkdirSync(paths.projectxDir, { recursive: true });
                return openPath(paths.projectxDir);
            case 'runelite':
                return openPath(paths.runeliteDir);
            case 'launcherLogs':
                return openPath(launcherLogFile());
            case 'clientLogs':
                try {
                    fs.mkdirSync(paths.clientLogsDir, { recursive: true });
                    return await openPath(paths.clientLogsDir);
                } catch (err) {
                    log.warn('Could not open the client session logs folder (' + err.message + '); opening the logs folder');
                    return openPath(paths.runeliteLogsDir);
                }
            default:
                throw new Error('Unknown location');
        }
    }

    return { open };
}

module.exports = { LOCATION_KEYS, createLocations };
