# HttpDesk — Technical Architecture

This document covers the stack evaluation, the `.http` format strategy, the internal
model, disabled-component persistence, OpenAPI generation, filesystem sync, risks, and
the phased plan. It is the reference for decisions made in the code; when the code
and this document disagree, fix one of them.

---

## 1. Stack evaluation (Svelte 5 + Rust + Tauri 2)

| Concern | Assessment |
|---|---|
| **Tauri 2** | Good fit. Single binary per OS, uses the OS webview (WebView2 / WKWebView / WebKitGTK), so bundles are ~10 MB instead of Electron's ~150 MB. Commands are `async` Rust functions on a Tokio runtime, so HTTP execution, parsing and file IO never block the UI thread. The capability system limits what the webview can do. |
| **Rust core** | `.http` parsing, serialization, variable resolution, execution and OpenAPI generation all live in a plain library crate (`crates/httpdesk-core`) with **no Tauri dependency**. It can be tested with `cargo test` and no window, and could later be reused by a CLI. |
| **reqwest** | Chosen. Mature, async, supports rustls (no OpenSSL dependency, so cross-compiling is easy), custom methods, redirect policies, timeouts, custom root CAs, client identities (mTLS), and accepting invalid certificates. A new `Client` is built per execution because TLS and redirect settings can differ per request or environment. Building one costs microseconds next to the request itself. |
| **Svelte 5** | Runes (`$state`, `$derived`) handle the deeply nested request model without a separate store library. It compiles to small, fast bundles. Plain Vite SPA, without SvelteKit (no routing or SSR needed). |
| **CodeMirror 6** | Used for the body editor, the response viewer (syntax highlighting, folding, **search**, virtualized rendering of large responses) and the single-line URL editor (`{{variable}}` highlighting and autocompletion). |
| **Webview differences** | The main cross-platform risk. WebKitGTK on Linux lags Chromium. We stick to well-supported CSS (flex/grid, custom properties) and avoid bleeding-edge APIs. |

Rejected alternatives: Electron (size, needs a Node backend), a sidecar HTTP service
(the requirements forbid a separately managed backend), and SvelteKit (unnecessary).

### Layout

```
crates/httpdesk-core/   pure Rust library — all domain logic + tests
  model.rs              request/file model (serde, shared with the frontend as JSON)
  parser.rs             .http text → HttpFile
  serializer.rs         HttpFile → .http text (lossless for untouched requests)
  env.rs                http-client.env.json / http-client.private.env.json
  vars.rs               {{variable}} + dynamic variable resolution
  exec.rs               request execution via reqwest
  openapi/              OpenAPI 3.0/3.1 loading, validation, generation
  workspace.rs          tree listing, search
src-tauri/              thin Tauri shell: commands, app state, file watcher
src/                    Svelte 5 frontend
```

---

## 2. `.http` parsing and serialization strategy

No existing Rust crate parses `.http` files and also round-trips them faithfully, so we
use a **hand-written, line-oriented parser**. The format is line-based and simple; a
parser-combinator or grammar library would add complexity without much benefit.

### Grammar handled (union of JetBrains HTTP Client and VS Code REST Client)

```
file          := block ( SEPARATOR block )*
SEPARATOR     := line starting with "###"  (text after it = request name, JetBrains style)
block         := preamble request-line query-cont* header-line* [ blank body ] [ handler ]
preamble      := ( blank | comment | directive | file-variable | pre-script )*
comment       := ("#" | "//") text
directive     := ("#" | "//") "@" key [ value ]       e.g. # @name, # @no-redirect, # @timeout 30
file-variable := "@" name "=" value                     (VS Code; JetBrains in-place vars)
pre-script    := "<" "{%" … "%}" | "<" path             (JetBrains; preserved verbatim, not executed)
request-line  := [ METHOD ] URL [ HTTP/version ]        (METHOD defaults to GET; custom methods allowed)
query-cont    := indented line starting with "?" or "&"
header-line   := Name ":" value | comment
body          := everything up to a response handler or end of block
handler       := "> {% … %}" | "> path.js" | ">> file" | ">>! file"   (preserved verbatim)
```

A block containing no request line (e.g. a `### Section` divider holding only comments)
is kept verbatim and attached to the following request as `leading` text, or to the end
of the file as `trailing` text. A leading block before the first `###` that holds only
variables and comments becomes the **file header** (file variables + comments).

