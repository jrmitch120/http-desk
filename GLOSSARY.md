# HttpDesk

A desktop HTTP client whose collection is a folder of plain `.http` files, editable
both in HttpDesk and in JetBrains / VS Code.

## Language

### Variables

**File variable**:
An `@name = value` line anywhere in a `.http` file; every request in that file can use it.
Where it's written is only placement. A request's own declaration wins over a same-named one elsewhere in the file.
_Avoid_: request variable, in-place variable

**Secret**:
An environment variable whose value lives only in the private environment file, which is kept out of version control.
The shared environment file holds at most an empty placeholder for it, never the value.
_Avoid_: private variable, credential

**Undefined variable**:
A `{{name}}` reference with no definition in scope: not in the request, the file, the selected environment or the shared variables.
A circular reference and an unanswered Prompt variable are reported separately, not as undefined.
_Avoid_: unresolved variable, missing variable

**Prompt variable**:
A variable declared with `# @prompt name [description]` whose value the user types when sending the request.
It overrides any other variable of the same name, and its value is never saved.
_Avoid_: input variable, ask variable

**Production environment**:
An environment the user has marked as production: sending anything but GET, HEAD or OPTIONS with it selected asks for confirmation first.
The mark is an app setting, not part of the env files.
_Avoid_: live environment, protected environment

### Editing

**Orphaned tab**:
An open tab whose request no longer exists in the file on disk (the file was deleted, or the request was changed beyond recognition by another editor).
It keeps the user's edits and last response, and saving writes the request back into the file.
_Avoid_: stale tab, dead tab
