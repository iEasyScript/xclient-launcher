'use strict';

const crypto = require('crypto');
const {
    parseWireGuardConfig,
    toWireGuardText,
    buildHelperConfig,
    describeConfig,
    configFingerprint,
    configName,
    parseEndpoint,
    coversIpv4,
    parseCidr,
    isKey,
    FALLBACK_DNS
} = require('../src/main/wireguard');
const { scrub } = require('../src/main/redact');
const { createTail } = require('../src/main/vpn');

const key = () => crypto.randomBytes(32).toString('base64');
const PRIV = key();
const PUB = key();
const PSK = key();

function providerConfig(extra = '') {
    return [
        '\uFEFF# Exported by a VPN provider',
        '[Interface]',
        'PrivateKey = ' + PRIV,
        'Address = 10.66.0.2/32, fd00::2/128',
        'DNS = 10.64.0.1, corp.example',
        'MTU = 1380',
        'ListenPort = 51820',
        'PostUp = iptables -A FORWARD -j ACCEPT',
        'PreDown = rm -rf /',
        'Table = off',
        '',
        '[Peer]',
        'PublicKey = ' + PUB,
        'PresharedKey = ' + PSK,
        'Endpoint = se-1.example.net:51820',
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'PersistentKeepalive = 25',
        extra
    ].join('\r\n');
}

function minimal({ iface = [], peer = [], dns = 'DNS = 10.64.0.1' } = {}) {
    return ['[Interface]', 'PrivateKey = ' + PRIV, 'Address = 10.66.0.2/32', dns, ...iface, '[Peer]', 'PublicKey = ' + PUB,
        'Endpoint = 198.51.100.4:51820', 'AllowedIPs = 0.0.0.0/0', ...peer].join('\n');
}