### Lossless round-trip

The parser stores each request's original text in `Request.raw`. On save the serializer
re-parses `raw` and compares it with the edited model. **If the request is semantically
unchanged, the original bytes are emitted unchanged.** Only requests the user actually
edited are re-emitted in canonical form. Effects:

* Opening and saving an untouched file is byte-identical (covered by tests).
* Hand-written formatting, alignment and comments in requests you didn't touch survive a
  GUI edit elsewhere in the file.
* Diffs in source control stay small.

CRLF files are detected, normalized to LF in memory, and written back as CRLF.

---

## 3. Internal request model

The canonical model lives in `model.rs` and is serialized to the frontend as camelCase
JSON (TypeScript mirror: `src/lib/types.ts`).

```rust
HttpFile {
    header: FileHeader { comments, variables: Vec<Variable> },  // top-of-file @vars
    requests: Vec<Request>,
    trailing: String,           // non-request text after the last request
    line_ending: Lf | CrLf,
}

Request {
    name: String,               // "### name"
    comments: Vec<String>,      // description lines above the request line
    directives: Vec<Directive>, // # @name, @no-redirect, @timeout, unknown ones preserved
    variables: Vec<Variable>,   // @var = value lines inside this block
    pre_script: Option<String>, // verbatim
    method: String,             // GET, POST, … or any custom token
    url: String,                // WITHOUT the query string
    http_version: Option<String>,
    query: Section<Param>,      // { enabled, items: [{ enabled, name, value }] }
    headers: Section<Header>,   // { enabled, items: [{ enabled, name, value }] }
    auth: Auth,                 // { enabled, kind: None | Basic | Bearer | ApiKey, … }
    body: Body,                 // { enabled, mode, text }
    extra_comments: Vec<String>,// unrecognized comments in the header area (preserved)
    response_handler: Option<String>, // verbatim "> {% … %}" / ">> file"
    leading: String,            // verbatim non-request blocks preceding this request
    raw: Option<String>,        // original text, enables lossless round-trip
}
```

`Body.mode` ∈ `none | json | xml | text | formUrlEncoded | multipart | file | raw`. The
body is always stored as `.http` body **text**. The structured editors (form fields,
multipart parts, file picker) parse and rebuild that text, so whatever the GUI produces
is the same body JetBrains or VS Code would send.

---

## 4. Mapping GUI components to `.http` syntax

| GUI component | `.http` representation |
|---|---|
| Name | `### Get user by id` (JetBrains name). An existing `# @name id` is kept as a directive. |
| Description | Plain `#` comment lines above the request line |
| Method + URL | Request line `GET {{baseUrl}}/users/{{id}}` |
| Query params (enabled) | Appended to the URL: `?page=1&size=10`. Indented multi-line `?`/`&` continuation lines are also parsed. |
| Path params | `{{var}}` placeholders, values from file variables / environment |
| Headers | `Name: value` lines |
| Param / header descriptions | `# @param limit: Max results` / `# @header X-Trace: Correlation id` lines in the comment block above the request line. Repeated lines append. Docs that match no item are kept as directives. Both tools ignore these unknown tags (verified in JetBrains CLI 2026.3; VS Code source). They are never placed between query or header lines, where JetBrains breaks: see [research/http-comment-compat.md](research/http-comment-compat.md). |
| Auth: Basic | `Authorization: Basic {{user}} {{password}}` (the space-separated form both clients accept and encode). `user:pass` and pre-encoded base64 are also parsed. |
| Auth: Bearer | `Authorization: Bearer {{token}}` |
| Auth: API key | A header or query param plus `# @httpdesk-auth apikey header X-API-Key` |
| Body | Text after the blank line. `< ./file.json` file references and multipart bodies use standard syntax. |
| Settings | `# @no-redirect`, `# @timeout 30` (standard JetBrains/VS Code directives) |
| File variables | `@baseUrl = https://api.example.com` at the top of the file |
| Environments | `http-client.env.json` + `http-client.private.env.json` (JetBrains convention) |

Basic and Bearer auth are recognized automatically from the `Authorization` header, so
existing files get a populated Auth tab with **no metadata**. Any other `Authorization`
scheme (Digest, AWS, …) stays a plain header.

