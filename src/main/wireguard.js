'use strict';

const net = require('net');
const crypto = require('crypto');

// WireGuard config files, as VPN providers hand them out (the wg-quick format), turned into the
// subset the bundled helper understands. Nothing in a config is ever run: the hook keys
// (PostUp and friends) are dropped, and the helper's config is rebuilt from checked values only,
// so sections or keys meant for other tools never reach it.

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PEERS = 16;
const MAX_LIST = 64;

// Used when a config names no DNS server, so names are looked up through the tunnel instead of on
// this PC's own network.
const FALLBACK_DNS = ['1.1.1.1', '1.0.0.1'];

const HOOK_KEYS = ['postup', 'postdown', 'preup', 'predown'];
// wg-quick settings for the system network stack; the helper has no use for them.
const SYSTEM_KEYS = ['table', 'saveconfig', 'fwmark'];

const KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isKey(value) {
    return typeof value === 'string' && KEY_PATTERN.test(value) && Buffer.from(value, 'base64').length === 32;
}

function splitList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function isAddress(value) {
    return net.isIP(value) !== 0;
}

// An address with an optional prefix length, as in Address and AllowedIPs.
function parseCidr(value) {
    const slash = value.indexOf('/');
    const ip = slash >= 0 ? value.slice(0, slash) : value;
    const family = net.isIP(ip);
    if (!family) {
        return null;
    }
    const max = family === 4 ? 32 : 128;
    if (slash < 0) {
        return { ip, prefix: max, family };
    }
    const text = value.slice(slash + 1);
    if (!/^\d{1,3}$/.test(text) || Number(text) > max) {
        return null;
    }
    return { ip, prefix: Number(text), family };
}

function cidrText(cidr) {
    return cidr.ip + '/' + cidr.prefix;
}

