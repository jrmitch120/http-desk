# Query values: escape structure in the file, encode the rest at send

The params table shows decoded values. When writing the `.http` file, HttpDesk percent-escapes only the characters that would change the query's structure on reload (`&` and `#` in values, `=` and `&` in names, `%` when it would otherwise read as an escape, whitespace) and leaves everything else readable. At send time it percent-encodes whatever is still unencoded, including values substituted from variables, and never double-encodes an existing `%XX` escape. A request carrying `# @no-auto-encoding` is sent exactly as written.

We chose this because JetBrains HTTP Client behaves the same way (it auto-encodes at send unless `@no-auto-encoding` is present, and leaves `%XX` alone), so files stay readable, diff cleanly, and send identically from both tools. Storing the file fully encoded would make hand-edited files unreadable; storing it fully raw cannot round-trip a value containing `&`.

## Considered options

- **File holds exactly what was typed; the table warns about breaking characters.** Rejected: values containing `&` or `#` cannot survive a reload, and variable values containing them break the URL at send.
- **File holds fully percent-encoded values.** Rejected: unreadable in other editors and noisy in diffs, for no gain over encoding at send.