---

## 5. Persisting enabled/disabled state

### Design goals

1. Other clients (JetBrains, VS Code) must **not send** disabled components.
2. HttpDesk must recover the exact enabled/disabled configuration.
3. Use standard comment syntax; add as little metadata as possible.

### The `#~` marker

A disabled component becomes a **line comment starting with `#~`**, placed in the header
area (between the request line and the blank line). Both JetBrains and VS Code treat
`#` lines there as comments, so they ignore them, while HttpDesk recognizes the tilde as
"commented out by HttpDesk".

```http
### List pets
GET {{baseUrl}}/pets?limit=20
#~ &status=sold
Accept: application/json
#~ X-Debug: true
#~ Authorization: Bearer {{token}}
```

| Disabled item | Line |
|---|---|
| Header | `#~ Name: value` |
| Query parameter | `#~ &name=value` |
| Authentication | the auth header/param line prefixed with `#~ ` |
| Body (whole) | every body line prefixed with `#~| `, kept in the header area (no blank line before it, so it can never be sent as a body by any client) |

### Section-level toggles (all headers / all query params)

Turning off a whole section must not lose each item's own checkbox state. The number of
tildes encodes the number of reasons an item is disabled:

```
depth = (item disabled ? 1 : 0) + (section disabled ? 1 : 0)
```

so in a disabled section an enabled item is written `#~` and an individually disabled
item `#~~`. The section state is the **only extra metadata** in the design: one directive
in the request preamble.

```http
# @httpdesk-disabled headers, query
```

Auth and body have no sub-items, so they need no directive: a commented auth line or
`#~|` body lines mean disabled.

### Parsing rules and external edits

* `item.enabled = (depth - sectionDisabled) == 0`, clamped.
* If a section is marked disabled but the file contains an **uncommented** item (someone
  uncommented a header in another editor), the file content wins: the section becomes
  enabled.
* If a file has both an active body and `#~|` lines, the active body wins and the stale
  lines are kept in `extra_comments`, so nothing is discarded.
* Plain `#` comments are **never** interpreted as disabled items. They are preserved as
  comments. A human-written `# X-Foo: bar` therefore stays a comment, which avoids
  misreading prose such as `# Note: this is cool`.

### Implications (documented limitation)

* In other editors, disabled items are visible as comments. That is the intended,
  readable behavior.
* Disabled query parameters are stored after the request line, not inside the URL, so on
  reload **disabled query parameters are listed after the enabled ones**. Relative order
  within each group is preserved. Query parameter order rarely matters to servers, and
  putting comments inside a multi-line URL is not reliably supported by other clients.
* Individual form-urlencoded or multipart fields cannot be disabled in v1. The whole
  body can.

---

## 6. OpenAPI parsing and generation

### Parsing

Specs load as YAML (a superset of JSON) into a `serde_json::Value` and are processed
**structurally**, not through a typed OpenAPI crate. Reasons:

* The typed crates each cover one version (`openapiv3` is 3.0 only, `oas3` targets 3.1).
  3.0 and 3.1 differ in exactly the places we care about (`nullable` vs `type: [.., "null"]`,
  `example` vs `examples`, `exclusiveMinimum`), and a tolerant structural walker handles
  both with one code path.
* Real-world specs are often slightly invalid. We should generate what we can and report
  warnings, not refuse the whole document.

Local `$ref`s (`#/components/...`) are resolved with cycle detection. Relative-file
external refs (`./schemas/pet.yaml#/Pet`) are resolved for local specs. Remote URLs are
fetched with reqwest.

**Validation** reports *errors* (not OpenAPI 3.x, missing `paths`/`info`, unparseable
YAML or JSON) that block generation, and *warnings* (unresolvable refs, unknown security
schemes, missing response definitions) that don't.

### Generation

* **Grouping:** by first tag (default), by first path segment, or into a single file. One
  `.http` file per group: `pets.http`, `store.http`, …
* **Base URL:** `servers[0]` (server variables substituted with defaults) becomes the
  `baseUrl` variable in `http-client.env.json`. One environment per server, named from
  its description. URLs are written as `{{baseUrl}}/pets/{{petId}}`.
