# `< path` and `<@ path` body lines: JetBrains HTTP Client vs VS Code REST Client

Research for the portability table's `body-file` and `body-file-with-variables` rows
(`crates/httpdesk-text/src/portability.rs`) and for how HttpDesk's own parser and
sender read a body's file lines (`file_reference` and the body-file rule in
`crates/httpdesk-text/src/parser.rs`). The question: what does each tool do with a
`< path` line depending on where it sits in the body? This file records facts only.
It does not propose a design.

## Sources read (versions)

| Source | Version / commit | Notes |
|---|---|---|
| VS Code REST Client `Huachao/vscode-restclient` | commit `0773d56b65d9e7033259519e99eef8f752f6ba6e` (the one `portability.rs` pins) | Source read, not run. |
| JetBrains spec `JetBrains/http-request-in-editor-spec` `spec.md` | commit `ad743118c2f4edfbffea13863921cf6296198852` | Grammar only; old. |
| JetBrains docs (IntelliJ IDEA 2026.3 Help): exploring-http-syntax, http-client-variables, http-client-in-product-code-editor, http-client-reference | read 2026-11-19 | |
| JetBrains YouTrack IDEA-239584, IJPL-66240 | read 2026-11-19 | Bug reports and staff comments, not spec. |
| JetBrains HTTP Client CLI, Docker image `jetbrains/intellij-http-client` | *IntelliJ HTTP Client 2026.3, Build 263.7307.200*, digest `sha256:4afde15abef4a712e407d0d4a83b9a1dd557dffa3fc203bd8d943d609ef5c3d6` | Run 2026-11-19 against a local echo server logging the raw body. |

Permalink bases used below:

- REST Client: `https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/`
- Spec: `https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md`

Limits:

- JetBrains' parser is closed source. Its behaviour below is measured on the CLI, not
  in the Rider editor.
- REST Client was read, not run.

## Summary

| | REST Client | JetBrains |
|---|---|---|
| A `< path` line among other body lines | Replaced by the file's content; a line ending is kept on each side | Replaced by the file's content; the newlines (and blank lines) next to it are dropped |
| Whitespace after `<` | Required (`\s+`; a tab counts) | Required; only a space worked (a tab was sent as text) |
| Indented `< path` | Text (the pattern is anchored at column 0) | Text, indent kept |
| `<path` (no space) | Text | Text |
| `<@ path`, `<@enc path` | File read as text, `{{variables}}` in it substituted | Sent as literal text, no error |
| `{{variables}}` inside a plain `< path` file | Not substituted (raw bytes) | Substituted |
| Missing file | The line is sent as literal text, no error | The request isn't sent |
| Trailing whitespace on the line | Trimmed | The request failed |
| Multipart parts | `< path` lines read | `< path` lines read (the CLI rebuilds the multipart body) |

Neither tool restricts file reading to a body that is one `< path` line.

## 1. REST Client: a file line among other lines is spliced

`src/utils/httpRequestParser.ts`, `parseBody`. If any line matches the pattern, every
matching line is replaced by its file and the others are appended as text:

```ts
179        if (lines.every(line => !this.inputFileSyntax.test(line))) {
...            // plain text body
193        } else {
194            const combinedStream = CombinedStream.create({ maxDataSize: 10 * 1024 * 1024 });
195            for (const [index, line] of lines.entries()) {
196                if (this.inputFileSyntax.test(line)) {
...
203                            if (groupsValues.processVariables) {
204                                const buffer = await fs.readFile(fileAbsolutePath);
205                                const fileContent = buffer.toString((groupsValues.encoding || this.defaultFileEncoding) as BufferEncoding);
206                                const resolvedContent = await VariableProcessor.processRawRequest(fileContent);
207                                combinedStream.append(resolvedContent);
208                            } else {
209                                combinedStream.append(fs.createReadStream(fileAbsolutePath));
210                            }
211                        } else {
212                            combinedStream.append(line);
213                        }
...
215                } else {
216                    combinedStream.append(line);
217                }
218
219                if ((index !== lines.length - 1) || MimeUtility.isMultiPartFormData(contentTypeHeader)) {
220                    combinedStream.append(this.getLineEnding(contentTypeHeader));
221                }
```

