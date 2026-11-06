# HttpDesk

A Postman-style desktop HTTP client whose requests live in plain, portable
**`.http` files** (JetBrains HTTP Client / VS Code REST Client format).

- Point it at any folder; your `.http` files *are* the collection. No import, no database.
- Edit requests graphically: method, URL, params, headers, auth, body, settings.
- **Enable/disable any component** (individual params and headers, or whole
  sections: auth, body). Disabled parts stay in the file as comments, so other
  tools ignore them and HttpDesk restores them exactly.
- Generate requests from **OpenAPI 3.0/3.1** (JSON/YAML, file or URL).
- Environments via `http-client.env.json`; secrets go to
  `http-client.private.env.json`, which is git-ignored automatically.
- Requests run in Rust (reqwest), never on the UI thread.

Built with Tauri 2, Rust and Svelte 5. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design: parsing strategy, data model, disabled-component encoding,
OpenAPI mapping, sync, and known limitations.

## Install

Download the installer for your platform from the
[latest release](https://github.com/jrmitch120/http-desk/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `HttpDesk_<version>_aarch64.dmg` |
| macOS (Intel) | `HttpDesk_<version>_x64.dmg` |
| Windows | `HttpDesk_<version>_x64-setup.exe` or `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

The installers aren't code-signed yet, so Windows and macOS warn you the first
time you open the app. Updates installed from inside the app don't show the warning.

**Windows:** if you see *"Windows protected your PC"*, click **More info**, then
**Run anyway**.

**macOS:** drag HttpDesk to Applications and open it. If macOS says Apple
*"could not verify"* the app, open **System Settings → Privacy & Security**,
scroll down, and click **Open Anyway**. If it says the app *"is damaged and
can't be opened"*, that's the same check: run this once, then open it again:

```sh
xattr -dr com.apple.quarantine /Applications/HttpDesk.app
```

## What a saved request looks like

```http
### List pets
# Returns all pets, optionally filtered.
# @param limit: Max results. Default: 20.
GET {{baseUrl}}/pets?limit=20
#~ &status=sold
Authorization: Bearer {{token}}
Accept: application/json
#~ X-Debug: true
```

`#~` marks something you switched off in HttpDesk. `# @param` / `# @header` lines
hold the descriptions shown under each param and header (click one to edit it;
the OpenAPI importer can fill them in). JetBrains and VS Code ignore both.
Requests you don't edit are saved byte-for-byte as they were.

## Using it

| Action | How |
|---|---|
| Open a workspace | Welcome screen → *Open folder…* (the last workspace reopens on start) |
| New file / folder / request | Explorer toolbar, right-click menus, or `+` next to a file |
| Send | **Send** button, `Enter` in the URL bar, or `⌘/Ctrl Enter` |
| Save / save all | `⌘/Ctrl S` / `⌘/Ctrl ⇧ S` |
| Search requests | `⌘/Ctrl P` |
| Environments | Top-right selector; `⌘/Ctrl E` to edit |
| Import OpenAPI | Top bar → *Import OpenAPI* |
| See the `.http` text | `.http` button above the URL bar |
| Move files | Drag and drop in the explorer |

If a file changes on disk, HttpDesk reloads it. If you have unsaved edits to that
file, it asks whether to reload or keep your version.

Try it with `examples/demo`, which includes `httpbin.org` requests. To try the
importer, use `examples/petstore-openapi.yaml`.

## Development

Prerequisites: Rust (stable), Node 20+, pnpm, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) (on Linux:
`libwebkit2gtk-4.1-dev librsvg2-dev patchelf`).

```sh
pnpm install
pnpm tauri dev          # run the app
pnpm tauri build        # native bundles (.dmg/.app, .msi/.exe, .deb/.rpm/.AppImage)
```

Tests:

```sh
cargo test --workspace  # parser/serializer, enablement, execution, env, OpenAPI, IPC + watcher
pnpm test               # frontend helpers (URL⇄params sync, form/multipart editors, …)
pnpm check              # svelte-check / TypeScript
pnpm test:e2e           # browser tests (Playwright, headless Chromium)
```

The browser tests in `e2e/` drive the real UI in headless Chromium against the
mocked backend described below. Playwright starts the Vite dev server itself
(on port 1430, or `E2E_PORT`), so nothing else needs to be running. Install the
browser once with `pnpm exec playwright install chromium`. Use
`pnpm test:e2e --headed` or `--ui` to watch them, and
`pnpm exec playwright show-trace test-results/…/trace.zip` after a failure.

UI-only work: `pnpm dev` and open <http://localhost:1420>. Outside Tauri the app
runs against a mocked backend (`src/dev/mock.ts`, never shipped in production
builds). Its fixtures are real parser output, regenerated with
`cargo run -p httpdesk-core --example dump -- file.http`.

### Layout

```
crates/httpdesk-core/   all domain logic (no Tauri): model, parser, serializer,
                        vars, env, exec, openapi, workspace — and their tests
src-tauri/              thin command layer, file watcher, IPC tests
src/                    Svelte 5 UI (lib/ = store, API, helpers; components/)
docs/ARCHITECTURE.md    design and decisions
```

### Releases

1. Bump `version` in `package.json` and `src-tauri/tauri.conf.json`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds installers for all three platforms and
   attaches them to a **draft** GitHub release. Publish the draft to ship it.

Installed apps check `releases/latest/download/latest.json` on startup (and from
Settings → Updates) and offer to install newer versions. Updates are signed with
a minisign key: the public half is in `tauri.conf.json`; the private key and its
password are the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. If that key is lost,
existing installs can no longer verify updates, so keep a backup.

Updater bundles are only produced with `--config src-tauri/tauri.updater.conf.json`
(the release workflow passes it), so local `pnpm tauri build` needs no key.
Windows code signing and macOS notarization are not configured yet. See
[Install](#install) for what users see.

## License

[MIT](LICENSE)
