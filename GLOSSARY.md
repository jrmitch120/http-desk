# HttpDesk

A desktop HTTP client whose collection is a folder of plain `.http` files, editable
both in HttpDesk and in JetBrains / VS Code.

## Language

### Variables

**File variable**:
An `@name = value` line anywhere in a `.http` file; every request in that file can use it.
Where it's written is only placement. A request's own declaration wins over a same-named one elsewhere in the file.
_Avoid_: in-place variable

**Request variable**:
A `{{name.response…}}` or `{{name.request…}}` reference to the latest exchange of the request named `# @name name` in the same file.
It is VS Code REST Client syntax; Rider refuses to send a request that contains one.
_Avoid_: response reference, chained variable

**Global variable**:
A value a script stores with `client.global.set`, which later requests in the workspace can use as `{{name}}`.
It lasts as long as the Session.
_Avoid_: session variable, client variable

**Secret**:
An environment variable whose value lives only in the private environment file, which is kept out of version control.
The shared environment file holds at most an empty placeholder for it, never the value.
_Avoid_: private variable, credential

**Undefined variable**:
A `{{name}}` reference with no definition in scope: not in the request, the file, the Global variables, the selected environment or the shared variables, and, for `{{name.response…}}`, no `# @name name` in the file.
A circular reference, an unanswered Prompt variable, and a Request variable whose request hasn't been sent or whose path matches nothing in its exchange are reported separately, not as undefined.
_Avoid_: unresolved variable, missing variable

**Circular reference**:
A `{{name}}` whose value leads back to a name already being resolved, such as `a → b → a`, or a request's `@host = {{host}}/v2`.
It is reported with the chain followed, never as an Undefined variable.
_Avoid_: cycle, recursive variable

**Prompt variable**:
A variable declared with `# @prompt name [description]` whose value the user types when sending the request.
It overrides any other variable of the same name, and its value is never written to disk.
_Avoid_: input variable, ask variable

**Production environment**:
An environment the user has marked as production: sending anything but GET, HEAD or OPTIONS with it selected asks for confirmation first.
The mark is an app setting, not part of the env files.
_Avoid_: live environment, protected environment

### Bodies

**File line**:
A body line `< path` or `<@ path` that stands for a file's content, read when the request is sent; `<@` also fills in the `{{variables}}` in that content.
It starts at the beginning of the line, and whitespace follows the `<` or `<@`: `<path` and an indented `< path` are body text.
_Avoid_: file reference, body file line, input file

**Whole-file body**:
A body that is a single File line.
_Avoid_: file body, file mode

### Sending

**Exchange**:
One send: the request exactly as it went out, and the response or error that came back.
_Avoid_: call, transaction

**History**:
The Exchanges HttpDesk has recorded for a workspace, newest first, kept on disk outside the workspace so they are never committed or shared.
Only sends the user makes from a tab are recorded; a Run's sends and requests marked `# @no-log` are not, and nothing is while the **History switch** (one app setting, on by default) is off. One item is a **History entry**.
_Avoid_: log, request log

**Session**:
What HttpDesk remembers about a workspace from one send to the next: the latest exchange of each named request, Global variables, cookies and prompt answers.
It lives in memory until the workspace is closed or HttpDesk quits, and is never written to disk.
_Avoid_: context, state

**Trusted workspace**:
A workspace the user has allowed to run scripts. The choice is kept in HttpDesk's settings, never in the workspace, so a cloned repository can't trust itself.
_Avoid_: safe workspace, allowed workspace

**Run**:
Sending a selection of requests (a file, a folder, or chosen requests) in order, with the Session carried from each to the next.
A request in a run fails on a network error, a script error, a failed test or a blocked send; an error status alone is not a failure.
_Avoid_: batch, collection run

### Portability

**Portability note**:
A mark on a line of a `.http` file that behaves differently in VS Code or in Rider than in HttpDesk.
Notes for an editor show only while the user has that editor turned on in Settings → Portability (one app setting per editor, both off by default); the user's choice says which editors they share files with.
_Avoid_: portability marker, compatibility warning, editor mark

**HttpDesk-only line**:
A line only HttpDesk reads, which both VS Code and Rider ignore: a description, a turned-off section, API key auth.
It is shaded, not noted, and only while either editor is turned on.
_Avoid_: HttpDesk's own line, private directive

### Editing

**Layout**:
How the user left a workspace: its open tabs in order, the active tab, each tab's request section and response view, and which folders are expanded.
It is kept per workspace and comes back when the workspace reopens; pane sizes are an app setting, not part of it.
_Avoid_: session, workbench, restore state

**Response position**:
Where a request tab shows the response beside the request: on the right or below.
It is one app setting for every workspace, not part of a workspace's Layout.
_Avoid_: response layout, orientation, layout

**Settings category**:
One of the six groups of app settings in the Settings window (General, Requests, TLS, Portability, History, Trusted workspaces), each a tab in its rail with a page of its own.
Settings opens on the one last shown during this run unless a link names another; a request tab's Settings section is a different thing, the request's own settings.
_Avoid_: section, settings page, settings tab

**File view**:
A tab showing a whole `.http` file as one editable text: file variables, comments between requests and every request together.
It and the file's request tabs edit the same document, so each shows the other's edits; text that doesn't parse leaves the document as it last read.
While its text doesn't parse, the file's request tabs are read-only and say why; while a request's Source view holds text that doesn't parse, the file view and the rest of that request's tab are. Either way nothing else may change what the text stands for: actions such as Rename request or Rename variable are refused, saying why, until it parses, is saved as written or is reverted.
_Avoid_: file tab, raw view, file source

**Orphaned tab**:
An open tab whose request no longer exists in the file on disk (the file was deleted, or the request was changed beyond recognition by another editor).
It keeps the user's edits and last response, and saving writes the request back into the file.
_Avoid_: stale tab, dead tab
