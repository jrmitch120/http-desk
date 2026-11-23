# Disabled form fields stay in the body; disabled multipart parts move to the header area

A disabled form-urlencoded field is written in place in the body as a `#~` line (`#~ &name=value`, or `#~ name=value` on the first line). The first field that is sent never starts with `&`. A disabled multipart part is written in the header area, one `#~=` line per line of the part with its `--boundary` line included. HttpDesk reads those lines back into the body text, before the closing boundary, as `#~` lines, so the structured editors see every disabled row inline. When the whole body is disabled, the body text is written as `#~|` lines as before, and a disabled part nested in it becomes `#~| #~ …`. Turning the body back on brings back each field's own state.

We chose this from the JetBrains HTTP Client CLI results in [research/http-comment-compat.md](../research/http-comment-compat.md), Appendix C, together with VS Code REST Client's source, which removes every `#` and `//` line before sending:

- JetBrains drops `#` and `//` lines from a form body, so a field commented out in place is never sent and keeps its position on reload. JetBrains sends an empty body if the first line it sends starts with `&`, so that line is written without one.
- JetBrains treats every line after a multipart boundary as part content, comments included, so a part commented out in place would be sent inside the part before it. In the header area, `#~` lines are never sent (Appendix B, Cases E, G and H).

The cost is the same as for disabled query params: on reload, disabled parts come after the enabled ones, in their original relative order. The marker can't collide with a disabled header: those are written `#~ Name: value`, with a space after the tildes.

## Considered options

- **Comment out disabled multipart parts in place.** Rejected: JetBrains sends them as content of the previous part (Appendix C, M1, M3, M5, M6).
- **Write disabled form fields in the header area too, like multipart parts.** Rejected: in-place `#~` lines are safe in both clients, keep the field's position, and read naturally where the field was.
- **Track disabled fields in a new `@httpdesk-*` directive.** Rejected: it adds metadata other editors can't read, and the values would have to be stored somewhere anyway.

## Addendum: `#~` in any other body is a comment line, and is sent (#186)

A `#~` line turns something off only where this ADR says it does: a field in a form-urlencoded body, a line of a multipart part (unindented, as HttpDesk drops it when sending), and the header area. In a JSON, XML, text or raw body it is a comment line like any `#` or `//` line, and HttpDesk sends it as written, as Rider does. HttpDesk doesn't drop comment lines from those bodies: they can be real content (GraphQL `#` comments, Markdown headings, `//` in JavaScript-like text).

VS Code drops every comment line, and Rider drops one written on the body's first line (Appendix C, G4 and G6), so the portability pass notes these lines instead of changing what's sent: a comment line on a body's first line is noted as `body-comment-first-line` (both editors drop it), and any later one in those bodies, or a `#` or `//` line in a multipart body, as `body-comment` (VS Code drops it). A form's comment lines get no note: every tool drops them.
