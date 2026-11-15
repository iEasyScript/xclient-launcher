'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDirs = [];

function makeTempDir(prefix = 'pxl-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function cleanupTempDirs() {
    while (tempDirs.length) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
}

// A logger that records every line, so tests can assert nothing secret was written.
function makeLog() {
    const lines = [];
    const record = (level) => (...args) => {
        lines.push({ level, text: args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ') });
    };
    return {
        lines,
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        all: () => lines.map((line) => line.text).join('\n')
    };
}

function jsonResponse(status, body, headers = {}) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

function textResponse(status, text, headers = {}) {
    return new Response(text, { status, headers });
}

// handler(url, options, callIndex) returns a Response, a promise of one, or throws.
function makeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return handler(String(url), options, calls.length - 1);
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

function networkError(message = 'fetch failed') {
    const err = new TypeError(message);
    err.cause = { code: 'ECONNREFUSED' };
    return err;
}

function writeJsonFile(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJsonFile(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = {
    makeTempDir,
    cleanupTempDirs,
    makeLog,
    jsonResponse,
    textResponse,
    makeFetch,
    networkError,
    writeJsonFile,
    readJsonFile,
    flush
};
