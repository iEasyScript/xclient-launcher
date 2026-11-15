'use strict';

// A last line of defence: callers already avoid logging secrets, but anything that slips through
// (an error message echoing a URL, for example) is scrubbed before it reaches the log file.
const PATTERNS = [
    [/px_[A-Za-z0-9_-]{6,}/g, 'px_***'],
    [/((?:^|[?&#\s])(?:code|id_token|id_token_hint|access_token|refresh_token|code_verifier|code_challenge|nonce|state|deviceCode|sessionId)=)[^&#\s"']+/gi, '$1***'],
    [/("(?:token|deviceCode|device_code|sessionId|session_id|idToken|id_token|access_token|refresh_token|code|code_verifier)"\s*:\s*")[^"]*"/gi, '$1***"'],
    [/\b(JX_(?:SESSION_ID|ACCESS_TOKEN|REFRESH_TOKEN)=)[^\s]+/g, '$1***'],
    [/(Bearer\s+)[^\s"',]+/gi, '$1***'],
    [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***:***@']
];

function scrub(text) {
    let result = String(text);
    for (const [pattern, replacement] of PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

function scrubValue(value) {
    if (typeof value === 'string') {
        return scrub(value);
    }
    if (value instanceof Error) {
        const copy = new Error(scrub(value.message));
        copy.name = value.name;
        copy.stack = value.stack ? scrub(value.stack) : undefined;
        return copy;
    }
    return value;
}

// Replace any user name and password in a proxy URI with ***.
function redactProxy(uri) {
    if (!uri) {
        return uri;
    }
    try {
        const parsed = new URL(uri);
        if (parsed.username || parsed.password) {
            return parsed.protocol + '//***:***@' + parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
        }
        return uri;
    } catch (_) {
        return String(uri).replace(/\/\/.*@/, '//***@');
    }
}

module.exports = { scrub, scrubValue, redactProxy };
