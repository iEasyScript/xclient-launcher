# Working on the launcher

An Electron app (Electron 33, plain JavaScript, no framework or bundler). Packaged with
electron-builder; tested with Jest.

## Layout

```
src/main/           main process: files, network, processes, dialogs, updater
  index.js          entry point: logging, single-instance lock, wiring, window
  window.js         BrowserWindow with hardening (sandbox, no node, navigation blocked)
  ipc.js            channel names and the argument check for every handler
  validate.js       argument rules used by ipc.js
  operations.js     what each channel does, composed from the services below
  account.js        Project X session file, /me refresh, device pairing
  settings.js       resource_versions.json (per-key writes, ownership rule, corrupt-file backup)
  nicknames.js      nickname and accounts-panel settings
  client-*.js       client version lookup, download (checksum, temp file, pruning), update check
  launch.js         JVM arguments, proxy, credentials.properties, Java check, spawning
  jagex/            Jagex OAuth helpers, saved accounts, the browser sign-in flow
  hiscores*.js      hiscores parsing and the rate-limited, cached lookup queue
  updater.js        electron-updater wiring (xclient.dev feed, GitHub fallback)
  launcher-version.js  latest launcher version lookup
src/preload/        the only bridge: named functions on window.launcher
src/shared/         plain scripts loaded by both the renderer and the tests
src/renderer/       index.html, styles.css and js/ (one file per UI area, app.js wires them)
build/              electron-builder resources (the macOS installer page); not output
test/               Jest suites; helpers.js has fake fetch, temp folders and a recording logger
```

## Rules that matter

- The renderer never gets Node, Jagex session ids or the Project X token. Add a feature by adding
  a named function in `preload.js`, a channel and argument check in `ipc.js` (the bridge test
  keeps the two in step) and an operation in `operations.js`.
- Never log tokens, device codes, Jagex codes, id tokens, session ids or proxy credentials.
  `redact.js` scrubs the log as a safety net; do not rely on it.
- File formats under `~/.projectx`, `~/.runelite` and the user-data folder are shared with
  existing installs and the client. Keep keys and layouts as they are and keep unknown keys.
- Keep the `package.json` identity (`name`, `build.appId`, `productName`, `artifactName`,
  `publish`) unchanged; `test/packaging.test.js` guards it.
- Code style: 4 spaces, single quotes, semicolons, no trailing commas (see `.prettierrc`).
- Write `\u` escapes rather than literal non-ASCII characters in JavaScript files.