function ipv4ToNumber(ip) {
    return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

// Whether an IPv4 address falls inside one of the given AllowedIPs ranges.
function coversIpv4(allowed, ip) {
    const target = ipv4ToNumber(ip);
    return allowed.some((cidr) => {
        if (cidr.family !== 4) {
            return false;
        }
        const size = 2 ** (32 - cidr.prefix);
        const start = Math.floor(ipv4ToNumber(cidr.ip) / size) * size;
        return target >= start && target < start + size;
    });
}

function coversAddress(allowed, ip) {
    if (net.isIP(ip) === 4) {
        return coversIpv4(allowed, ip);
    }
    // IPv6 DNS servers: only a full IPv6 route is recognised.
    return allowed.some((cidr) => cidr.family === 6 && cidr.prefix === 0);
}

// host:port or [v6]:port. Returns null when it is not one.
function parseEndpoint(value) {
    const match = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(value) || /^([^:\s[\]]+):(\d{1,5})$/.exec(value);
    if (!match) {
        return null;
    }
    const host = match[1];
    const port = Number(match[2]);
    if (port < 1 || port > 65535) {
        return null;
    }
    if (value.startsWith('[') ? net.isIP(host) !== 6 : !(net.isIP(host) === 4 || HOSTNAME.test(host))) {
        return null;
    }
    return { host, port, text: value.startsWith('[') ? '[' + host + ']:' + port : host + ':' + port };
}

function intIn(value, min, max) {
    if (!/^\d{1,6}$/.test(value)) {
        return null;
    }
    const number = Number(value);
    return number >= min && number <= max ? number : null;
}

function readSections(text) {
    const sections = [];
    const stray = [];
    let current = null;
    for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.replace(/[#;].*$/, '').trim();
        if (!line) {
            continue;
        }
        const header = /^\[([^\]]*)\]$/.exec(line);
        if (header) {
            current = { name: header[1].trim(), entries: [] };
            sections.push(current);
            continue;
        }
        const eq = line.indexOf('=');
        if (eq <= 0) {
            return { error: 'This does not look like a WireGuard config: "' + line.slice(0, 40) + '" is not a setting.' };
        }
        const entry = { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
        if (current) {
            current.entries.push(entry);
        } else {
            stray.push(entry);
        }
    }
    return { sections, stray };
}

function addUnique(list, values) {
    for (const value of values) {
        if (!list.includes(value)) {
            list.push(value);
        }
    }
}

// Parses, checks and cleans a WireGuard config.
// { ok: true, config, warnings } | { ok: false, error }
function parseWireGuardConfig(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, error: 'The file is empty.' };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
        return { ok: false, error: 'The file is too big to be a WireGuard config.' };
    }
    if (/\u0000/.test(text)) {
        return { ok: false, error: 'This is not a text file.' };
    }
    const read = readSections(text);
    if (read.error) {
        return { ok: false, error: read.error };
    }
    const warnings = [];
    const dropped = new Set();
    const hooks = new Set();
    const iface = { privateKey: null, addresses: [], dns: [], mtu: null };
    const peers = [];
    let interfaceCount = 0;

    if (read.stray.length) {
        warnings.push('Settings outside [Interface] and [Peer] were removed.');
    }

    const otherSections = new Set();
    for (const section of read.sections) {
        const kind = section.name.toLowerCase();
        if (kind !== 'interface' && kind !== 'peer') {
            otherSections.add('[' + section.name + ']');
            continue;
        }
        if (kind === 'interface') {
            interfaceCount++;
        }
        const peer = kind === 'peer' ? { publicKey: null, presharedKey: null, endpoint: null, allowedIps: [], keepalive: null } : null;
        for (const { key, value } of section.entries) {
            const name = key.toLowerCase();
            if (value.startsWith('$')) {
                return { ok: false, error: key + ' must hold its value directly, not refer to a variable.' };
            }
            if (HOOK_KEYS.includes(name)) {
                hooks.add(key);
                continue;
            }
            if (kind === 'interface') {
                if (name === 'privatekey') {
                    if (!isKey(value)) {
                        return { ok: false, error: 'The PrivateKey in [Interface] is not a valid WireGuard key.' };
                    }
                    iface.privateKey = value;
                } else if (name === 'address') {
                    const items = splitList(value).map(parseCidr);
                    if (items.some((item) => !item)) {
                        return { ok: false, error: 'An Address in [Interface] is not an IP address.' };
                    }
                    addUnique(iface.addresses, items.map(cidrText));
                } else if (name === 'dns') {
                    const items = splitList(value);
                    const ips = items.filter(isAddress);
                    if (ips.length < items.length) {
                        warnings.push('DNS search domains are not used and were removed.');
                    }
                    addUnique(iface.dns, ips);
                } else if (name === 'mtu') {
                    const mtu = intIn(value, 576, 9000);
                    if (mtu === null) {
                        return { ok: false, error: 'MTU in [Interface] must be a number from 576 to 9000.' };
                    }
                    iface.mtu = mtu;
                } else {
                    // Includes ListenPort: a fixed port would stop two VPNs running at once, and
                    // a random one works the same.
                    dropped.add(key);
                }
                continue;
            }
            if (name === 'publickey') {
                if (!isKey(value)) {
                    return { ok: false, error: 'A PublicKey in [Peer] is not a valid WireGuard key.' };
                }
                peer.publicKey = value;
            } else if (name === 'presharedkey') {
                if (!isKey(value)) {
                    return { ok: false, error: 'A PresharedKey in [Peer] is not a valid WireGuard key.' };
                }
                peer.presharedKey = value;
            } else if (name === 'endpoint') {
                const endpoint = parseEndpoint(value);
                if (!endpoint) {
                    return { ok: false, error: 'The Endpoint in [Peer] must be host:port.' };
                }
                peer.endpoint = endpoint;
            } else if (name === 'allowedips') {
                const items = splitList(value).map(parseCidr);
                if (items.some((item) => !item)) {
                    return { ok: false, error: 'An AllowedIPs entry in [Peer] is not an IP range.' };
                }
                for (const item of items) {
                    if (!peer.allowedIps.some((known) => cidrText(known) === cidrText(item))) {
                        peer.allowedIps.push(item);
                    }
                }
            } else if (name === 'persistentkeepalive') {
                const keepalive = value.toLowerCase() === 'off' ? 0 : intIn(value, 0, 65535);
                if (keepalive === null) {
                    return { ok: false, error: 'PersistentKeepalive in [Peer] must be a number of seconds.' };
                }
                peer.keepalive = keepalive;
            } else {
                dropped.add(key);
            }
        }
        if (peer) {
            peers.push(peer);
        }
    }

    if (interfaceCount !== 1) {
        return { ok: false, error: interfaceCount === 0 ? 'The config has no [Interface] section.' : 'The config has more than one [Interface] section.' };
    }
    if (!iface.privateKey) {
        return { ok: false, error: 'The [Interface] section has no PrivateKey.' };
    }
    if (iface.addresses.length === 0) {
        return { ok: false, error: 'The [Interface] section has no Address.' };
    }
    if (peers.length === 0) {
        return { ok: false, error: 'The config has no [Peer] section.' };
    }
    if (peers.length > MAX_PEERS) {
        return { ok: false, error: 'The config has too many [Peer] sections.' };
    }
    for (const peer of peers) {
        if (!peer.publicKey) {
            return { ok: false, error: 'A [Peer] section has no PublicKey.' };
        }
        if (!peer.endpoint) {
            return { ok: false, error: 'A [Peer] section has no Endpoint.' };
        }
        if (peer.allowedIps.length === 0) {
            return { ok: false, error: 'A [Peer] section has no AllowedIPs.' };
        }
    }
    if (iface.addresses.length > MAX_LIST || iface.dns.length > MAX_LIST || peers.some((peer) => peer.allowedIps.length > MAX_LIST)) {
        return { ok: false, error: 'The config lists too many addresses.' };
    }

    if (hooks.size) {
        warnings.push('The ' + [...hooks].join(', ') + ' commands were removed. The launcher never runs commands from a config.');
    }
    if (otherSections.size) {
        warnings.push('The ' + [...otherSections].join(', ') + ' section' + (otherSections.size > 1 ? 's were' : ' was') + ' removed.');
    }
    const ignorable = [...dropped].filter((key) => !SYSTEM_KEYS.includes(key.toLowerCase()) && key.toLowerCase() !== 'listenport');
    if (ignorable.length) {
        warnings.push('Unsupported settings were removed: ' + ignorable.join(', ') + '.');
    }

    const allAllowed = peers.flatMap((peer) => peer.allowedIps);
    if (iface.dns.length === 0) {
        if (FALLBACK_DNS.every((ip) => coversIpv4(allAllowed, ip))) {
            iface.dns = FALLBACK_DNS.slice();
            warnings.push('The config names no DNS server, so names are looked up through the VPN at ' + FALLBACK_DNS[0] + '.');
        } else {
            warnings.push('The config names no DNS server and does not route all traffic, so names are looked up on this PC\u2019s own network.');
        }
    } else if (!iface.dns.every((ip) => coversAddress(allAllowed, ip))) {
        warnings.push('A DNS server is outside the AllowedIPs ranges, so name lookups may fail.');
    }

    return { ok: true, config: { interface: iface, peers }, warnings };
}

