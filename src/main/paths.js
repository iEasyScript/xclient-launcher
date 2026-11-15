'use strict';

const os = require('os');
const path = require('path');

// Everything resolves from os.homedir(); HOME/USERPROFILE are never read directly, so a shell that
// sets HOME on Windows cannot split files across two folders.
function createPaths(home = os.homedir()) {
    const projectxDir = path.join(home, '.projectx');
    const runeliteDir = path.join(home, '.runelite');
    return {
        home,
        projectxDir,
        runeliteDir,
        accountsFile: path.join(projectxDir, 'accounts.json'),
        settingsFile: path.join(projectxDir, 'resource_versions.json'),
        nonJagexProfileFile: path.join(projectxDir, 'non-jagex-preferred-profile.json'),
        hiscoresCacheFile: path.join(projectxDir, 'hiscores-cache.json'),
        credentialsFile: path.join(runeliteDir, 'credentials.properties'),
        profilesFile: path.join(runeliteDir, 'projectx-profiles', 'profiles.json'),
        runeliteLogsDir: path.join(runeliteDir, 'logs'),
        clientLogsDir: path.join(runeliteDir, 'logs', 'projectx'),
        jarPath: (version) => path.join(projectxDir, 'projectx-' + version + '.jar')
    };
}

module.exports = { createPaths };
