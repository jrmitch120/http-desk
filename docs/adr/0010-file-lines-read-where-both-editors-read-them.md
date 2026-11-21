# File lines are read where both editors read them, with VS Code's bytes

HttpDesk used to read a body from a file only for a Whole-file body or the File lines of a multipart body. Any other `< path` line was sent as text, but trimmed `<path` and indented `< path` lines counted as files. Both VS Code REST Client and Rider do the opposite on each point ([research/body-file-lines.md](../research/body-file-lines.md), #176). The same file therefore sent three different bodies. We now read a File line wherever it sits in a body. Where both editors agree, we follow them. Where they disagree, we choose:

- **What is a File line:** `<` or `<@` at column 0, followed by a space or a tab. Both editors send `<path` and an indented `< path` as text, and so does HttpDesk now. Trailing whitespace after the path is trimmed (VS Code; Rider fails the request). The editor warns that such a line is sent as text (`not-a-file-line`) only in a body of that one line or a multipart body, the only bodies the old rule read files from, where the line used to send a file. Elsewhere it never did, and warning there would flag content such as a multi-line XML start tag (`<soap:Envelope`).
- **Splicing (VS Code):** the line is replaced by the file's content, and its line breaks stay (`before\n` + file + `\nafter`). The break is `\n`, as in the rest of a text body. Rider drops the newlines and blank lines next to the line, which can't be predicted by reading the file.
- **Variables inside a `< path` file (VS Code):** not substituted; the bytes are sent raw, so binary files arrive intact. `<@ path` is the way to fill them in. Rider substitutes them.
- **`<@ path` (VS Code):** read and substituted wherever it sits. Rider sends the line as text.
- **A missing file (Rider):** an error in the editor, and the send is blocked, as for a Whole-file body before. VS Code silently sends the line as text instead.
- **A form body with a File line (VS Code):** sent like a text body, with lines separated by `\n` and no `&` joining. Its `#`, `//` and `#~` lines are skipped, as in any form body (ADR 0003), so a disabled field isn't sent. VS Code removes every `#` and `//` line of a request before it reads the body: `src/utils/selector.ts` L66 (`lines.filter(l => !this.isCommentLine(l))`), with `CommentIdentifiersRegex = /^\s*(#|\/{2})/` in `src/common/constants.ts` L69, at the commit the research pins. Rider wasn't measured.

The browser dev mock (`src/dev/mock.ts`) can't splice File lines: it has no file contents, so it sends the body as written. Story 28 of #176 (the dev mock sending File lines by the same rule) is left open for sending.

The portability table marks a File line in a body with other lines as `VscodeOnly` (Rider's bytes differ). It keeps the Whole-file `< file` row `Portable`, with a note that Rider also fills in variables in the file.

## Considered options

- **Keep sending a File line in a body with other lines as text, and mark it.** Rejected: HttpDesk would be the only tool that sends the line as text, against ADR 0007's principle of running what users' files already contain.
- **Rider's splicing (no newlines around the file).** Rejected: dropping blank lines next to the line surprises anyone reading the file, and VS Code's result is what the text shows.
- **Keep accepting `<path` and indented `< path` as files.** Rejected: neither editor reads them, so such a file only ever worked in HttpDesk.
- **Substitute variables in `< path` files, as Rider does.** Rejected: it would corrupt binary files, and `<@` already exists for substitution.
- **Splice the file into a form body, then join with `&`.** Rejected: neither editor is known to do it, so it would be HttpDesk's own semantics.
- **Send a form's comment and `#~` lines once it has a File line, as a text body does.** Rejected: VS Code drops them, and a field disabled with `#~` would start being sent.
