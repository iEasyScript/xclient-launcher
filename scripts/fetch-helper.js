'use strict';

// Downloads the pinned wireproxy release for VPN presets into vendor/wireproxy/<target>/, checks
// each archive against the SHA-256 in scripts/wireproxy.json and unpacks the binary. The release
// build copies it into the app's resources (package.json, extraResources).
//
//   npm run fetch-helper                    this platform's helper
//   npm run fetch-helper -- --target all    every platform
//   npm run fetch-helper -- --target linux-x64 --force

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { helperTarget } = require('../src/main/vpn');

const ROOT = path.join(__dirname, '..');
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'wireproxy.json'), 'utf8'));
const VENDOR = path.join(ROOT, 'vendor', 'wireproxy');
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
    const options = { targets: null, force: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--force') {
            options.force = true;
        } else if (argv[i] === '--target' && argv[i + 1]) {
            options.targets = argv[++i] === 'all' ? Object.keys(PINS.targets) : argv[i].split(',');
        } else {
            throw new Error('Unknown argument: ' + argv[i]);
        }
    }
    if (!options.targets) {
        const own = helperTarget(process.platform, process.arch);
        if (!own) {
            throw new Error('There is no VPN helper for ' + process.platform + '-' + process.arch + '.');
        }
        options.targets = [own];
    }
    for (const target of options.targets) {
        if (!PINS.targets[target]) {
            throw new Error('Unknown target ' + target + '. Known: ' + Object.keys(PINS.targets).join(', '));
        }
    }
    return options;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error('Download failed (HTTP ' + response.status + '): ' + url);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) {
        throw new Error('The download is larger than expected: ' + url);
    }
    return buffer;
}

function readOctal(buffer, start, length) {
    const text = buffer.toString('ascii', start, start + length).replace(/\0.*$/, '').trim();
    return text ? parseInt(text, 8) : 0;
}

function readString(buffer, start, length) {
    return buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
}

// The contents of one regular file in a tar archive, found by its base name.
function extractFromTar(tar, wanted) {
    let offset = 0;
    let longName = null;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        const size = readOctal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 48);
        const prefix = readString(header, 345, 155);
        const name = longName || (prefix ? prefix + '/' : '') + readString(header, 0, 100);
        const dataStart = offset + 512;
        longName = null;
        if (type === 'L') {
            longName = readString(tar, dataStart, size);
        } else if ((type === '0' || type === '\0') && path.posix.basename(name) === wanted) {
            return tar.subarray(dataStart, dataStart + size);
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    throw new Error(wanted + ' was not found in the archive.');
}

function isUniversalMachO(buffer) {
    return buffer.length > 4 && buffer.readUInt32BE(0) === 0xcafebabe;
}

async function fetchTarget(target, force) {
    const pin = PINS.targets[target];
    const dir = path.join(VENDOR, target);
    const binaryPath = path.join(dir, pin.binary);
    const stampPath = path.join(dir, '.pinned');
    const stamp = PINS.version + ' ' + pin.sha256;
    if (!force && fs.existsSync(binaryPath) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8').trim() === stamp) {
        console.log(target + ': wireproxy ' + PINS.version + ' already present');
        return;
    }
    const url = PINS.releaseUrl + pin.asset;
    console.log(target + ': downloading ' + url);
    const archive = await download(url);
    const actual = sha256(archive);
    if (actual !== pin.sha256) {
        throw new Error(target + ': checksum mismatch for ' + pin.asset + '\n  expected ' + pin.sha256 + '\n  got      ' + actual);
    }
    const binary = extractFromTar(zlib.gunzipSync(archive), pin.binary);
    if (pin.universal && !isUniversalMachO(binary)) {
        throw new Error(target + ': ' + pin.asset + ' is not a universal macOS binary');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(binaryPath, binary, { mode: 0o755 });
    fs.chmodSync(binaryPath, 0o755);
    fs.writeFileSync(stampPath, stamp + '\n');
    console.log(target + ': verified ' + pin.asset + ' (sha256 ' + actual + '), wrote ' + path.relative(ROOT, binaryPath));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    for (const target of options.targets) {
        await fetchTarget(target, options.force);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = { extractFromTar, isUniversalMachO, parseArgs };
