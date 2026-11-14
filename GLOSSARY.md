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

### Sending

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

### Editing

**Orphaned tab**:
An open tab whose request no longer exists in the file on disk (the file was deleted, or the request was changed beyond recognition by another editor).
It keeps the user's edits and last response, and saving writes the request back into the file.
_Avoid_: stale tab, dead tab