describe('parsing a provider config', () => {
    test('keeps what the helper uses and strips the rest, with warnings', () => {
        const result = parseWireGuardConfig(providerConfig('[Socks5]\r\nBindAddress = 0.0.0.0:1080'));
        expect(result.ok).toBe(true);
        expect(result.config.interface).toEqual({
            privateKey: PRIV,
            addresses: ['10.66.0.2/32', 'fd00::2/128'],
            dns: ['10.64.0.1'],
            mtu: 1380
        });
        expect(result.config.peers).toHaveLength(1);
        const peer = result.config.peers[0];
        expect(peer.publicKey).toBe(PUB);
        expect(peer.presharedKey).toBe(PSK);
        expect(peer.endpoint).toMatchObject({ host: 'se-1.example.net', port: 51820, text: 'se-1.example.net:51820' });
        expect(peer.keepalive).toBe(25);
        const warnings = result.warnings.join('\n');
        expect(warnings).toContain('PostUp, PreDown commands were removed');
        expect(warnings).toContain('never runs commands');
        expect(warnings).toContain('DNS search domains');
        expect(warnings).toContain('[Socks5] section was removed');
        // wg-quick's own settings are dropped quietly.
        expect(warnings).not.toMatch(/ListenPort|Table/);
    });

    test('the cleaned text never carries hooks, wg-quick settings or other sections', () => {
        const text = toWireGuardText(parseWireGuardConfig(providerConfig('[TCPServerTunnel]\nListenPort = 22\nTarget = 127.0.0.1:22')).config);
        expect(text).not.toMatch(/PostUp|PreDown|iptables|rm -rf|Table|ListenPort|TCPServerTunnel|Socks5|corp\.example/);
        expect(text).toBe([
            '[Interface]',
            'PrivateKey = ' + PRIV,
            'Address = 10.66.0.2/32, fd00::2/128',
            'DNS = 10.64.0.1',
            'MTU = 1380',
            '',
            '[Peer]',
            'PublicKey = ' + PUB,
            'PresharedKey = ' + PSK,
            'Endpoint = se-1.example.net:51820',
            'AllowedIPs = 0.0.0.0/0, ::/0',
            'PersistentKeepalive = 25'
        ].join('\n') + '\n');
        // Cleaning is stable: the stored text parses back to the same thing.
        expect(toWireGuardText(parseWireGuardConfig(text).config)).toBe(text);
    });

    test('keys are case-insensitive, repeated lists combine and plain IPs become ranges', () => {
        const text = ['[interface]', 'privatekey=' + PRIV, 'address = 10.0.0.2', 'Address = 10.0.0.3/32  # second', 'dns = 9.9.9.9',
            '[PEER]', 'publickey = ' + PUB, 'endpoint = [2001:db8::1]:51820', 'allowedips = 10.0.0.1', 'AllowedIPs = 10.0.0.0/24',
            'PersistentKeepalive = off'].join('\n');
        const result = parseWireGuardConfig(text);
        expect(result.ok).toBe(true);
        expect(result.config.interface.addresses).toEqual(['10.0.0.2/32', '10.0.0.3/32']);
        expect(result.config.peers[0].endpoint.text).toBe('[2001:db8::1]:51820');
        expect(result.config.peers[0].allowedIps.map((c) => c.ip + '/' + c.prefix)).toEqual(['10.0.0.1/32', '10.0.0.0/24']);
        expect(result.config.peers[0].keepalive).toBe(0);
    });

    test('several peers are kept', () => {
        const text = minimal() + '\n[Peer]\nPublicKey = ' + key() + '\nEndpoint = 198.51.100.5:51820\nAllowedIPs = 10.9.0.0/16\n';
        const result = parseWireGuardConfig(text);
        expect(result.ok).toBe(true);
        expect(result.config.peers).toHaveLength(2);
    });

    test('unknown settings are removed and listed', () => {
        const result = parseWireGuardConfig(minimal({ iface: ['Mystery = 1'], peer: ['Weird = 2'] }));
        expect(result.ok).toBe(true);
        expect(result.warnings.join('\n')).toContain('Unsupported settings were removed: Mystery, Weird.');
        expect(toWireGuardText(result.config)).not.toMatch(/Mystery|Weird/);
    });

    test('settings before any section are removed', () => {
        const result = parseWireGuardConfig('WGConfig = /etc/other.conf\n' + minimal());
        expect(result.ok).toBe(true);
        expect(result.warnings.join('\n')).toContain('outside [Interface] and [Peer]');
        expect(toWireGuardText(result.config)).not.toContain('WGConfig');
    });
});

describe('rejecting configs', () => {
    test.each([
        ['', 'empty'],
        ['   \n  ', 'empty'],
        ['hello world', 'not a setting'],
        ['[Peer]\nPublicKey = ' + PUB + '\nEndpoint = h:1\nAllowedIPs = 0.0.0.0/0', 'no [Interface]'],
        [minimal() + '\n[Interface]\nPrivateKey = ' + PRIV, 'more than one [Interface]'],
        [minimal().replace('PrivateKey = ' + PRIV, ''), 'no PrivateKey'],
        [minimal().replace(PRIV, 'not-a-key'), 'PrivateKey in [Interface] is not a valid'],
        [minimal().replace(PRIV, Buffer.alloc(16).toString('base64')), 'PrivateKey in [Interface] is not a valid'],
        [minimal().replace('Address = 10.66.0.2/32', ''), 'no Address'],
        [minimal().replace('Address = 10.66.0.2/32', 'Address = ten.zero'), 'not an IP address'],
        [minimal().replace('Address = 10.66.0.2/32', 'Address = 10.0.0.2/33'), 'not an IP address'],
        [minimal().split('[Peer]')[0], 'no [Peer]'],
        [minimal().replace('PublicKey = ' + PUB, ''), 'no PublicKey'],
        [minimal().replace('Endpoint = 198.51.100.4:51820', ''), 'no Endpoint'],
        [minimal().replace('198.51.100.4:51820', '198.51.100.4'), 'host:port'],
        [minimal().replace('198.51.100.4:51820', 'bad host!:51820'), 'host:port'],
        [minimal().replace('198.51.100.4:51820', 'host:70000'), 'host:port'],
        [minimal().replace('AllowedIPs = 0.0.0.0/0', ''), 'no AllowedIPs'],
        [minimal().replace('AllowedIPs = 0.0.0.0/0', 'AllowedIPs = everything'), 'not an IP range'],
        [minimal({ iface: ['MTU = 99'] }), 'MTU'],
        [minimal({ peer: ['PersistentKeepalive = soon'] }), 'PersistentKeepalive'],
        [minimal({ peer: ['PresharedKey = short'] }), 'PresharedKey'],
        [minimal().replace(PRIV, '$WG_PRIVATE_KEY'), 'not refer to a variable'],
        [minimal({ peer: ['Endpoint = $HOME'] }), 'not refer to a variable'],
        ['[Interface]\0', 'not a text file'],
        ['#'.repeat(70 * 1024), 'too big']
    ])('%#: %s', (text, message) => {
        const result = parseWireGuardConfig(text);
        expect(result.ok).toBe(false);
        expect(result.error).toContain(message);
    });

    test('a non-string is refused', () => {
        expect(parseWireGuardConfig(null).ok).toBe(false);
    });
});