// The cleaned WireGuard sections: what is stored, and what the helper's config starts with.
function toWireGuardText(config) {
    const iface = config.interface;
    const lines = ['[Interface]', 'PrivateKey = ' + iface.privateKey, 'Address = ' + iface.addresses.join(', ')];
    if (iface.dns.length) {
        lines.push('DNS = ' + iface.dns.join(', '));
    }
    if (iface.mtu) {
        lines.push('MTU = ' + iface.mtu);
    }
    for (const peer of config.peers) {
        lines.push('', '[Peer]', 'PublicKey = ' + peer.publicKey);
        if (peer.presharedKey) {
            lines.push('PresharedKey = ' + peer.presharedKey);
        }
        lines.push('Endpoint = ' + peer.endpoint.text, 'AllowedIPs = ' + peer.allowedIps.map(cidrText).join(', '));
        if (peer.keepalive) {
            lines.push('PersistentKeepalive = ' + peer.keepalive);
        }
    }
    return lines.join('\n') + '\n';
}

// The helper's config: the WireGuard sections plus one local SOCKS5 listener. The user name and
// password stop other programs on this PC from using the tunnel.
function buildHelperConfig(config, { port, username, password }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port for the VPN helper.');
    }
    if (!/^[A-Za-z0-9]{8,64}$/.test(username) || !/^[A-Za-z0-9]{8,64}$/.test(password)) {
        throw new Error('Invalid credentials for the VPN helper.');
    }
    return toWireGuardText(config) + '\n[Socks5]\nBindAddress = 127.0.0.1:' + port + '\nUsername = ' + username + '\nPassword = ' + password + '\n';
}

const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g;

// The name shown for a config: its file name without .conf.
function configName(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop().replace(/\.conf$/i, '');
    const clean = base.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, 60).join('') || 'WireGuard';
}

// What the UI may show about a config: never a key.
function describeConfig(config, fileName) {
    const first = config.peers[0];
    return { name: configName(fileName), endpoint: first.endpoint.text };
}

// Identifies a config without revealing it, so two clients with the same keys share one tunnel.
function configFingerprint(config) {
    return crypto.createHash('sha256').update(toWireGuardText(config)).digest('hex');
}

module.exports = {
    MAX_CONFIG_BYTES,
    FALLBACK_DNS,
    isKey,
    parseCidr,
    parseEndpoint,
    coversIpv4,
    parseWireGuardConfig,
    toWireGuardText,
    buildHelperConfig,
    configName,
    describeConfig,
    configFingerprint
};
