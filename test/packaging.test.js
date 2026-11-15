'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build;

// Changing any of these breaks upgrades in place, the update feed or the website's download links.
describe('package identity', () => {
    test('top-level fields', () => {
        expect(pkg.name).toBe('projectx-launcher');
        expect(pkg).not.toHaveProperty('productName');
        expect(pkg.author).toBe('Project X');
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
        const [major, minor, patch] = pkg.version.split('.').map(Number);
        expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThan(1 * 1e6 + 0 * 1e3 + 9);
        expect(fs.existsSync(path.join(ROOT, pkg.main))).toBe(true);
    });

    test('build identity', () => {
        expect(build.appId).toBe('com.projectx.launcher');
        expect(build.productName).toBe('Project X Launcher');
        expect(build.asar).toBe(true);
        expect(build.directories.buildResources).toBe('build');
        expect(build.artifactName).toBe('Project-X-Launcher-Setup-${version}.${ext}');
        expect(build.publish).toEqual({ provider: 'github', owner: 'iEasyScript', repo: 'xclient-launcher' });
    });

    test('Windows installer', () => {
        expect(build.win).toEqual({ target: 'nsis', icon: 'images/projectx_transparent.ico' });
        expect(build.nsis).toEqual({
            oneClick: false,
            allowToChangeInstallationDirectory: true,
            createDesktopShortcut: true,
            createStartMenuShortcut: true,
            shortcutName: 'Project X Launcher'
        });
        expect(build.nsis).not.toHaveProperty('guid');
        expect(build.nsis).not.toHaveProperty('perMachine');
    });

    test('macOS universal dmg and zip, unsigned', () => {
        expect(build.mac.category).toBe('public.app-category.utilities');
        expect(build.mac.icon).toBe('images/projectx_transparent.icns');
        expect(build.mac.target).toEqual([
            { target: 'dmg', arch: ['universal'] },
            { target: 'zip', arch: ['universal'] }
        ]);
        expect(build.mac).not.toHaveProperty('identity');
        expect(build.mac).not.toHaveProperty('notarize');
    });

    test('the DMG window holds the app, the Applications link and the installer readme', () => {
        expect(build.dmg).not.toHaveProperty('background');
        expect(build.dmg.title).toBe('${productName} Installer');
        expect(build.dmg.iconSize).toBe(108);
        const { width, height } = build.dmg.window;
        expect(build.dmg.contents).toHaveLength(3);
        for (const item of build.dmg.contents) {
            expect(item.x).toBeGreaterThan(0);
            expect(item.x).toBeLessThan(width);
            expect(item.y).toBeGreaterThan(0);
            expect(item.y).toBeLessThan(height);
        }
        expect(build.dmg.contents).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'link', path: '/Applications' }),
            expect.objectContaining({ type: 'file', path: 'build/READ THIS BEFORE INSTALL.html' })
        ]));
        expect(fs.existsSync(path.join(ROOT, 'build', 'READ THIS BEFORE INSTALL.html'))).toBe(true);
    });

    test('Linux builds the AppImage only', () => {
        expect(build.linux).toEqual({ target: ['AppImage'], icon: 'images/projectx_transparent.png', category: 'Game' });
    });

    test('packaged files include the app, the video and icons, and exclude maps and tests', () => {
        expect(build.files).toEqual(expect.arrayContaining(['package.json', 'src/**/*', 'assets/hero.mp4', 'images/projectx_transparent.png', '!**/*.map', '!test/**']));
        expect(build.files.some((pattern) => pattern === 'assets/**/*' || pattern === 'assets/*')).toBe(false);
        for (const icon of ['png', 'ico', 'icns']) {
            expect(fs.existsSync(path.join(ROOT, 'images', 'projectx_transparent.' + icon))).toBe(true);
        }
    });

    test('only the runtime dependencies the app uses ship', () => {
        expect(Object.keys(pkg.dependencies).sort()).toEqual(['detect-browsers', 'electron-log', 'electron-updater', 'patchright']);
        expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
    });
});

describe('repository hygiene', () => {
    function sourceFiles(dir) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? sourceFiles(full) : [full];
        });
    }

    test('the only GitHub repository the app names is its own release feed', () => {
        const own = build.publish.owner + '/' + build.publish.repo;
        for (const file of sourceFiles(path.join(ROOT, 'src'))) {
            const text = fs.readFileSync(file, 'utf8');
            for (const match of text.matchAll(/github\.com\/(?:repos\/)?([\w.-]+\/[\w.-]+)/g)) {
                expect(match[1]).toBe(own);
            }
            for (const match of text.matchAll(/(?:owner|GITHUB_OWNER)\b[^\n]*?'([\w.-]+)'[^\n]*?(?:repo|GITHUB_REPO)\b[^\n]*?'([\w.-]+)'/g)) {
                expect(match[1] + '/' + match[2]).toBe(own);
            }
        }
    });

    test('package-lock.json is committed, not ignored', () => {
        expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(true);
        expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).not.toMatch(/package-lock/);
    });
});