describe('DNS through the tunnel', () => {
    test('a config without DNS that routes everything gets the fallback servers', () => {
        const result = parseWireGuardConfig(minimal({ dns: '' }));
        expect(result.config.interface.dns).toEqual(FALLBACK_DNS);
        expect(result.warnings.join('\n')).toContain('looked up through the VPN at 1.1.1.1');
        expect(toWireGuardText(result.config)).toContain('DNS = 1.1.1.1, 1.0.0.1');
    });

    test('a split-tunnel config without DNS warns that lookups stay local', () => {
        const result = parseWireGuardConfig(minimal({ dns: '' }).replace('AllowedIPs = 0.0.0.0/0', 'AllowedIPs = 10.0.0.0/8'));
        expect(result.config.interface.dns).toEqual([]);
        expect(result.warnings.join('\n')).toContain('own network');
    });

    test('a DNS server outside AllowedIPs is flagged', () => {
        const result = parseWireGuardConfig(minimal({ dns: 'DNS = 192.168.1.1' }).replace('AllowedIPs = 0.0.0.0/0', 'AllowedIPs = 10.0.0.0/8'));
        expect(result.ok).toBe(true);
        expect(result.warnings.join('\n')).toContain('outside the AllowedIPs');
    });

    test('range checks', () => {
        const ranges = ['10.0.0.0/8', '1.1.1.0/24'].map(parseCidr);
        expect(coversIpv4(ranges, '10.200.3.4')).toBe(true);
        expect(coversIpv4(ranges, '1.1.1.1')).toBe(true);
        expect(coversIpv4(ranges, '1.0.0.1')).toBe(false);
        expect(coversIpv4([parseCidr('0.0.0.0/0')], '203.0.113.9')).toBe(true);
    });
});

describe('the helper config', () => {
    const config = parseWireGuardConfig(providerConfig()).config;

    test('is the cleaned WireGuard sections plus one local SOCKS5 listener with a login', () => {
        const text = buildHelperConfig(config, { port: 41000, username: 'abcdef0123456789', password: '0123456789abcdef0123456789abcdef' });
        expect(text.startsWith(toWireGuardText(config))).toBe(true);
        expect(text.endsWith('\n[Socks5]\nBindAddress = 127.0.0.1:41000\nUsername = abcdef0123456789\nPassword = 0123456789abcdef0123456789abcdef\n')).toBe(true);
        expect(text.match(/\[Socks5\]/g)).toHaveLength(1);
        expect(text).not.toMatch(/PostUp|PreDown|ListenPort|0\.0\.0\.0:1080|\[http\]|WGConfig/i);
    });

    test('refuses a bad port or login', () => {
        expect(() => buildHelperConfig(config, { port: 0, username: 'abcdefgh', password: 'abcdefgh' })).toThrow('port');
        expect(() => buildHelperConfig(config, { port: 70000, username: 'abcdefgh', password: 'abcdefgh' })).toThrow('port');
        expect(() => buildHelperConfig(config, { port: 4000, username: 'a b', password: 'abcdefgh' })).toThrow('credentials');
        expect(() => buildHelperConfig(config, { port: 4000, username: 'abcdefgh', password: 'x\nUsername = y' })).toThrow('credentials');
    });
});

