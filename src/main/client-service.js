'use strict';

const {
    resolveCurrentVersion,
    listInstalledJars,
    versionFromJarName,
    jarName
} = require('./client-versions');
const { downloadClient } = require('./client-download');

function createClientService({ paths, settings, siteUrl, fetch: fetchImpl, env = process.env, log }) {
    const dir = paths.projectxDir;

    function resolve() {
        return resolveCurrentVersion({ env, fetch: fetchImpl, siteUrl, dir, log });
    }

    function listInstalled() {
        return listInstalledJars(dir);
    }

    function download(version, onProgress) {
        return downloadClient(version, { dir, siteUrl, env, log, fetch: fetchImpl, onProgress });
    }

    // Decides whether the update banner is needed and keeps the "client" setting honest.
    async function checkForUpdate() {
        const current = await resolve();
        if (!current.ok) {
            return { ok: false, error: current.error };
        }
        const installed = listInstalled();
        log.info('Client update check: current ' + current.version + ', installed [' + installed.join(', ') + ']');
        const saved = settings.read();
        if (installed.includes(jarName(current.version))) {
            if (saved.client !== current.version) {
                settings.update('client', current.version);
            }
            return { ok: true, needsUpdate: false, latest: current.version };
        }
        if (saved.client === current.version) {
            settings.update('client', installed.length ? versionFromJarName(installed[0]) : '0.0.0');
        }
        return { ok: true, needsUpdate: true, latest: current.version };
    }

    return { resolve, listInstalled, download, checkForUpdate };
}

module.exports = { createClientService };