* **Path parameters:** `{petId}` becomes `{{petId}}`. A file variable `@petId = 1` (from
  the parameter's example, schema example, or a type-derived placeholder) is declared at
  the top of the file.
* **Query/header parameters:** required ones are generated **enabled**, optional ones
  **disabled** (`#~`), which is a natural fit for the enablement model. Users switch on
  what they need.
* **Auth:** the operation's security requirement (or the global one) maps to Basic,
  Bearer (also used for OAuth2/OIDC), or API key auth. Credentials become variables
  written to **`http-client.private.env.json`**, never the shared file.
* **Bodies:** taken in order of preference from the media type `example`, the first
  `examples` entry, then `schema.example`/`examples`/`default`/`const`/`enum[0]`, and
  finally synthesized from the schema (`properties`, `items`, `allOf` merge, first of
  `oneOf`/`anyOf`, `format`-aware placeholders such as `uuid`, `date-time`, `email`).
  JSON is pretty-printed. XML, form-urlencoded and multipart (with `< ./file` parts for
  binary fields) are generated from the same schema walk.
* **Content-Type** comes from the request body and **Accept** from the first 2xx
  response media type.
* **Names:** `### {summary | operationId | METHOD path}`, with `# @name {operationId}`.
  The description is written as comments, and `# DEPRECATED` is added when applicable.

The output is ordinary `.http` text produced by the same serializer the editor uses.

---

## 7. Filesystem change detection and synchronization

* The Tauri shell runs a `notify` watcher (via `notify-debouncer-mini`, 250 ms) on the
  workspace root and emits `workspace-changed` events listing changed paths.
* **Self-write suppression:** each write records the content hash per path, and watcher
  events whose current hash matches are dropped. This avoids reload loops without timing
  heuristics.
* **Frontend handling:**
  * The tree refreshes (debounced).
  * An open file with **no unsaved edits** is reloaded silently, and its tabs are remapped
    to their requests (by name + method + URL, then by name, then by index when the
    request count is unchanged). A tab left unmatched becomes an **Orphaned tab**: it
    keeps its edits and last response, and saving it appends the request to the file.
  * An open file **with unsaved edits** shows a banner, *"Changed on disk — Reload /
    Keep mine"*, so neither side is overwritten silently.
  * A deleted file makes its tabs Orphaned tabs. Saving recreates the file.
* Writes go to a temp file followed by a rename, so external tools never see half-written
  files.
* Deletion moves items to the OS trash (`trash` crate) rather than unlinking them. If
  the trash is unavailable, `delete_path` reports that and leaves the item in place; the
  UI asks *"Couldn't move to trash. Delete permanently?"* and only a yes calls
  `delete_permanently`.

---

## 8. Compatibility limitations and technical risks

| Risk / limitation | Mitigation |
|---|---|
| Dialect differences (JetBrains vs VS Code) | Parse the union, emit the common subset. JetBrains-only features (scripts, `> {% %}` handlers) are preserved verbatim, never executed (scripting is out of scope). |
| `#~` items render as comments in other editors | Intended; documented above. |
| Disabled query params reorder after the enabled ones | Documented; deterministic. |
| `@httpdesk-*` directives might trigger an "unknown tag" hint in JetBrains | They are plain comments to both parsers, and only written when needed (section off, API key auth). |
| Environment file conventions differ (VS Code uses `settings.json`) | Use the JetBrains env files, which are plain JSON in the repo. VS Code users can use the `vscode-restclient` env-file setting or keep both. |
| Large responses over IPC | Text bodies are capped for display (full body can still be saved). Binary is sent as base64 only for previewable types under the cap. |
| Huge OpenAPI specs (thousands of operations) | Generation is linear; the operation picker list is virtualized by grouping and collapsed groups. |
| External `$ref` to remote URLs | Not resolved in v1 (warning); local relative-file refs are. |
| Linux WebKitGTK rendering differences | Conservative CSS; test on all three in CI. |
| Secrets in env files | **Secrets** are written only to `http-client.private.env.json`; the shared file keeps at most an empty placeholder. If the workspace is inside a git repository (the nearest `.git` above it) and no `.gitignore` from the repo root down ignores the private file, HttpDesk appends it to the workspace's `.gitignore` on open and on save. The Environments editor warns when it is still not ignored. Env values keep their JSON type (number, boolean, null) on save. |

---

## 9. Phased implementation plan

1. **Core format** — model, parser, serializer, disabled-component encoding; round-trip
   tests on JetBrains and VS Code samples.
2. **Vertical slice** — Tauri shell, workspace open, tree, tabs, request editor
   (params/headers/auth/body/settings with toggles), execution, response viewer, save,
   reopen.
3. **Environments** — env files, selector, editor, secret handling, variable highlighting.
4. **OpenAPI** — load (file/URL), validate, operation picker, generator, env output.
5. **File management and sync** — create/rename/move/delete, watcher, conflict banner,
   search.
6. **Polish and packaging** — keyboard shortcuts, binary previews, TLS settings, CI
   bundles for Windows, macOS and Linux.

Deferred (out of scope): scripting, chaining, assertions, cookies UI, collaboration,
sync, WebSocket, GraphQL, mocks.

---

## 10. Implementation notes (v0.1)

Decisions made during implementation, beyond the plan above:

* **Environment files live at the workspace root.** Every request in the workspace
  uses `http-client.env.json` / `http-client.private.env.json` from the root.
  Per-directory env files (which JetBrains also supports) are not merged yet.
* **Variable precedence:** request `@vars` > file `@vars` > selected environment >
  `$shared`. Dynamic variables (`$uuid`, `$timestamp`, `$isoTimestamp`,
  `$randomInt`, `$random.*`, `$datetime`, `$processEnv`, `$env.X`, `$dotenv`)
  are resolved at send time. Unresolved variables are sent as written and reported
  as a warning on the response.
* **Auto Content-Type:** choosing a body mode sets the `Content-Type` header (an
  ordinary, visible header). At send time, a missing Content-Type is inferred from
  the body mode.
* **Body mode `none`** means "no body". Text left in other modes is discarded on
  save. To keep a body without sending it, disable the body instead.
* **Basic auth** is written as `Basic user password`, or `Basic user:password`
  when either part is empty or the user contains a space or colon, so it always
  round-trips.
* **OpenAPI:**
  * Relative server URLs resolve against the spec URL (or `http://localhost`).
  * Each environment is named after the server description; a single server
    without a description is named `default`.
  * Generated files start with a `# Generated by HttpDesk from …` comment.
  * Existing files are never overwritten without confirmation: generation first
    runs dry, reports conflicts, and the UI asks before writing.
* **Settings** (timeouts, redirects, TLS, theme, layout, recent workspaces) are
  app metadata, stored in the OS config dir (`HTTPDESK_CONFIG_DIR` overrides it).
  Per-request overrides are standard directives in the file.

### Test strategy

| Layer | Tests |
|---|---|
| Format | `crates/httpdesk-core/tests/format.rs`: JetBrains and VS Code fixtures, byte-identical round-trip (LF, CRLF, no final newline), item/section/auth/body enablement, API key, edge cases |
| Execution | `tests/exec.rs`, against a wiremock server: disabled components are never sent, auth kinds, variables, JSON/form/multipart/file bodies, redirects, timeouts, custom methods, binary and charset handling |
| OpenAPI | `tests/openapi.rs`: 3.0 YAML and 3.1 JSON fixtures, insta snapshots of generated files, grouping, selection, auth, env and secrets output, validation errors, external refs |
| Env, vars, workspace | Unit tests in each module |
| IPC | `src-tauri/src/ipc_tests.rs`: the real command handlers invoked with frontend-shaped JSON through Tauri's mock runtime. Covers the full open → edit → toggle → send → save → reopen slice, environments, OpenAPI generation, and the file watcher (including self-write suppression) |
| Frontend | `src/lib/http.test.ts`: URL ⇄ params sync, form and multipart editors, body mode / Content-Type sync, directives |
| Visual | `pnpm dev` in a browser with the mocked backend (`src/dev/mock.ts`) |

### Known gaps / next steps

* Individual form-urlencoded and multipart fields can't be disabled; only the whole
  body can (see §5).
* No cookie jar; responses' `Set-Cookie` is not replayed.
* Scripts (`< {% %}`, `> {% %}`) are preserved but not executed (out of scope).
* Request-to-request variables (`{{login.response.body.token}}`) are not supported.
* No code signing or notarization in the release workflow.