describe('what the UI sees', () => {
    test('the file name and the first endpoint, never a key', () => {
        const config = parseWireGuardConfig(providerConfig()).config;
        const shown = describeConfig(config, 'C:\\Users\\Ana\\Downloads\\se-sto-wg-001.conf');
        expect(shown).toEqual({ name: 'se-sto-wg-001', endpoint: 'se-1.example.net:51820' });
        expect(JSON.stringify(shown)).not.toContain(PRIV);
        expect(configName('/home/ana/My VPN.CONF')).toBe('My VPN');
        expect(configName('')).toBe('WireGuard');
    });

    test('fingerprints match for the same keys and differ otherwise', () => {
        const a = parseWireGuardConfig(minimal()).config;
        const b = parseWireGuardConfig(minimal() + '\n# a comment').config;
        const c = parseWireGuardConfig(minimal().replace(PRIV, key())).config;
        expect(configFingerprint(a)).toBe(configFingerprint(b));
        expect(configFingerprint(a)).not.toBe(configFingerprint(c));
        expect(configFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
    });

    test('helpers', () => {
        expect(isKey(PRIV)).toBe(true);
        expect(isKey('x'.repeat(44))).toBe(false);
        expect(parseEndpoint('vpn.example:51820')).toMatchObject({ host: 'vpn.example', port: 51820 });
        expect(parseEndpoint('[::1]:5')).toMatchObject({ host: '::1', text: '[::1]:5' });
        expect(parseEndpoint('[not-v6]:5')).toBeNull();
        expect(parseEndpoint('1.2.3.4:0')).toBeNull();
    });
});

describe('redaction', () => {
    test('a config pasted into the log loses every key', () => {
        const text = scrub(providerConfig());
        for (const secret of [PRIV, PUB, PSK]) {
            expect(text).not.toContain(secret);
        }
        expect(text).toContain('PrivateKey = ***');
        expect(text).toContain('PresharedKey = ***');
        expect(text).toContain('Endpoint = se-1.example.net:51820');
    });

    test('bare keys and the helper login are scrubbed, other text is left alone', () => {
        expect(scrub('invalid base64 string: ' + PRIV)).toBe('invalid base64 string: ***');
        expect(scrub('key should be 32 bytes: "' + PSK + '"')).toBe('key should be 32 bytes: "***"');
        expect(scrub('Username = abcdef0123456789 Password = secretsecret')).toBe('Username = *** Password = ***');
        expect(scrub('-proxy=socks5://abcdef01:23456789@127.0.0.1:41000')).toBe('-proxy=socks5://***:***@127.0.0.1:41000');
        expect(scrub('Handshake for peer 1 did not complete after 5 seconds')).toBe('Handshake for peer 1 did not complete after 5 seconds');
        expect(scrub('sha256 ' + 'a'.repeat(64))).toBe('sha256 ' + 'a'.repeat(64));
    });

    test('the helper output kept for error messages is scrubbed and bounded', () => {
        const tail = createTail(3);
        tail.push('line one\nPrivateKey = ' + PRIV + '\n');
        tail.push('two\nthree\nfour\npart');
        tail.push('ial ' + PSK);
        const text = tail.text();
        expect(text).not.toContain(PRIV);
        expect(text).not.toContain(PSK);
        expect(text.split('\n')).toEqual(['two', 'three', 'four', 'partial ***']);
    });
});
