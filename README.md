# Project X Launcher

The desktop launcher for the Project X client for Old School RuneScape. It runs on Windows, macOS
and Linux.

**Download it from [xclient.dev](https://xclient.dev).**

## What it does

- **Signs you in to Project X.** Click "Sign in with Discord", check the short code in your
  browser and approve it on xclient.dev. The launcher never sees your password.
- **Keeps the client up to date.** It asks xclient.dev which client version is current, downloads
  it with a progress bar, checks it against the published SHA-256 checksum and tidies away older
  versions.
- **Manages your Jagex accounts.** Sign in on Jagex's own pages in a browser window the launcher
  opens for you (any installed Chromium-based browser: Chrome, Edge, Brave and so on). Your
  characters are saved so you can pick one and play. You can give them nicknames, refresh their
  names after a rename, or remove them.
- **Launches the client** for one character, several characters one after another, or a normal
  username-and-password account, with your chosen memory, profile and optional SOCKS proxy.
- **Gives each launch preset its own connection**: direct, a SOCKS proxy, or a VPN from a WireGuard
  config file. See [Per-preset VPN](#per-preset-vpn).
- **Shows your levels** from the public OSRS hiscores in a small panel over the video.
- **Updates itself.** Windows and Linux install updates in place; on macOS it takes you to the
  download page.

There is no telemetry. The launcher only talks to xclient.dev, Jagex's sign-in and game-session
services, the OSRS hiscores, and GitHub as a fallback for launcher updates. A VPN preset's helper
talks only to the VPN server in its config, and **Test connection** makes one request through the
VPN to Cloudflare's trace page (or api.ipify.org if that fails) to show the address sites see.

## Per-preset VPN

A launch preset's **Connection** can be **Direct**, **Proxy** or **VPN (WireGuard)**. Direct means
the preset has no connection of its own, so the proxy in Settings applies if you set one. Presets
made before 3.4.0 open as Proxy if they had a proxy and Direct otherwise.

For a VPN, click **Import WireGuard config** and pick the `.conf` file from your VPN provider. The
editor shows the file's name and the server it connects to, never the keys. **Test connection**
starts the VPN, shows the address and country sites see, and stops it again.

When a client with a VPN preset starts, the launcher runs a bundled helper,
[wireproxy](https://github.com/pufferffish/wireproxy), for that config. It runs WireGuard inside
its own process and offers it to the client as a SOCKS5 proxy on `127.0.0.1`, with a random user
name and password, and the client is started with `-proxy=socks5://...` exactly as for a proxy
preset. Nothing is installed, no system setting changes and no admin rights are needed, so presets
can use different VPN servers or accounts at the same time. Clients whose presets use the same
config share one helper, because a WireGuard server allows one connection per key.

- **Lifetime.** The helper stops when the last client using it exits. If it stops by itself, the
  clients using it are closed and you are told which VPN disconnected; a client is pinned to the
  dead local proxy and never falls back to your own connection. Closing the launcher stops every
  helper, so it asks first and then closes those clients too.
- **What is accepted.** One `[Interface]` with `PrivateKey` and `Address`, and at least one
  `[Peer]` with `PublicKey`, `Endpoint` and `AllowedIPs`. `DNS`, `MTU`, `PresharedKey` and
  `PersistentKeepalive` are kept. `PostUp`, `PostDown`, `PreUp` and `PreDown` are removed and
  never run, and so is anything else the helper does not use (`ListenPort`, `Table`, `SaveConfig`,
  other sections). Values that start with `# Project X Launcher

The desktop launcher for the Project X client for Old School RuneScape. It runs on Windows, macOS
and Linux.

**Download it from [xclient.dev](https://xclient.dev).**

## What it does

- **Signs you in to Project X.** Click "Sign in with Discord", check the short code in your
  browser and approve it on xclient.dev. The launcher never sees your password.
- **Keeps the client up to date.** It asks xclient.dev which client version is current, downloads
  it with a progress bar, checks it against the published SHA-256 checksum and tidies away older
  versions.
- **Manages your Jagex accounts.** Sign in on Jagex's own pages in a browser window the launcher
  opens for you (any installed Chromium-based browser: Chrome, Edge, Brave and so on). Your
  characters are saved so you can pick one and play. You can give them nicknames, refresh their
  names after a rename, or remove them.
- **Launches the client** for one character, several characters one after another, or a normal
  username-and-password account, with your chosen memory, profile and optional SOCKS proxy.
- **Gives each launch preset its own connection**: direct, a SOCKS proxy, or a VPN from a WireGuard
  config file. See [Per-preset VPN](#per-preset-vpn).
- **Shows your levels** from the public OSRS hiscores in a small panel over the video.
- **Updates itself.** Windows and Linux install updates in place; on macOS it takes you to the
  download page.

 are refused. The editor lists what was removed.
- **DNS.** Names are looked up through the VPN using the config's `DNS` servers. A config without
  one gets `1.1.1.1` when it routes all traffic; otherwise the editor warns that lookups use this
  PC's own network.
- **Storage.** The cleaned config is saved in the user-data folder under `vpn/`, one file per
  config, encrypted with the system key store (Electron `safeStorage`: DPAPI on Windows, the
  Keychain on macOS, the Secret Service or KWallet on Linux). Where there is no key store (some
  Linux desktops), it is saved unencrypted, readable only by your user, and the editor says so.
  Presets only refer to the config by id with its name and server, so the presets file never holds
  a key. Configs no preset uses are deleted.
- **While running.** The helper gets a copy of the config, written owner-only to `vpn-run/` in the
  user-data folder and deleted as soon as the helper has read it. The log never contains a config
  or key.
- **Coverage.** The client's `-proxy` option sets the JVM-wide SOCKS proxy, which carries the
  game connection and the client's web requests, with host names resolved at the far end. A few
  things do not go through it: the World Hopper's ping (ICMP) to game worlds, the local lookup of a
  world's host name by the game, and plugins that use Java's newer `HttpClient` (it does not
  support SOCKS) or open their own direct connections.

## Getting started

You'll need [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm run dev
```

VPN presets need the helper binary. `npm run fetch-helper` downloads the pinned wireproxy release for
your platform into `vendor/` (not committed) and checks it against the SHA-256 in
`scripts/wireproxy.json`; `npm run fetch-helper -- --target all` fetches every platform's. Without
it, launching a VPN preset shows an error saying the helper is missing.

`npm run dev` starts the launcher with `DEBUG=true`: a normal window frame and menu bar, a slightly
taller window, no self-update check, and the client's output copied into the launcher log.
`npm start` runs it as users see it.

The launcher needs Java to start the client. If it can't find `java` on your `PATH` it offers to
open the Temurin JDK 17 download page.

### Settings for development

| Setting | What it does |
|---|---|
| `PROJECTX_CLIENT_VERSION` | Use this client version (for example `1.2.3-dev`) without asking the site, and never delete old client jars. Handy for testing a local client build: put it in `~/.projectx/projectx-<version>.jar`. |
| `PROJECTX_SITE_URL` | Talk to a different Project X site (sign-in, client version and client download), for example `http://localhost:3000`. Trailing slashes are ignored. |
| `DEBUG` | `true` gives the framed development window and skips the update check. Any value copies the client's output into the launcher log. |
| `--ram <size>` | Launcher argument giving the client heap to use when no valid preference is saved, for example `--ram 2g`. |

### Where things live

- `~/.projectx/` holds the client jars, saved Jagex accounts (`accounts.json`), launcher settings
  (`resource_versions.json`) and the hiscores cache. The client keeps its own files here too.
- The Project X sign-in is stored in the app's user-data folder (`projectx-session.json`), as are
  launch presets (`launch-presets.json`) and saved WireGuard configs (`vpn/`). The
  log is `logs/main.log` there (macOS: `~/Library/Logs/projectx-launcher/main.log`). The menu's
  **Open** items take you to these.

## Tests

```sh
npm test
npm run test:coverage
```

The Jest suite runs in plain Node with the network, Electron and the file system faked or pointed
at temporary folders, so it never signs in or launches anything.

## Building installers

```sh
npm run win     # NSIS installer
npm run mac     # universal DMG and zip (needs macOS)
npm run linux   # AppImage
```

Run `npm run fetch-helper` first so the VPN helper is packaged; the release workflow does this
and checks the helper is in each build. Output goes to `dist/`. These commands never publish
anything. `npm run release` publishes to the
GitHub release for the current version and needs a `GH_TOKEN`; the usual route is the release
workflow below.

The `build/` folder is electron-builder's resources folder, not build output. It holds
`READ THIS BEFORE INSTALL.html`, the page shown in the macOS DMG.

## Releasing

1. Bump `version` in `package.json` (a minor change goes from 2.0.0 to 2.1.0, a major update to
   the next whole number; always three parts) and commit.
2. Wait for CI to pass.
3. Push a tag `v<version>`, for example `git tag v2.1.0 && git push origin v2.1.0`.

The release workflow checks the tag matches `package.json`, runs the tests, builds Windows, macOS
and Linux in parallel, and publishes one GitHub release with the installers and the
`latest*.yml` files the auto-updater reads.

## Help

Join us on [Discord](https://discord.gg/UUwfkXFcub) or visit [xclient.dev](https://xclient.dev).

Project X is not affiliated with or endorsed by Jagex Ltd. Old School RuneScape is a trademark of
Jagex Ltd.

## Third-party software

The installers include [wireproxy](https://github.com/pufferffish/wireproxy) 1.1.3, unmodified,
under the ISC licence. Its licence text ships in the app's resources as
`licenses/wireproxy.txt` (from `resources/licenses/` in this repository). The pinned release
files and their SHA-256 checksums are in `scripts/wireproxy.json`.

## Licence

The source is public so you can read it and build it for your own use. All other rights are
reserved: see [LICENSE](LICENSE).
