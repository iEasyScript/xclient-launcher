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
- **Shows your levels** from the public OSRS hiscores in a small panel over the video.
- **Updates itself.** Windows and Linux install updates in place; on macOS it takes you to the
  download page.

There is no telemetry. The launcher only talks to xclient.dev, Jagex's sign-in and game-session
services, the OSRS hiscores, and GitHub as a fallback for launcher updates.

## Getting started

You'll need [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm run dev
```

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
- The Project X sign-in is stored in the app's user-data folder (`projectx-session.json`), and the
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

Output goes to `dist/`. These commands never publish anything. `npm run release` publishes to the
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

## Licence

The source is public so you can read it and build it for your own use. All other rights are
reserved: see [LICENSE](LICENSE).
