'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { errorMessage } = require('./http');
const { isNumericVersion, isVersionString, compareVersions, jarName, listNumericJars, pinnedVersion } = require('./client-versions');

const CONNECT_TIMEOUT_MS = 15000;
const STALL_TIMEOUT_MS = 30000;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const NOT_A_JAR = 'The download was not a client jar';

function clientJarUrl(siteUrl, version) {
    return siteUrl + '/api/v1/client/releases/' + encodeURIComponent(version) + '/' + jarName(version);
}

// Delete strictly-numeric jars older than the version just downloaded. Newer jars are never touched.
function pruneOlderJars({ dir, version, env, log }) {
    if (pinnedVersion(env)) {
        log.info('Skipping old client clean-up: version is pinned');
        return [];
    }
    if (!isNumericVersion(version)) {
        log.info('Skipping old client clean-up: ' + version + ' is not a numeric version');
        return [];
    }
    const removed = [];
    for (const jar of listNumericJars(dir)) {
        if (compareVersions(jar.version, version) >= 0) {
            continue;
        }
        try {
            fs.unlinkSync(path.join(dir, jar.name));
            removed.push(jar.name);
            log.info('Removed old client ' + jar.name);
        } catch (err) {
            log.warn('Could not remove old client ' + jar.name + ' (' + err.code + '); will try again next time');
        }
    }
    return removed;
}

async function streamToFile({ response, tempPath, signal, onChunk }) {
    const out = fs.createWriteStream(tempPath, { flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let head = Buffer.alloc(0);
    let failed = null;
    out.on('error', (err) => {
        failed = err;
    });
    try {
        for await (const chunk of response.body) {
            if (failed) {
                throw failed;
            }
            if (signal.aborted) {
                throw signal.reason || new Error('Download aborted');
            }
            const buffer = Buffer.from(chunk);
            hash.update(buffer);
            if (head.length < ZIP_SIGNATURE.length) {
                head = Buffer.concat([head, buffer.subarray(0, ZIP_SIGNATURE.length - head.length)]);
            }
            onChunk(buffer.length);
            if (!out.write(buffer)) {
                await once(out, 'drain');
            }
        }
        out.end();
        await once(out, 'finish');
        if (failed) {
            throw failed;
        }
    } catch (err) {
        out.destroy();
        throw err;
    }
    return { sha256: hash.digest('hex'), head };
}

function removeQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch (_) {
        // already gone
    }
}

async function downloadFromSource({ url, version, dir, fetchImpl, onProgress, connectTimeoutMs, stallTimeoutMs }) {
    const finalPath = path.join(dir, jarName(version));
    const tempPath = path.join(dir, '.' + jarName(version) + '.' + crypto.randomBytes(6).toString('hex') + '.part');
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error('Timed out connecting to the download server')), connectTimeoutMs);
    const resetStall = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('The download stalled')), stallTimeoutMs);
    };
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }
        if (!response.body) {
            throw new Error('Empty response');
        }
        resetStall();
        const expected = (response.headers.get('x-checksum-sha256') || '').trim().toLowerCase();
        const total = Number(response.headers.get('content-length')) || 0;
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (!expected && contentType.includes('text/html')) {
            throw new Error(NOT_A_JAR);
        }
        let received = 0;
        let lastReported = -1;
        const report = () => {
            if (total > 0) {
                const raw = Math.min(100, (received / total) * 100);
                if (Math.floor(raw) !== lastReported) {
                    lastReported = Math.floor(raw);
                    onProgress({ percent: 10 + 0.8 * raw, status: 'Downloading client ' + version + '... (' + raw.toFixed(2) + '%)' });
                }
            } else {
                const mb = Math.floor(received / (1024 * 1024));
                if (mb !== lastReported) {
                    lastReported = mb;
                    onProgress({ percent: 50, status: 'Downloading client ' + version + '... (' + (received / (1024 * 1024)).toFixed(1) + 'MB)' });
                }
            }
        };
        report();
        const written = await streamToFile({
            response,
            tempPath,
            signal: controller.signal,
            onChunk: (length) => {
                received += length;
                resetStall();
                report();
            }
        });
        if (expected && written.sha256 !== expected) {
            throw new Error('Checksum mismatch: expected ' + expected + ' but received ' + written.sha256);
        }
        // Without a checksum, at least make sure this is a jar and not an error page.
        if (!expected && !written.head.equals(ZIP_SIGNATURE)) {
            throw new Error(NOT_A_JAR);
        }
        fs.renameSync(tempPath, finalPath);
        return finalPath;
    } catch (err) {
        removeQuietly(tempPath);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Downloads projectx-<version>.jar from the site. Resolves { ok, path } or { ok: false, error }.
async function downloadClient(version, options) {
    const {
        dir,
        siteUrl,
        env = process.env,
        log,
        fetch: fetchImpl,
        onProgress = () => {},
        connectTimeoutMs = CONNECT_TIMEOUT_MS,
        stallTimeoutMs = STALL_TIMEOUT_MS
    } = options;
    if (!isVersionString(version)) {
        return { ok: false, error: 'Invalid client version.' };
    }
    const finalPath = path.join(dir, jarName(version));
    if (fs.existsSync(finalPath)) {
        onProgress({ percent: 100, status: 'Completed!' });
        return { ok: true, path: finalPath };
    }
    fs.mkdirSync(dir, { recursive: true });
    onProgress({ percent: 0, status: 'Downloading client ' + version + '...' });

    const sources = [clientJarUrl(siteUrl, version)];
    let lastError = null;
    for (const url of sources) {
        try {
            log.info('Downloading client ' + version + ' from ' + url);
            await downloadFromSource({ url, version, dir, fetchImpl, onProgress, connectTimeoutMs, stallTimeoutMs });
            log.info('Downloaded client ' + version);
            pruneOlderJars({ dir, version, env, log });
            onProgress({ percent: 100, status: 'Completed!' });
            return { ok: true, path: finalPath };
        } catch (err) {
            lastError = errorMessage(err);
            log.error('Client ' + version + ' download failed from ' + url + ': ' + lastError);
        }
    }
    return { ok: false, error: lastError || 'Could not download the client.' };
}

module.exports = { clientJarUrl, pruneOlderJars, downloadClient };
