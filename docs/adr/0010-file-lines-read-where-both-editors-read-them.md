# File lines are read where both editors read them, with VS Code's bytes

HttpDesk used to read a body from a file only for a Whole-file body or the File lines of a multipart body. Any other `< path` line was sent as text, but trimmed `<path` and indented `< path` lines counted as files. Both VS Code REST Client and Rider do the opposite on each point ([research/body-file-lines.md](../research/body-file-lines.md), #176). The same file therefore sent three different bodies. We now read a File line wherever it sits in a body. Where both editors agree, we follow them. Where they disagree, we choose:

- **What is a File line:** `<` or `<@` at column 0, followed by a space or a tab. Both editors send `<path` and an indented `< path` as text, and so does HttpDesk now; the editor warns on such lines that they are sent as text. Trailing whitespace after the path is trimmed (VS Code; Rider fails the request).
- **Splicing (VS Code):** the line is replaced by the file's content, and its line breaks stay (`before\n` + file + `\nafter`). The break is `\n`, as in the rest of a text body. Rider drops the newlines and blank lines next to the line, which can't be predicted by reading the file.
- **Variables inside a `< path` file (VS Code):** not substituted; the bytes are sent raw, so binary files arrive intact. `<@ path` is the way to fill them in. Rider substitutes them.
- **`<@ path` (VS Code):** read and substituted wherever it sits. Rider sends the line as text.
- **A missing file (Rider):** an error in the editor, and the send is blocked, as for a Whole-file body before. VS Code silently sends the line as text instead.
- **A form body with a File line (VS Code):** sent like a text body, with lines separated by `\n` and no `&` joining. Rider wasn't measured.

The portability table marks a File line in a body with other lines as `VscodeOnly` (Rider's bytes differ). It keeps the Whole-file `< file` row `Portable`, with a note that Rider also fills in variables in the file.

## Considered options

- **Keep sending a File line in a body with other lines as text, and mark it.** Rejected: HttpDesk would be the only tool that sends the line as text, against ADR 0007's principle of running what users' files already contain.
- **Rider's splicing (no newlines around the file).** Rejected: dropping blank lines next to the line surprises anyone reading the file, and VS Code's result is what the text shows.
- **Keep accepting `<path` and indented `< path` as files.** Rejected: neither editor reads them, so such a file only ever worked in HttpDesk.
- **Substitute variables in `< path` files, as Rider does.** Rejected: it would corrupt binary files, and `<@` already exists for substitution.
- **Splice the file into a form body, then join with `&`.** Rejected: neither editor is known to do it, so it would be HttpDesk's own semantics.