- A line ending goes between all lines (the OS's, or `\r\n` for multipart), so
  `before` / `< ./f.txt` / `after` is sent as `before` EOL file-content EOL `after`.
- A file that can't be found leaves its line as literal text (L211-213).
- The README shows only the whole-body form and the multipart form ("You can also
  specify file path to use as a body, which starts with `< `"). Splicing in a body
  that isn't multipart is in the source only.

## 2. REST Client: the pattern

`src/utils/httpRequestParser.ts` L26:

```ts
private readonly inputFileSyntax = /^<(?:(?<processVariables>@)(?<encoding>\w+)?)?\s+(?<filepath>.+?)\s*$/;
```

- Whitespace after `<` is required: `<./file` is text.
- Anchored at `^<`, and body lines are kept untrimmed, so an indented line is text
  (read from the pattern, not run).
- Trailing whitespace is dropped from the path.
- `<@ path` reads the file as text and substitutes `{{variables}}` in it; `<@latin1 path`
  does so in that encoding (the encoding is glued to `@`). README: "you'll have to use
  an `@` to ensure variables are processed when referencing a file (UTF-8 is assumed as
  the default encoding)".
- Plain `< path` streams the file's bytes, nothing substituted.

## 3. JetBrains: spliced too, with the surrounding newlines dropped

Grammar (spec §3.2.3):

> _message-body:_ _messages_ | _multipart-form-data_
> _messages:_ _message-line [ new-line message-line ]_
> _message-line:_ _(any input-character except ‘< ’, ’<> ’ and ‘###’) line-tail_ | _input-file-ref_
> _input-file-ref:_ _‘<’ required-whitespace file-path_

A message line is text or a file reference, so the grammar allows mixing. The help
page (`exploring-http-syntax.html#provide-request-body`) shows only the whole-body
example `< ./input.json`; no page read mixes text and a file line outside multipart.
`<@` appears nowhere in the help pages or the spec.

Measured on the CLI (`f.txt` is `FILE-L1\nFILE-L2`, no trailing newline; `v.txt` is
`hello {{who}} end`; `@who = WORLD`; `Content-Type: text/plain` unless noted):

| Case | Body in the `.http` file | Bytes the server received |
|---|---|---|
| A | `< ./f.txt` | `FILE-L1\nFILE-L2` |
| B | `before` / `< ./f.txt` / `after` | `beforeFILE-L1\nFILE-L2after` |
| O3 | `before` / blank / `< ./f.txt` / blank / `after` | `beforeFILE-L1\nFILE-L2after` |
| L | `< ./f.txt` / `tail text` (JSON content type) | `FILE-L1\nFILE-L2tail text` |
| O2 | `< ./f.txt` / `< ./f.txt` | `FILE-L1\nFILE-L2FILE-L1\nFILE-L2` |
| C | `<./f.txt` | literal `<./f.txt` |
| J | `before` / `<./f.txt` / `after` | literal `before\n<./f.txt\nafter` |
| N | `<` TAB `./f.txt` | literal `<\t./f.txt` |
| E | `   < ./f.txt` (indented) | literal, indent kept |
| D | `<@ ./v.txt` | literal `<@ ./v.txt` |
| K | `<@latin1 ./v.txt` | literal `<@latin1 ./v.txt` |
| F | `< ./v.txt` | `hello WORLD end` |
| G | `< ./nope.txt` | nothing sent: "Failed to construct a request" |
| M | `before` / `< ./nope.txt` / `after` | nothing sent: same failure |
| I | `< ./{{name}}.txt` with `@name = f` | nothing sent: same failure |
| O1 | `< ./f.txt` plus three trailing spaces | nothing sent: same failure |

The CLI printed only "Failed to construct a request" for the last four. That I fails
because the path's variable isn't substituted, and O1 because the trailing spaces
stay in the path, are inferences.

## 4. Multipart

- REST Client: the same loop runs; its only special-casing is the line ending. The
  README shows `< ./1.png` in a part.
- JetBrains: spec §4.3, "Multipart form body part can be sent either as a file or as a
  plain string body. Which one to use is regulated by the ‘filename’ option in the body
  part header." Measured: a part with `filename="f.txt"` and `< ./f.txt` arrived with
  the file's bytes. The CLI rebuilt the body with its own boundary, lower-cased part
  headers and a `content-length` per part.
- Not tested: a `< path` in a part without `filename`.

## 5. Other differences

| Topic | REST Client | JetBrains |
|---|---|---|
| Variables in the path | Substituted (inferred: the whole request text goes through `VariableProcessor.processRawRequest` before parsing, `src/utils/selector.ts` L75) | The request failed on the CLI (case I) |
| Path base | Absolute; else the workspace root, then the `.http` file's folder (`src/utils/requestParserUtil.ts` L41-63) | Beside the `.http` file on the CLI, which was also its working directory, so the two weren't told apart |
| Encoding of a substituted file | UTF-8 unless `<@enc` | IJPL-66240 (open): "the body file is read with the JVM default charset" |

## What HttpDesk does today

- The parser and sender read a body from a file only when the body is one `< path`
  line, or for the `< path` lines of a multipart body. In any other body a `< path`
  line is sent as text, where both tools above send the file.
- `file_reference` trims the line and takes `<path` without a space, so an indented
  `< path` and `<path` are files in HttpDesk and text in both tools.
- The portability pass marks every body line `file_reference` accepts, wherever it is.
- The `body-file` row says "Both editors send this file's content". That holds for a
  `< path` line at column 0 with a space, with three differences it doesn't mention:
  variables inside the file (JetBrains substitutes, REST Client doesn't), the newlines
  around a file line in a mixed body, and a missing file.
- The `body-file-with-variables` row says "Rider documents only < file". Measured,
  JetBrains sends a `<@ path` line as literal body text.
