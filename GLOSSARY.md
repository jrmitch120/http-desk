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

### Editing

**Orphaned tab**:
An open tab whose request no longer exists in the file on disk (the file was deleted, or the request was changed beyond recognition by another editor).
It keeps the user's edits and last response, and saving writes the request back into the file.
_Avoid_: stale tab, dead tab
