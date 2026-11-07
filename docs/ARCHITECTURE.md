# HttpDesk — Technical Architecture

This document covers the stack evaluation, the `.http` format strategy, the internal
model, disabled-component persistence, OpenAPI generation, filesystem sync, risks, and
the phased plan. It is the reference for decisions made in the code; when the code
and this document disagree, fix one of them. Terms in **bold** (**File variable**,
**Secret**, **Orphaned tab**) are defined in [GLOSSARY.md](../GLOSSARY.md).

---

## 1. Stack evaluation (Svelte 5 + Rust + Tauri 2)

| Concern | Assessment |
|---|---|
| **Tauri 2** | Good fit. Single binary per OS, uses the OS webview (WebView2 / WKWebView / WebKitGTK), so bundles are ~10 MB instead of Electron's ~150 MB. Async commands run on a Tokio runtime; synchronous commands run on the main thread. Anything that can be slow (sending a request, opening a workspace, listing the tree, search, delete, OpenAPI loading and generation, saving a response body, formatting a body, a hex dump) is therefore an async command or runs on the blocking pool, so the window stays responsive. Single-file reads and saves are quick synchronous commands. The capability system limits what the webview can do. |
| **Rust core** | `.http` parsing, serialization, variable resolution, execution and OpenAPI generation all live in a plain library crate (`crates/httpdesk-core`) with **no Tauri dependency**. It can be tested with `cargo test` and no window, and could later be reused by a CLI. |
| **reqwest** | Chosen. Mature, async, supports rustls (no OpenSSL dependency, so cross-compiling is easy), custom methods, redirect policies, timeouts, custom root CAs, client identities (mTLS), and accepting invalid certificates. TLS and redirect settings can differ per request or environment, so a client is built for its settings, and the shell keeps idle ones in an `exec::ClientPool` keyed by everything a client is built from (redirects, timeouts, TLS verification, CA and client certificate files by path, size and modification time, and the proxy environment variables). Each send checks out a client no other send is using, or a new one when none is idle (at most 8 are kept idle), so a later send can go over a connection an earlier one left open and the Timing tab can say "reused". Each client carries timing hooks (a DNS resolver wrapper, a connector layer and a redirect-policy wrapper) that measure the final request's DNS, connect + TLS, waiting and download phases, and a cookie recorder; both are cleared at the start of each send. |
| **Svelte 5** | Runes (`$state`, `$derived`) handle the deeply nested request model without a separate store library. It compiles to small, fast bundles. Plain Vite SPA, without SvelteKit (no routing or SSR needed). |
| **CodeMirror 6** | Used for the body editor, the response viewer (syntax highlighting, folding, **search**, virtualized rendering of large responses) the single-line URL editor and the variable-aware value fields (`VarField`, [controls.md](controls.md#varfield)), which share `{{variable}}` highlighting, hover cards and autocompletion. |
| **Webview differences** | The main cross-platform risk. WebKitGTK on Linux lags Chromium. We stick to well-supported CSS (flex/grid, custom properties) and avoid bleeding-edge APIs. The UI uses HttpDesk's own controls and bundled fonts instead of native form widgets and system fonts, so it renders the same in every webview ([ADR-0002](adr/0002-owned-controls-over-native-widgets.md)); the controls are described in [controls.md](controls.md). |

Rejected alternatives: Electron (size, needs a Node backend), a sidecar HTTP service
(the requirements forbid a separately managed backend), and SvelteKit (unnecessary).

### Layout

```
crates/httpdesk-core/   pure Rust library — all domain logic + tests
  model.rs              request/file model (serde, shared with the frontend as JSON)
  parser.rs             .http text → HttpFile
  serializer.rs         HttpFile → .http text (lossless for untouched requests)
  query.rs              query param escaping, unescaping and send-time encoding (ADR-0001)
  env.rs                http-client.env.json / http-client.private.env.json, gitignore check
  vars.rs               {{variable}} + dynamic variable resolution
  exec.rs               request execution via reqwest, send error classification
  exec/body.rs          response body: raw-byte count, Content-Encoding decoding, size limit
  exec/timing.rs        phase timing hooks (DNS, connect + TLS, redirects) for the Timing tab
  cookies.rs            Set-Cookie parsing, and the display-only cookie recorder plugged into reqwest
  body_format.rs        lossless JSON Beautify/Minify/Pretty: re-indents tokens, never re-parses numbers
  body_format/          xml.rs (XML formatter, same approach), hex.rs (Hex view dump)
  json_filter.rs        RFC 9535 JSONPath filter bar: matches copied from the body's own text; shape summary for key completion
  tls_probe.rs          why a server's certificate was rejected (self-signed, expired)
  openapi/              OpenAPI 3.0/3.1 loading, validation, generation
  workspace.rs          tree listing, search, ignore rule, atomic writes
src-tauri/              thin Tauri shell: commands, app state
  confine.rs            workspace confinement for every path a command receives
  watcher.rs            file watcher
  self_writes.rs        self-write suppression for the watcher
  deleting.rs           trash, and the confirmed permanent delete
  bodies.rs             recent response bodies kept for "save to file" and the Hex view
  json_docs.rs          recent bodies parsed as JSON (each with its shape summary), by response id, for the filter bar
  quit.rs               macOS ⌘Q / Dock Quit always go through the window-close flow
  theme.rs              creates the main window in the saved theme (no dark flash at start-up)
  theme-boot.js         the window's initialization script: sets data-theme before first paint
src/                    Svelte 5 frontend
vendor/serde_json_path_core/  patched copy (exact number comparisons in filters; see its PATCHED file)
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
directive     := ("#" | "//") [ " " ] "@" key [ value ] e.g. # @name, # @no-redirect, # @timeout 30
file-variable := "@" name "=" value                     (VS Code; JetBrains in-place vars)
pre-script    := "<" "{%" … "%}" | "<" path             (JetBrains; preserved verbatim, not executed)
request-line  := [ METHOD ] URL [ HTTP/version ]        (METHOD defaults to GET; custom methods allowed)
query-cont    := indented line starting with "?" or "&"
header-line   := Name ":" value | comment | disabled item (§5)
body          := everything up to a response handler or end of block
handler       := "> {% … %}" | "> path.js" | ">> file" | ">>! file"   (at column 0; preserved verbatim)
```

A directive's `@` comes right after the comment prefix or one space. A comment indented
further (`#   @x`) is description text, never a directive.

Every `@name = value` line is a **File variable**, wherever it is written. A handler
starts only at column 0, as in the JetBrains grammar, so an indented `>` or `>>` line
is body content.

A block containing no request line (e.g. a `### Section` divider holding only comments)
is kept verbatim and attached to the following request as `leading` text, or to the end
of the file as `trailing` text. If the text before the first `###` has no request line,
it becomes the **file header**: its `@name = value` lines are File variables and every
other non-blank line is kept as a comment line. If it does have a request line, it is the
file's first request, written without a `###`.

### Lossless round-trip

The parser stores each request's original text in `Request.raw`. On save the serializer
re-parses `raw`, renders it and the edited model canonically, and compares the two.
**If the request is semantically unchanged, the original bytes are emitted unchanged.**
Only requests the user actually edited are re-emitted in canonical form. Effects:

* Opening and saving an untouched file is byte-identical when the file uses one line
  ending throughout (covered by tests for LF, CRLF, a UTF-8 BOM, and no final newline).
  One thing is normalized: a file with mixed line endings is saved with its dominant
  ending. Blank lines that are the only content before the first `###` are kept.
* Hand-written formatting, alignment and comments in requests you didn't touch survive a
  GUI edit elsewhere in the file.
* Diffs in source control stay small.

**Line endings.** The parser counts CRLF and bare LF line breaks. The file is CRLF only
if CRLF breaks outnumber bare LF ones (a tie is LF). Text is normalized to LF in memory,
and the whole file is written back with that one ending.

**Byte order mark.** A leading UTF-8 BOM is stripped before parsing, so it can't hide
the first request's `###` or method, and is recorded in `HttpFile.bom`. Saving writes it
back.

**Edited requests** are re-rendered, but keep what HttpDesk didn't touch:

* Unrecognized header-area lines (comments) stay above the header or disabled query
  param they preceded (`ExtraLine.before`), or go after the headers if that item is gone.
* Unknown directives, unrecognized `@httpdesk-auth` / `@httpdesk-disabled` values and
  `# @param` / `# @header` docs with no text are kept. The `@httpdesk-disabled` line keeps
  the order of the original line (read from `Request.raw`); sections turned off by the
  edit follow it.
* The `Authorization` header is written as it was (`Auth.raw`, e.g. pre-encoded base64)
  for as long as it still parses to the same credentials.
* A description with several lines is written as one `#` line per line. A description
  line whose first non-space character is `@` followed by a name is written as `@ name`
  (the OpenAPI generator's rule, one shared helper), so no client reads it as a directive.

**File header.** An edited header is rendered inside its original text (`FileHeader.raw`):
comments and blank lines stay put, unchanged variable lines keep their bytes, removed
ones are dropped, and new ones go after the last variable line. If the header's comments
were edited, the header is rebuilt from the model (comments, then variables).

**Separators.** Only a file's first block may omit `###`. When a request without one
would no longer be first (a request was inserted, duplicated or moved before it), the
serializer writes `###` in front of it, so the two never merge.

**Save-time safeguard.** `try_serialize`, which `save_http_file` and OpenAPI generation
use, refuses a model that would change the file's structure, and the file is left
untouched. It refuses line breaks in single-line fields (name, method, URL, HTTP version,
directives, variable names and values, query param and header names and values, auth
fields, `Auth.raw`, extra lines, file-header comments). It also refuses variable names
that wouldn't read back as variables, API key names with whitespace, header names
(including an API key sent as a header) that contain whitespace or `:`, or start with
`//`, `#`, `~`, `|`, `&` or `?`, a method containing whitespace, a query param name
containing `:` while it has a description (`# @param` splits at the first `:`), and a
Basic auth username containing `:` (RFC 7617 can't represent it). The error names the
request and the field. This backs up the UI, which checks header, API-key, Basic
username and variable names as you type and edits single-line fields in plain inputs or
single-line editors (the URL bar, VarField) that can't hold a line break. Body text is written as is. A body line that `.http` would read as syntax (a
`###` separator, or a column-0 `>>`, `> {%` or `> file.js` handler) gets an inline
warning in the body editor instead.

---

## 3. Internal request model

The canonical model lives in `model.rs` and is serialized to the frontend as camelCase
JSON (TypeScript mirror: `src/lib/types.ts`).

```rust
HttpFile {
    header: FileHeader { comments, variables: Vec<Variable>, raw: Option<String> },
    requests: Vec<Request>,
    trailing: String,           // non-request text after the last request
    line_ending: Lf | Crlf,     // dominant ending; the whole file is saved with it
    bom: bool,                  // the file started with a UTF-8 BOM
}

Request {
    name: String,               // "### name"
    comments: Vec<String>,      // description lines above the request line
    directives: Vec<Directive>, // # @name, @no-redirect, @timeout, unknown ones preserved
    variables: Vec<Variable>,   // File variables declared inside this block
    pre_script: Option<String>, // verbatim
    method: String,             // GET, POST, … or any custom token
    url: String,                // WITHOUT the query string
    http_version: Option<String>,
    query: KvSection,           // { enabled, items: Vec<KeyValue> }
    headers: KvSection,         // { enabled, items: Vec<KeyValue> }
    auth: Auth,                 // { enabled, kind: None | Basic | Bearer | ApiKey, …, raw }
    body: Body,                 // { enabled, mode, text }
    extra_lines: Vec<ExtraLine>,// unrecognized header-area lines: { text, before }
    response_handler: Option<String>, // verbatim "> {% … %}" / ">> file"
    leading: String,            // verbatim non-request blocks preceding this request
    raw: Option<String>,        // original text, enables lossless round-trip
}

KeyValue {
    enabled: bool,
    name: String,               // decoded (query params: see §10)
    value: String,
    description: String,        // "# @param name: …" / "# @header Name: …"
    equals: bool,               // query only: an empty value is written "name=", not "name"
}
```

`Auth` keeps the fields of every kind (`username`, `password`, `token`, `key_name`,
`key_value`, `key_location`), so switching kinds in the GUI doesn't lose typed values;
only the fields of the current kind are written. `Auth.raw` is the `Authorization` value
as written in the file.

`Body.mode` ∈ `none | json | xml | text | formUrlEncoded | multipart | file | raw`. The
body is always stored as `.http` body **text**. The structured editors (form fields,
multipart parts, file picker) parse and rebuild that text, so whatever the GUI produces
is the same body JetBrains or VS Code would send. A disabled form field or multipart part
is held in that text as `#~` lines, in place (§5).

---

## 4. Mapping GUI components to `.http` syntax

| GUI component | `.http` representation |
|---|---|
| Name | `### Get user by id` (JetBrains name). An existing `# @name id` is kept as a directive. |
| Description | Plain `#` comment lines above the request line, one per line of the description |
| Method + URL | Request line `GET {{baseUrl}}/users/{{id}}` |
| Query params (enabled) | Appended to the URL: `?page=1&size=10`. Indented multi-line `?`/`&` continuation lines are also parsed. Characters that would change the query's structure are percent-escaped in the file; the rest is encoded at send time ([ADR-0001](adr/0001-query-encoding.md), §10). |
| Path params | `{{var}}` placeholders, values from File variables / environment |
| Headers | `Name: value` lines |
| Param / header descriptions | `# @param limit: Max results` / `# @header X-Trace: Correlation id` lines in the comment block above the request line. Repeated lines append. Docs that match no item, or have no text, are kept as directives. Both tools ignore these unknown tags (verified in JetBrains CLI 2026.3; VS Code source). They are never placed between query or header lines, where JetBrains breaks: see [research/http-comment-compat.md](research/http-comment-compat.md). |
| Auth: Basic | `Authorization: Basic {{user}} {{password}}` (the space-separated form both clients accept and encode); §10 lists the other forms written. `user:pass` and pre-encoded base64 are also parsed. |
| Auth: Bearer | `Authorization: Bearer {{token}}` |
| Auth: API key | A header or query param plus `# @httpdesk-auth apikey header X-API-Key` |
| Body | Text after the blank line. `< ./file.json` file references (the space after `<` is optional) and multipart bodies use standard syntax. |
| Settings | `# @no-redirect`, `# @timeout 30`, `# @connection-timeout 5` (standard JetBrains directives; see §10). `# @no-auto-encoding` is kept and honoured at send. |
| File variables | `@baseUrl = https://api.example.com`, anywhere in the file; the GUI's file variables are written at the top of the file. |
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
| Form-urlencoded field | `#~ &name=value` **in the body**, where the field was (`#~ name=value` on the first line). The first field sent is written without `&` |
| Multipart part | every line of the part, its `--boundary` line included, prefixed with `#~=` in the header area |

Disabled form fields and multipart parts are placed differently because JetBrains treats
comments differently in the two bodies: it drops them from a form body but sends them as
part content in a multipart body ([ADR-0003](adr/0003-disabled-form-fields-and-multipart-parts.md),
[research](research/http-comment-compat.md) Appendix C). VS Code drops every comment line.
JetBrains also sends an empty form body when the first line it sends starts with `&`, so
that line never has one.

```http
### Upload
POST {{baseUrl}}/upload
Content-Type: multipart/form-data; boundary=B
#~= --B
#~= Content-Disposition: form-data; name="debug"
#~=
#~= true

--B
Content-Disposition: form-data; name="title"

Hello
--B--
```

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
# @httpdesk-disabled query, headers
```

Auth and body need no directive: a commented auth line or `#~|` body lines mean disabled.
Fields of a disabled body keep their own state by nesting: the body's in-memory text,
disabled fields included, is written as `#~|` lines, so a disabled multipart part reads
`#~| #~ --B` and a disabled form field `#~| #~ &name=value`.

### Parsing rules and external edits

* `item.enabled = (depth - sectionDisabled) == 0`, clamped.
* If a section is marked disabled but the file contains an **uncommented** item (someone
  uncommented a header in another editor), the file content wins: the section becomes
  enabled.
* If a file has both an active body and `#~|` lines, the active body wins and the stale
  lines are kept in `extra_lines`, so nothing is discarded.
* Plain `#` comments are **never** interpreted as disabled items. They are preserved as
  comments. A human-written `# X-Foo: bar` therefore stays a comment, which avoids
  misreading prose such as `# Note: this is cool`. In a form body, plain `#` and `//`
  lines stay comments too: the form editor keeps them above the field they preceded, and
  they are not sent (neither JetBrains nor VS Code sends them).
* `#~=` lines are read into a multipart body before its closing `--boundary--` line. Next
  to a body that isn't multipart they are kept in `extra_lines`, like stale `#~|` lines.

### Implications (documented limitation)

* In other editors, disabled items are visible as comments. That is the intended,
  readable behavior.
* Disabled query parameters are stored after the request line, not inside the URL, so on
  reload **disabled query parameters are listed after the enabled ones**. Relative order
  within each group is preserved. Query parameter order rarely matters to servers, and
  putting comments inside a multi-line URL is not reliably supported by other clients.
* Disabled multipart parts are stored in the header area, so on reload they are listed
  after the enabled parts, in their original relative order. Disabled form fields stay in
  place.
* In an enabled multipart part, a content line starting with `#~` is read as a disabled
  part line.

---

## 6. OpenAPI parsing and generation

### Parsing

Specs are read into a `serde_json::Value` and processed **structurally**, not through a
typed OpenAPI crate. Text that starts with `{`, or comes from a `.json` file, is parsed
as JSON; if that fails it is accepted only when YAML reads it as a mapping, otherwise the
JSON error is reported. Anything else is parsed as YAML. Reasons for the structural
approach:

* The typed crates each cover one version (`openapiv3` is 3.0 only, `oas3` targets 3.1).
  3.0 and 3.1 differ in exactly the places we care about (`nullable` vs `type: [.., "null"]`,
  `example` vs `examples`, `exclusiveMinimum`), and a tolerant structural walker handles
  both with one code path.
* Real-world specs are often slightly invalid. We should generate what we can and report
  warnings, not refuse the whole document.

Local `$ref`s (`#/components/...`) are resolved lazily, with cycle detection. Relative-file
external refs (`./schemas/pet.yaml#/Pet`) are inlined at load time for specs loaded from
a file, resolved against the spec's folder. A spec loaded from a URL has no local folder,
so its relative-file refs are not resolved (warning). Remote `$ref`s (`http://…`,
`https://…`) are never fetched (warning).

**Validation** reports *errors* that block generation: unparseable JSON or YAML, a
document that isn't an object, Swagger 2.0, a missing or non-3.x `openapi` version, a
missing `info` object, a `paths` that isn't an object, or (3.0 only) a missing `paths`.
*Warnings* don't block: a version newer than 3.1 (read like 3.1), no paths, unresolved,
unloadable or circular references, undeclared path parameters, and unknown or
unsupported security schemes.

### Generation

* **Grouping:** by first tag (default), by first path segment, or into a single file. One
  `.http` file per group: `pets.http`, `store.http`, …
* **Base URL:** each server (server variables replaced by their default, or their first
  `enum` value) becomes an environment in `http-client.env.json` whose `baseUrl` variable
  is that server's URL. Environments are named from the server description. A spec with
  no servers gets one `default` environment pointing at `http://localhost`. URLs are
  written as `{{baseUrl}}/pets/{{petId}}`.
* **Path parameters:** `{petId}` becomes `{{petId}}`. A File variable `@petId = 1` (from
  the parameter's example, its schema's example, or a type-derived placeholder) is
  declared at the top of the file.
* **Query/header parameters:** required ones are generated **enabled**, optional ones
  **disabled** (`#~`), which is a natural fit for the enablement model. Users switch on
  what they need. Example values are stored decoded and escaped by the serializer (§10).
  Cookie parameters become one `Cookie` header.
* **Auth:** the operation's security requirement (or the global one) maps to Basic,
  Bearer (also used for OAuth2/OIDC), or API key auth. Other HTTP schemes become a plain
  `Authorization` header (warning). The auth values (`{{username}}`, `{{token}}`, …)
  become **Secrets**: variables written to **`http-client.private.env.json`**, never the
  shared file.
* **Bodies:** the preferred media type is JSON, then form-urlencoded, multipart, XML,
  text, then the first one listed. Its example is the media type's `example`, else the
  first entry of its `examples` that has a `value`, else one from the schema. A schema's
  own example is its `example`, else `examples[0]`, `const`, `default`, or the first
  non-null `enum` value, in that order. Otherwise an example is synthesized from the
  schema (`properties` that aren't `readOnly`, `items`, `allOf` merge, first non-null of
  `oneOf`/`anyOf`, `format`-aware placeholders such as `uuid`, `date-time`, `email`).
  JSON is pretty-printed. XML, form-urlencoded and multipart (with `< ./file` parts for
  binary fields) are generated from the same schema walk. Example lines that `.http`
  would read as a separator or handler (`###`, `>>`, `> {%`) are indented by one space,
  so the generated file reloads with the same requests.
* **Content-Type** comes from the request body's media type and **Accept** from the first
  media type of the first 2xx response that has content.
* **Names:** `### {summary | operationId | METHOD path}`, with `# @name {operationId}`
  (derived from the method and path when there is none). The description is written as
  comments, with `# DEPRECATED` first when applicable. A description line starting with
  `@` (even indented) is written as `@ …`, the serializer's rule for descriptions (§2),
  so it isn't read back as a directive.

The output is ordinary `.http` text produced by the same serializer the editor uses.

---

## 7. Filesystem change detection and synchronization

* The Tauri shell runs a `notify` watcher (via `notify-debouncer-mini`, 250 ms) on the
  workspace root. It emits `workspace-changed` events listing changed paths,
  `workspace-missing` when the workspace folder is deleted or moved (also polled every
  second, since some platforms don't report it), and `workspace-watch-error`. A new
  workspace's watcher replaces the previous one only once it has started, so a failure
  leaves the previous workspace syncing.
* **Ignore rule:** the explorer and the watcher share one rule. Folders below the
  workspace root whose names start with `.`, or are `node_modules`, `target`, `dist`,
  `build`, `__pycache__` or `venv`, are skipped. The watcher reports only `.http`/`.rest`
  files, the two environment files and folders; other files (build output, `.gitignore`,
  …) are never read or reported.
* **Self-write suppression:** before each of its own file operations (save, new file or
  folder, rename, move, delete), the shell records the disk state the operation will
  leave: a file with a given content hash, a folder, or nothing at that path (and below
  it). A watcher event is dropped while the disk still matches. The first event that
  doesn't match is reported and the expectation is forgotten. This avoids reload loops
  without timing heuristics.
* **Frontend handling:**
  * The tree refreshes (debounced), and environments reload when an env file changes.
  * An open file with **no unsaved edits** is reloaded silently, and its tabs are remapped
    to their requests (by name + method + URL, then by name, then by position: a
    still-unmatched request takes the one now at its index if no other tab claimed that
    one, even when requests were added or removed). A tab left unmatched becomes an **Orphaned tab**: it
    keeps its edits and last response, and saving it appends the request to the file.
  * An open file **with unsaved edits** whose content on disk differs from what was last
    loaded or saved shows a banner, *"… changed on disk while you have unsaved edits"*,
    with *Reload from disk* / *Keep my version*, so neither side is overwritten silently.
  * A file deleted or moved outside HttpDesk makes its tabs Orphaned tabs. Saving
    recreates the file.
  * A missing workspace folder or a watch error is shown as an error toast.
* **Workspace confinement:** every command that takes a workspace path (read, save, new
  file or folder, rename, move, delete, OpenAPI output) resolves it against the canonical
  workspace root and refuses anything outside it before touching the disk. A write
  (save, new file, OpenAPI output) through a symlink is also refused when the link's
  final target, dangling or not, lies outside the workspace. Name prompts also reject
  `/`, `\`, `.` and `..`.
* Workspace files, environment files and settings are written to a temp file that is
  then renamed over the target, so external tools never see half-written files. A symlink
  whose target is inside the workspace is written through to its target, and an existing
  file keeps its permissions. A settings file that can't be written is reported ("Could
  not save settings: …" toast).
* Deletion moves items to the OS trash (`trash` crate) rather than unlinking them. If
  the trash is unavailable, `delete_path` reports that and leaves the item in place. The
  UI then asks *"Couldn't move to trash"* (*Delete "name" permanently?*), and only a
  confirmed *Delete permanently* calls `delete_permanently`, the one command that
  unlinks. That dialog, like OpenAPI's *Overwrite existing files?*, opens with Cancel
  focused, so a stray Enter destroys nothing. A delete from the explorer closes the tabs
  of the deleted files.

---

## 8. Compatibility limitations and technical risks

| Risk / limitation | Mitigation |
|---|---|
| Dialect differences (JetBrains vs VS Code) | Parse the union, emit the common subset. JetBrains-only features (scripts, `> {% %}` handlers) are preserved verbatim, never executed (scripting is out of scope). |
| `#~` items render as comments in other editors | Intended; documented above. |
| Disabled query params and multipart parts reorder after the enabled ones | Documented; deterministic. |
| `@httpdesk-*` directives might trigger an "unknown tag" hint in JetBrains | They are plain comments to both parsers, and only written when needed (section off, API key auth). |
| Environment file conventions differ (VS Code uses `settings.json`) | Use the JetBrains env files, which are plain JSON in the repo. VS Code users can use the `vscode-restclient` env-file setting or keep both. |
| Large responses over IPC | A response is read up to the maximum body size (Settings, default 100 MB) and truncated beyond it. The limit counts decoded bytes, after `Content-Encoding` is undone. Text bodies go to the UI as text. Other bodies go as base64 only up to 25 MB, for an image preview. The shell keeps recent bodies (up to 20, and 256 MB in total, oldest evicted first) so "save to file" writes the bytes received, and the Hex view is the core's dump of the first 64 KB of the stored body (`hexdump` by response id), so it works at any size. Pretty is offered only for JSON and XML (for HTML or text it would show the raw text, so those get Raw, plus Preview for HTML); the Pretty view is formatted by the shell on the blocking pool: up to 1 MB of text it arrives with the response (`prettyText`), larger bodies are formatted from the stored body when Pretty is opened (`pretty_response` by response id), with a loading state meanwhile. If the body doesn't parse or has been evicted, Pretty shows the raw text. Copy body copies a binary body as its base64 text, asking first above 1 MB. The JSONPath filter bar (whole JSON bodies only, not truncated ones) runs `filter_response` by response id on the blocking pool; the shell keeps the last 3 bodies parsed as JSON, so typing doesn't re-parse. Key completion comes from `response_shape`: the keys reachable at each place (array items merged, at most 1000 keys per place), built once per parsed document and kept with it; the webview fetches it once per response and completes locally on every keystroke. serde_json's `arbitrary_precision` isn't enabled: it would still rewrite `1e3` as `1e+3`, and would switch on for Tauri too. Instead the parsed value only decides what matches, and each match is copied from the body's text by its location. Filter comparisons (`==`, `<`, ...) compare numbers exactly: integers as integers (19-digit ids, values past 2^53), and an integer against a decimal or exponent by value (`10.50 == 10.5`, `1e3 == 1000`); serde_json_path compares through f64, so `vendor/serde_json_path_core` patches that. A decimal with more digits than an f64 holds compares as its nearest f64. A body nested deeper than serde_json's 128 levels says "This body is nested too deeply to filter" (the formatter allows 1000). |
| Huge OpenAPI specs (thousands of operations) | Generation is linear. The operation picker groups operations under collapsible headings and has a filter; it is not virtualized. |
| External `$ref` to remote URLs | Not fetched (warning); relative-file refs are resolved for specs loaded from a file. |
| Linux WebKitGTK rendering differences | Conservative CSS. CI builds and runs the Rust and frontend tests on Linux, macOS and Windows, but runs the Playwright UI tests in Chromium only; rendering in the three OS webviews is checked by hand with the [manual OS rendering check](os-checklist.md). |
| Secrets in env files | **Secrets** are written only to `http-client.private.env.json`; the shared file keeps at most an empty placeholder. If the workspace is inside a git repository (the nearest `.git` at or above it) and no `.gitignore` rule from the repo root down matches the private file at all, HttpDesk appends it to the workspace's `.gitignore` on open and on save, once a private file exists. An explicit `!` negation of the file is the user's choice and is left alone. The Environments editor warns when there are Secrets and the private file is still not ignored. Env values keep their JSON type (number, boolean, null) on save. |

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
* **Production environments and colours.** An environment can be marked production and
  given a colour in the Environments modal. Both are stored in the app settings
  (`environmentSettings`, keyed by workspace root, then environment name), never in the
  env files, so other tools don't see extra keys they'd read as variables. Renaming an
  environment in the modal carries them over, deleting it drops them, and duplicating it
  copies them. Sending anything but GET, HEAD or OPTIONS with a production environment
  selected first asks through the shared Dialog (Cancel focused), naming the environment
  and the method; Cancel doesn't send. The colour comes from a fixed palette
  (`src/lib/envColors.ts`) with a shade per theme that keeps 3:1 contrast against the top
  bar, and tints the top bar's environment indicator (icon, border, a faint wash; the
  name keeps the text colour).
* **Variable precedence:** File variables > selected environment > `$shared`. Within an
  environment, a value in the private file overrides one in the shared file. Among File
  variables, the request's own declaration wins over a same-named one elsewhere in the
  file. Values are resolved recursively in that same scope, so an environment's
  `baseUrl = {{host}}/api` picks up a File variable `host`. Two resolvers apply these
  rules: the core's `vars::Resolver` at send, and the frontend's `makeVarProvider`
  (`src/lib/vars.ts`) for highlighting, hover and autocomplete. They are kept in step by
  one set of cases, `crates/httpdesk-core/tests/fixtures/resolution-cases.json`, which
  `tests/resolution_parity.rs` and `src/lib/vars.test.ts` both run. The frontend leaves
  dynamic variables as written. Dynamic variables (`$uuid`/`$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`,
  `$random.*`, `$datetime`, `$localDatetime`, `$processEnv`, `$env.X`, `$dotenv`) are
  resolved at send time. A dynamic variable with invalid or out-of-range arguments stops
  the send with an error naming it. The core generates only the names in
  `vars::DYNAMIC_VARIABLES`; any other `{{$name}}` is an Undefined variable, in both
  resolvers. Autocomplete lists them from `crates/httpdesk-core/dynamic-variables.json`
  (with a description and an argument hint each), and a core test fails if that list
  and `DYNAMIC_VARIABLES` differ.
* **Unresolved variables:** if the URL's scheme or host still contains an unresolved
  `{{variable}}` (typically `{{baseUrl}}` with no environment selected), the send fails
  with an error naming the variables and suggesting an environment that defines them.
  Anywhere else, unresolved variables are sent as written (in the query they are
  percent-encoded like any other text) and reported as a warning on the response.
* **Circular references:** a reference that leads back to a name already being resolved
  (`a → b → a`, or `@host = {{host}}/v2`) is its own state, not an Undefined variable.
  Resolution stops at the repeated name, leaves that reference as written, and records
  the chain followed from the reference as written (`Resolver::circular`). There is no
  depth limit; a chain without a cycle resolves however long it is. The URL bar and body
  editor colour it apart (`cm-var-circular`) and hover shows "Circular: a → b → a". At
  send, each chain is its own warning ("Circular variable reference: a → b → a"); one in
  the URL's scheme or host fails the send with kind `circularVariable`, unless an
  Undefined variable is also there, which is reported first.
* **Query encoding** follows [ADR-0001](adr/0001-query-encoding.md). The params table
  holds decoded names and values. In the file, only characters that would change the
  query's structure are percent-escaped: whitespace, `&`, `#`, `=` in names, and `%`
  where it would read as such an escape or sits right before one. Only escapes of those
  characters are decoded on load, so a hand-written `%40` stays `%40` and re-saves byte
  for byte. `?flag=` and `?flag` stay distinct (`KeyValue.equals`). At send, each name
  and value has its variables resolved and is then percent-encoded, keeping
  `A-Za-z0-9 -._~!$'()*,;:@/?` (and `=` in values) and any existing `%XX` escape, so
  nothing is encoded twice and `&`, `=` or `#` from a variable can't split a param. A `+`
  written in the file is kept; one that comes from a variable is sent as `%2B`. An API
  key sent as a query param goes through the same path. `# @no-auto-encoding` sends the
  query as written, with variables resolved. Only the query is encoded this way; the
  path is left to the URL parser.
* **Timeouts** follow JetBrains. `@timeout` (and the app default, 30 s) is an idle
  timeout: the longest wait for the next data, response headers or a body chunk. There
  is no total deadline, so a download that keeps streaming finishes.
  `@connection-timeout` (app default 10 s) limits only connecting, TCP and TLS. Both
  directives take seconds by default, or an `ms`, `s` or `m` suffix (`500 ms`, `2m`);
  0 turns a timeout off. A timeout error names which timeout fired and its value. The
  idle timeout also runs while connecting, so an `@timeout` shorter than the connect
  time is reported as a read timeout.
* **Content encoding:** reqwest's decompression is off; the core decodes bodies itself
  so it can count the bytes on the wire (`transferredSize`) as well as the decoded size
  (`bodySize`). A request without `Accept-Encoding` gets `gzip, deflate, br, zstd` added
  at prepare time, so the Request tab shows it. A user-set `Accept-Encoding` is sent
  unchanged. A response in an encoding we can't decode, or whose body fails to decode,
  is shown as received (binary), with a warning ("Couldn't decode the gzip body (…);
  showing the bytes as received"); status, headers and cookies are kept. While a body
  decodes, its raw bytes are kept too (up to the size limit) for that fallback.
* **Send errors are classified.** `send_request` rejects with `{ kind, message,
  details }` (the core's `ExecError`; `kind` is `exec::ErrorKind`, and `SendError` in
  `src/lib/types.ts` is a union on it), unlike other commands, whose errors are strings.
  Kinds: `dns` (host), `refused` and `reset` (host, port), `tls` (reason: `selfSigned`,
  `expired`, `wrongHost`, `unknownIssuer`, `other`), `timeoutIdle` and `timeoutConnect`
  (timeoutMs), `invalidUrl` (url, reason), `unresolvedVariable` (names), `circularVariable` (chains, each
  a list of names), `file` (path,
  reason), and `other` (no details). The core owns `message` (the error chain for
  transport errors); the response viewer picks the heading and hint by kind
  (`src/lib/sendError.ts`) and always offers Retry. Before Retry, some kinds offer
  the fix (`sendErrorFix`): `tls` opens Settings scrolled to TLS (never a switch that
  turns verification off), the timeouts open the request's Settings, and
  `unresolvedVariable` opens the environment picker (as ⌘⌥E / Ctrl+Alt+E does). They ask through one-shot store
  fields (`settingsSection`, `requestSettingsFor`, `envPickerWanted`) that the
  component acting on them clears. DNS errors are recognised by the
  text of hyper-util's and reqwest's private resolver errors. The platform certificate
  verifiers don't agree on reasons (macOS reports a self-signed or expired certificate
  as an opaque code), so after a certificate rejection the core fetches the certificate
  once more with a handshake that records it and aborts, and checks it itself
  (`tls_probe.rs`). That probe connects directly, so it's skipped when reqwest would
  use a proxy for the URL (the same hyper-util matcher over HTTP_PROXY, HTTPS_PROXY,
  ALL_PROXY and NO_PROXY), and the reason stays the verifier's.
* **The Request tab shows the final hop.** After redirects, the core rebuilds the request
  that reached the final server with reqwest's rules: 301/302 turn a POST into a GET
  and 303 anything but HEAD, dropping the body and its Content-* headers; a hop to
  another origin leaves out Authorization, Cookie, Proxy-Authorization and
  WWW-Authenticate; and a Referer names the previous URL (not from https to http). It's
  labelled a reconstruction: headers reqwest adds itself aren't listed.
* **A response's kind is the core's call.** `HttpResponse.bodyKind` (`json`, `html`,
  `xml`, `image`, `pdf`, `media`, `text`, `binary`) comes from
  `body_format::response_kind`: the content type when it names one, else the body's
  first character. The viewer's views, highlighting and Save extension follow it, and
  the shell's Pretty text uses the same rule.
* **Download progress:** while a body downloads, the shell emits `send-progress`
  events (`{runId, received}`, raw bytes on the wire so far) for the in-flight send. The
  core reports at most once per 100 ms (`exec::PROGRESS_INTERVAL`) however small the
  chunks, and never after the send returns. The viewer shows the count next to the
  loading spinner; it goes away when the response completes, fails or is cancelled.
* **Auto Content-Type:** choosing a body mode sets the `Content-Type` header (an
  ordinary, visible header). It replaces a type HttpDesk itself sets for some mode but
  keeps a custom one, except that multipart always sets `multipart/form-data;
  boundary=…`. Switching to `none` removes the header only if it is the value HttpDesk
  set for the previous mode. At send time, a missing Content-Type is inferred for JSON,
  XML, text and form-urlencoded bodies.
* **Body mode `none`** means "no body". Text left in other modes is discarded on
  save. To keep a body without sending it, disable the body instead.
* **Form bodies** written one field per line are sent joined with `&`. `#` and `//` lines,
  `#~` disabled fields included, are skipped, as JetBrains and VS Code skip them, and so
  is an `&` in front of the first field sent.
* **Basic auth** is written as `Basic user password`, or `Basic user:password` when
  either part is empty. When the username contains whitespace, or the password has
  leading or trailing whitespace, it is written pre-encoded as `Basic <base64>`, because
  JetBrains and VS Code split the plain forms at the first whitespace. A value already in
  the file is kept as written while it carries the same credentials. The header that is
  sent is always built from the credentials, so `{{variables}}` resolve.
* **OpenAPI:**
  * Relative server URLs resolve against the spec URL (or `http://localhost`).
  * Each environment is named after the server description; a single server
    without a description is named `default`, and several are `server1`, `server2`, ….
  * Generated files start with a `# Generated by HttpDesk from "<title>" <version>`
    comment.
  * Existing files are never overwritten without confirmation: generation first
    runs dry, reports conflicts, and the UI asks before writing. The confirmation
    names open files with unsaved edits that would be replaced.
* **Settings** (timeouts, redirects, TLS, theme, layout, recent workspaces) are
  app metadata, stored in the OS config dir (`HTTPDESK_CONFIG_DIR` overrides it) and
  written atomically. Per-request overrides are standard directives in the file.
* **Theme** (System, Light or Dark): the page CSS defaults to dark, and the frontend
  applies the setting once it arrives over IPC. So that a light theme doesn't start
  dark, the shell creates the main window itself (`"create": false` in
  tauri.conf.json) after loading settings: with the window theme pinned for Light or
  Dark, a background colour matching `--bg`, and an init script that sets `data-theme`
  on `<html>` before the first paint (System resolved through `prefers-color-scheme`).
* **Release:** the release workflow runs on a `v*` tag push, or manually with an
  existing tag as input. A pre-flight job checks that the tag matches the version in
  every manifest (`scripts/check-release-version.mjs`) and runs the tests; the bundle
  jobs depend on it. Third-party actions are pinned to commit SHAs, and the frontend is
  built in its own step, which has no access to the update-signing key.

### Test strategy

| Layer | Tests |
|---|---|
| Format | `crates/httpdesk-core/tests/format.rs`: JetBrains and VS Code fixtures, byte-identical round-trip (LF, CRLF, BOM, no final newline), mixed line endings, item/section/auth/body enablement, API key, query escaping, field safety, edge cases |
| Execution | `tests/exec.rs`, against a wiremock server (and a hand-rolled trickle server for timeouts): disabled components are never sent, auth kinds, variables, JSON/form/multipart/file bodies, redirects, idle and connect timeouts, phase timings (fresh and reused connections, redirect chains), query encoding, send errors and their kinds (refused port, `.invalid` host, self-signed and expired certificates from an rcgen test server, a server that hangs up, timeouts, unresolved variables), custom methods, binary and text responses, content encodings (gzip, br, deflate, zstd, unsupported, bodies that fail to decode), transferred size, the final request after 302/303/307 and cross-origin redirects, the client pool (a second send reuses the connection; a client in use or with other settings isn't shared), rate-limited download progress, cookies set on redirect hops (recorded, never sent back), and a reused client listing only each request's own cookies. `src/cookies.rs` unit tests cover Set-Cookie attribute parsing. `tests/tls_behind_proxy.rs` (its own binary, as it sets proxy variables): behind a CONNECT proxy a rejected certificate isn't probed directly, and NO_PROXY exempts the host |
| OpenAPI | `tests/openapi.rs`: 3.0 YAML and 3.1 JSON fixtures, insta snapshots of generated files, grouping, selection, auth, env and secrets output, validation errors, external refs |
| Body formatting | `tests/body_format.rs`: tokens kept byte for byte (64-bit integers, `10.50`, `1e3`, `-0`, escapes, duplicate keys), nesting limit, invalid JSON, and a proptest that minify strips only insignificant whitespace and undoes pretty. `tests/xml_format.rs`: declaration, DOCTYPE, comments, CDATA, self-closing elements, mixed text kept as written, attributes containing `>`, minify, invalid XML. `tests/hexdump.rs`: line layout and the 64 KB preview limit. `tests/pretty_response.rs`: which responses get Pretty text (by content type, else the first character) |
| JSONPath filter | `tests/json_filter.rs`: filter selectors pick exactly the expected nodes; matched numbers, strings and escaped keys come back byte for byte; duplicate keys; exact number comparisons (19-digit ids, around 2^53, decimals and exponents); invalid expressions, bodies and too-deep bodies; the shape summary (keys merged across items, the key cap, computed once per document) |
| Env, vars, workspace | Unit tests in each module. `tests/resolution_parity.rs` runs the resolver (with env files loaded from disk) through the cases in `tests/fixtures/resolution-cases.json`, which `src/lib/vars.test.ts` runs the frontend resolver through too |
| IPC | `src-tauri/src/ipc_tests.rs` and `ipc_tests/`: the real command handlers invoked with frontend-shaped JSON through Tauri's mock runtime. Covers the full open → edit → toggle → send → save → reopen slice, Beautify saving exact numbers through `format_body`, XML through `format_body`, `hexdump` of a stored body by response id, filtering a sent response through `filter_response` and its shape summary through `response_shape`, Pretty text sent with a small response and fetched by response id for a large one (exact numbers, invalid and evicted bodies), environments, environment settings (production, colour) surviving a restart without touching the env files, OpenAPI generation, confinement, deleting, Windows paths, the file watcher (including self-write suppression), `send-progress` events for a trickled body, and a second send reusing the connection the first left open (the client pool) |
| Frontend | `src/lib/http.test.ts` (URL ⇄ params sync, base64 decoded length, form and multipart editors, body mode / Content-Type sync, directives, field checks), `src/lib/store.test.ts` (the store against a mocked backend), `src/lib/suggest.test.ts` (header-name suggestion matching), `src/lib/vars.test.ts` (what hovering a reference shows, where its Edit goes, what autocomplete offers, and a VarField's static rendering marking `{{variables}}` by state), `src/lib/sendError.test.ts` (send error headings, hints and fix-it buttons by kind), `src/lib/headers.test.ts` (response header filter, Copy all text, well-known header explanations), `src/lib/status.test.ts` (status code explanations for the status pill's tooltip), `src/lib/jsonpath.test.ts` (filter key completion from a shape, and Copy path: the path at a caret, quoting keys for both RFC 9535 and Jayway), `src/lib/cookies.test.ts` (the Cookies tab's expiry wording), `src/lib/panes.test.ts` (pane defaults agree with the Rust shell's), `src/lib/envColors.test.ts` (each environment colour's light and dark shade keeps 3:1 contrast against the top bar), `src/lib/popup/place.test.ts` (popup placement: flipping and clamping to the viewport) and `src/lib/popup/tooltip.test.ts` (a tooltip's `aria-describedby` link). `src/guardrail/native-widgets.test.ts` fails on any native form widget or `title=` tooltip in the app's sources ([controls.md](controls.md)) |
| Browser | `e2e/*.spec.ts`: Playwright drives the real UI in Chromium, served by Vite with the mocked backend (`src/dev/mock.ts`) |
| Release | `scripts/check-release-version.test.ts` |
| Visual | `pnpm dev` in a browser with the mocked backend (`src/dev/mock.ts`); in the three OS webviews, the [manual OS rendering check](os-checklist.md) |

### Known gaps / next steps

* No cookie jar; responses' `Set-Cookie` is not replayed. The response viewer's Cookies
  tab lists them (redirect hops included), but a recording store that never returns a
  cookie is all reqwest gets.
* Scripts (`< {% %}`, `> {% %}`) are preserved but not executed (out of scope).
* Request-to-request variables (`{{login.response.body.token}}`) are not supported.
* A Basic auth username containing `:` can't be represented (RFC 7617), so saving one is
  refused with an error, and the auth editor flags it inline.
* A description line typed as `@word` comes back as `@ word` after a save (§2).
* On macOS, a logout or shutdown (unlike ⌘Q) relies on the unsaved flag the frontend
  reports, so it isn't blocked when nothing is unsaved; a flag that never arrived would
  let it through without asking.
* No code signing or notarization in the release workflow.
