# Comment and `# @tag` compatibility: JetBrains HTTP Client vs VS Code REST Client

Research for storing per-query-parameter and per-header documentation in `.http`
comments without breaking either tool. This file records facts only. It does not
propose a design.

## Sources read (versions)

| Source | Version / commit | Notes |
|---|---|---|
| JetBrains spec `JetBrains/http-request-in-editor-spec` `spec.md` | commit `ad743118c2f4edfbffea13863921cf6296198852` (2023-05-30, latest on `master`) | Old. It does not cover `# @` tags. |
| JetBrains docs (IntelliJ IDEA 2026.2 Help): [exploring-http-syntax](https://www.jetbrains.com/help/idea/exploring-http-syntax.html), [http-client-in-product-code-editor](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html), [http-client-variables](https://www.jetbrains.com/help/idea/http-client-variables.html) | page stamped "13 February 2026", "IntelliJ IDEA 2026.2 Help" | Read through the `.html.md` markdown variants listed in `https://www.jetbrains.com/help/idea/llms.txt`. |
| JetBrains HTTP Client plugin binary (closed source) | `restClient.jar` bundled with JetBrains Rider 2026.2, build `262.8665.328` (`~/Applications/Rider.app/Contents/plugins/restClient/lib/restClient.jar`) | Static inspection only: class/resource names and constant-pool strings. Nothing was executed. |
| JetBrains YouTrack (first-party issue tracker) | read through `https://youtrack.jetbrains.com/api/issues/...` on 2026-11-04 | These are bug reports and staff comments. They tell you how the tool behaved in the affected version, not what the current spec says. |
| VS Code REST Client `Huachao/vscode-restclient` | commit `0773d56b65d9e7033259519e99eef8f752f6ba6e` (2026-01-30, `master`), `package.json` version `0.26.0` | Source is authoritative here and is preferred over the README. |

Permalink bases used below:

- Spec: `https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md`
- REST Client: `https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/`

**Limitation:** JetBrains' HTTP Client is closed source, so its parser could not be read.
I tried to confirm JetBrains behaviour by running the official HTTP Client CLI (`ijhttp`,
`https://jb.gg/ijhttp/latest`) against a local echo server. The environment's permission
policy blocked running the downloaded binary. JetBrains verdicts below therefore rest on
the spec, the docs, static inspection of the plugin jar, and YouTrack. Where those leave a
question open, it is marked **Unknown**. Appendix A has a ready-made test file for
confirming these verdicts later.

---

## Summary of verdicts

Legend: **Safe**: documented or verified in source, no effect on the sent request. **Risky**: evidence of breakage or conflicting evidence. **Unknown**: sources are silent.

| # | Question | JetBrains HTTP Client | VS Code REST Client |
|---|---|---|---|
| 1a | `#` / `//` comment between `###` and the method line | **Safe**. Spec §2.4 ("before or after a request"), docs examples. | **Safe**. These lines are parsed for metadata, then stripped (`selector.ts` L66, L83-113). |
| 1b | Comment between header lines | **Safe, verified** (Case C, F): headers on both sides of the comment arrive. | **Safe**. All comment lines are removed before header parsing (`selector.ts` L66). |
| 1c | Comment between multi-line query continuation lines | **Breaks, verified**. A column-0 comment ends the query, the next `&` line is parsed as a header and the request fails (Case B). An indented comment is pasted into the URL (Case B2). | **Safe**. The line is removed before the URL lines are joined (`selector.ts` L66, `httpRequestParser.ts` L46-59, L76). |
| 1d | Comment inside body | **Sent as body content, verified** (Case D). This differs from VS Code, so the two tools send different bodies. | **Stripped, never sent**. Any line matching `^\s*(#\|//)` is removed, including body lines (`selector.ts` L66, `constants.ts` L69). |
| 2 | Unrecognised `# @foo …` above the request line | **Harmless, verified** (Case A, E, H): the request is sent unchanged and the CLI prints no warning. Editor inspections are not covered by the CLI run. | **Silently ignored**. `fromString()` returns `undefined` and the line is skipped (`selector.ts` L96-110, `requestMetadata.ts` L26-30). |
| 2 | Recognised tags | `@name`, `@no-redirect`, `@no-log`, `@no-cookie-jar`, `@no-auto-encoding`, `@timeout`, `@connection-timeout`, `@use-os-credentials`. Also `### text` gives a request name. | `@name`, `@note`, `@no-redirect`, `@no-cookie-jar`, `@prompt`. Matching is case-insensitive. |
| 3a | `GET /x` / `# doc` / `&limit=5` | **Breaks, verified** (Case B, B2). See 1c. | **Joins correctly** to `/x&limit=5` (the comment is removed first). |
| 3b | Comment between two header lines | **Safe, verified** (Case C). | **Safe**. It does not end the header section, because the line is gone before the state machine runs. |
| 4 | Existing conventions for per-param/header docs | **None found.** Reserved or special prefixes: `###` (separator; any text after it is the request name), `# @<tag>`, `//TIP` (onboarding inline docs, apparently limited to bundled example files), `TODO` comments (TODO index). | **None found.** Special prefixes: `###…` (delimiter), `# @<tag>` / `// @<tag>`, bare `@var = value` (file variable). |
| 5 | Comments before the first `###` | **Allowed** (spec §3.1, §2.4). | **Allowed**. A comment-only block before the first `###` produces no request (`selector.ts` L115-158). |
| 5 | `### text` | **Request name** (docs, YouTrack staff comment). The spec still calls it a "comment". | **Delimiter only**. Text after `###` is ignored (`selector.ts` L240-244). |

---

## Q1. Where are `#` and `//` comment lines allowed?

### JetBrains

- **Spec §2.4 Comments** ([spec.md L99-112](https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md#24-comments)): "Line comments are supported in HTTP Requests. Comments can be used before or after a request, inside the header section, or within the request body. Comments used within the request body must start from the beginning of the line with or without indent." The grammar is `line-comment: '#' line-tail | '//' line-tail`.
- **Spec §3.2.1.4 Query** ([L287-291](https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md#3214-query-and-fragment)): `query: (any input-character except '#')* [new-line-with-indent query]`. A query continues only on *indented* new lines, and `#` ends the query and starts the fragment. The spec lists no comment production inside the request line or target. §2.4 names the places where comments may go ("before or after a request, inside the header section, or within the request body"), and the request line / query is not one of them.
- **Docs**: "Within a request, start any line with // or # to make it a comment line." ([exploring-http-syntax, "Use comments in HTTP requests"](https://www.jetbrains.com/help/idea/exploring-http-syntax.html)). "After the `###` separator, you can enter any comments preceded by `#` or `//`." ([http-client-in-product-code-editor](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html)). The docs' multipart example puts `// The 'input.txt' file will be uploaded` lines *inside* the multipart body. That implies they are treated as comments there, but the docs do not say whether they are sent.
- **Docs, query continuation**: "Break long requests into several lines. Indent all query string lines but the first one." The example uses indented `?id=123` / `&value=content` lines ([exploring-http-syntax](https://www.jetbrains.com/help/idea/exploring-http-syntax.html)). The docs show no comment between continuation lines.
- **Query continuation comments**: [IJPL-66728 "Support query params commenting"](https://youtrack.jetbrains.com/issue/IJPL-66728) (created 2023-07-24, **Open**). The attached screenshot shows `GET localhost:8080/v2/accounts/?` / `    currency=USD&` / `#    curr2=EUR` / `Authorization: …`. The trailing `&` before the comment line has a red error underline. This is a request for the feature, which implies comments inside the query block are not supported.
- **Body comments: conflicting first-party evidence.**
  - [IJPL-67336 "HTTP Client: comment is sent in the request along with the body"](https://youtrack.jetbrains.com/issue/IJPL-67336) (affected 2022.2.1, **Open**): a comment after the body "will be treated as part of the body and sent out", and the reporter saw it in request history. The screenshot shows a `//` line after a plain-text body rendered as body text, not as a comment.
  - [IJPL-67337 "'#' and '//' should not be proceeded as comment if in HTTP body"](https://youtrack.jetbrains.com/issue/IJPL-67337) (affected 2022.1, **Submitted**): the opposite. `#!/usr/bin/env bash` in a `text/bash` body is treated as a comment.
  - [IJPL-68401 "HTTP Client: allow comments in JSON payloads"](https://youtrack.jetbrains.com/issue/IJPL-68401) (**Submitted**) asks for comments in JSON bodies to be stripped automatically.
  - **Verdict:** behaviour inside the body is unclear and probably depends on content type or position. Treat it as unsafe.
- **Header values that start with `#`**: [IJPL-68132](https://youtrack.jetbrains.com/issue/IJPL-68132) (**Open**): `X-MY-HEADER: #MyValue#` is treated as a comment and the header is sent with an empty value. This shows that `#` is recognised in the middle of a header line after the colon, not only at the start of a line.

### VS Code REST Client

- **All comment lines are removed before parsing, wherever they are.** `Selector.getRequest` does `const rawLines = lines.filter(l => !this.isCommentLine(l));` ([src/utils/selector.ts L66](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/selector.ts#L66)). `isCommentLine` tests `CommentIdentifiersRegex = /^\s*(#|\/{2})/` ([src/common/constants.ts L69](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/common/constants.ts#L69); [selector.ts L160-162](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/selector.ts#L160-L162)). The filtered text is what reaches `HttpRequestParser` ([src/controllers/requestController.ts L41-61](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/controllers/requestController.ts#L41-L61); the code-snippet and cURL paths go through the same `Selector.getRequest`: [codeSnippetController.ts L49, L121](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/controllers/codeSnippetController.ts#L49)).
- Consequences:
  - Above the request line: allowed. These lines are also scanned for metadata (Q2).
  - Between headers: allowed and removed.
  - Between query continuation lines: allowed and removed (Q3).
  - **Inside the body: removed and not sent**, for every content type. Indented lines count too, because of `^\s*`. Real body lines that start with `#` or `//` (shebangs, GraphQL `#` comments, Markdown headings) are lost as well.
- The README only says "Comments (line starts with `#` or `//`) support" ([README.md L57](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/README.md?plain=1#L57)) and does not mention placement. The source is what settles this.
- A `#` in the middle of a line (for example in a header value) is **not** a comment, because the regex is anchored at line start.

---

## Q2. How are unrecognised `# @something` lines handled? Recognised tags

### JetBrains

- **Recognised tags (docs)**: `### name`, `# @name`, `# @name =` ("Set names for HTTP requests"), `@no-redirect`, `@no-log`, `@no-cookie-jar`, `@no-auto-encoding`, `@timeout <n>[ms|s|m]`, `@connection-timeout <n>[ms|s|m]`. Each is "a comment line … before the request", and `#` and `//` forms both appear ([exploring-http-syntax](https://www.jetbrains.com/help/idea/exploring-http-syntax.html)). There is no `@websocket` tag: WebSocket and gRPC are selected by the method keyword (`WEBSOCKET`, `GRPC`) ([http-client-in-product-code-editor, gRPC](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html)).
- **Recognised tags (plugin binary)**: the constant pool of `com/intellij/httpClient/http/request/documentation/comments/psi/HttpDocCommentTags.class` in `restClient.jar` (Rider 2026.2) contains exactly `@no-redirect`, `@no-log`, `@no-cookie-jar`, `@use-os-credentials`, `@no-auto-encoding`, `@name`, `@timeout` and `@connection-timeout`. `@use-os-credentials` is documented in the plugin's `messages/RestClientBundle.properties` ("Requests with this tag will attempt to get an authorization ticket from the OS.") but not on the help pages listed above.
- **Unrecognised tags**: the doc-comment lexer `_HttpDocCommentLexer` has an `UNKNOWN` token. `HttpDocCommentElementTypes` defines `UNKNOWN_TAG`, with PSI classes `HttpDocUnknownTag` / `HttpDocUnknownTagImpl`. I scanned every class under `com/intellij/httpClient/` in `restClient.jar` for references to `HttpDocUnknownTag` or `UNKNOWN_TAG`. Only the doc-comment package itself references them (element types, parser, visitor, PSI impl). No inspection, annotator or executor does. The registered inspections (`plugin.xml`, `inspectionDescriptions/*.html`) have none for unknown or invalid tags. **Inference:** an unknown `# @param …` line is parsed as an unknown tag inside a comment and produces no warning or error. Unconfirmed: whether the editor gives unknown tags the "Comment tag" highlight colour (bundle key `http.request.highlighting.doc.comment.tag`).
- **Supporting first-party example**: the screenshot in [IJPL-66728](https://youtrack.jetbrains.com/issue/IJPL-66728) shows a free-text `# group: 3. Transfer Flow / …` line next to `# @name …` above a request, with no error marker on it.
- Whether tag names are case-sensitive in JetBrains: **Unknown**.

### VS Code REST Client

- **Recognised tags**: the `RequestMetadata` enum has `name`, `note`, `no-redirect`, `no-cookie-jar`, `prompt` ([src/models/requestMetadata.ts L1-24](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/models/requestMetadata.ts#L1-L24)). The README "Per-request Settings" table ([README.md L744-753](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/README.md?plain=1#L744-L753)), "Request Variables" (L527-528) and "Prompt Variables" (L499-517) agree. Both `#` and `//` work.
- **Parsing**: `parseReqMetadatas` ([selector.ts L83-113](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/selector.ts#L83-L113)) walks the block's lines. It skips empty lines and file-variable lines, and **stops at the first non-comment line** (the request line). Each comment line is matched against `RequestMetadataRegex = /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/` ([constants.ts L67](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/common/constants.ts#L67)). The key goes through `fromString()`, which **lower-cases** it and looks it up in the enum ([requestMetadata.ts L26-30](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/models/requestMetadata.ts#L26-L30)). Unknown keys give `undefined`, and the `if (metadata)` guard skips them silently. No diagnostics provider looks at metadata (`customVariableDiagnosticsProvider.ts` skips comment lines entirely, L154).
- How the two example lines parse:
  - `# @param area: description`: key `param`, value `area: description`, not in the enum, **ignored**.
  - `# @header User-Agent: description`: key `header`, **ignored**.
  - `# @param:area …` does not match the regex at all, because the key must be followed by whitespace or end of line. It is a plain comment.
- **Watch-outs**:
  - Matching is case-insensitive, so `# @Name`, `# @NOTE` or `# @Prompt` would be honoured. `@note` makes REST Client show a confirmation prompt before sending (requestController.ts L49). `@prompt` makes it ask for input.
  - Request-name lookups for navigation and completion (`RequestVariableDefinitionRegex`, `^\s*(?:#{1,}|\/{2,})\s+@name\s+(\w+)\s*$`, [constants.ts L73-76](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/common/constants.ts#L73-L76)) scan **every line of the document** ([variableUtility.ts L98](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/variableUtility.ts#L98)). A `# @name x` line anywhere, even inside a body, is therefore picked up as a definition for go-to-definition.
- **Side note**: `RequestSettings` uses `if (no-redirect) … else if (no-cookie-jar)`, so when both tags are present only `@no-redirect` takes effect ([src/models/configurationSettings.ts L332-336](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/models/configurationSettings.ts#L332-L336)).

---

## Q3. Does a comment between query continuation lines, or between headers, break parsing?

### VS Code REST Client: no, in both cases

- Comments are filtered out first (`selector.ts` L66). The parser state machine in `HttpRequestParser.parseHttpRequest` ([httpRequestParser.ts L41-73](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/httpRequestParser.ts#L41-L73)) never sees them.
- URL state: while the *next* line matches `queryStringLinePrefix = /^\s*[&\?]/` (L25), it stays in URL state. The request lines are then joined with `requestLines.map(l => l.trim()).join('')` (L76). So `GET /x` / `# doc` / `&limit=5` becomes `GET /x` / `&limit=5`, which becomes `GET /x&limit=5`. Indentation is allowed (`^\s*`).
- Header state: a header block ends only at an empty line (L60-68). A removed comment line cannot end it.
- Caveat: only lines that **start** with `?` or `&` continue the URL. The JetBrains context-action style, which puts the separator at the end (`GET …/html?` / `    firstname=John&` / `    lastname=Doe&`, shown in the [JetBrains docs](https://www.jetbrains.com/help/idea/exploring-http-syntax.html)), would make REST Client read `firstname=John&` as a **header** line. The README documents only the leading-`?`/`&` form ([README.md L128-139](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/README.md?plain=1#L128-L139)).
- Form bodies: for `application/x-www-form-urlencoded`, body lines that start with `&` are joined without a newline (`parseBody`, L180-184). Comment lines in the body were already removed, so they do not break this joining either.

### JetBrains

- **Query continuation: risky, effectively unsupported.**
  - The grammar continues a query only with `new-line-with-indent query`, and no comment production is allowed there (spec §3.2.1.4, L287-291). A `#` inside the query starts the *fragment*.
  - Open feature request [IJPL-66728](https://youtrack.jetbrains.com/issue/IJPL-66728) "Support query params commenting". Its screenshot shows an error marker when a `#` comment line sits between a query continuation line and the headers.
  - What happens to the query lines after the comment is **Unknown**: they might be dropped, parsed as headers, or flagged as errors. I could not verify this (see Limitation).
- **Between header lines: allowed per spec.** §2.4 says comments may be used "inside the header section". The IJPL-67336 description also says comments "can still be placed between" headers (the placeholder text in that description was lost when it was rendered). No empirical confirmation for 2026.2.
- **Between the request line and the first header**: the spec's wording ("inside the header section") arguably covers this, but it does not say so explicitly. **Not verified.**

---

## Q4. Existing conventions for documenting params or headers; reserved comment prefixes

- **No first-party per-parameter or per-header documentation convention exists in either tool.**
  - The JetBrains docs, the spec, and the bundled example collections in `restClient.jar` (`com/intellij/ws/rest/client/requests/collection/*.http`: `get-requests.http`, `post-requests.http`, etc.) contain none.
  - The REST Client README contains none.
  - The JetBrains OpenAPI-to-HTTP generator docs ([http-client-in-product-code-editor, "Create requests from OpenAPI specifications"](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html); [openapi](https://www.jetbrains.com/help/idea/openapi.html)) describe no generated parameter comments.
  - Related open requests: [IJPL-67292](https://youtrack.jetbrains.com/issue/IJPL-67292) (the OpenAPI generator does not add query params or body) and [IJPL-69613](https://youtrack.jetbrains.com/issue/IJPL-69613) ("Extract description from [Swagger] tags and use it as comment", Open).
- **JetBrains staff guidance on comment prefixes**: in [IJPL-67335](https://youtrack.jetbrains.com/issue/IJPL-67335) (2023-01-19), JetBrains developer aleksandr.izmaylov wrote:
  - "`#` it is not just a comment in HTTP Client, it has additional semantics: `###` is a separator … First `###` with something (not just `###`), e.g. `### my request` is a request name … Just `#` is a comment."
  - "HTTP Client has `//` comments. They have only one semantics: commenting. So, I suggest you to use them for now for documenting in such way."
  - Related: [IJPL-67221](https://youtrack.jetbrains.com/issue/IJPL-67221) (Fixed 2023-01-23): a run of `####…` is no longer taken as a request name.
- **JetBrains prefixes with special meaning:**
  - `###…`: separator, and the text after it is the request name.
  - `# @<tag>` / `// @<tag>`: request tags (Q2). The PSI type for any comment is `HttpDocComment`, and tags are parsed inside it.
  - `//TIP`: the plugin has `TIP_PREFIX = "//TIP"` (`HttpClientOnboardingCommentsUtilsKt`). Comments starting with it render as inline onboarding documentation (`HttpClientOnboardingTipsDocumentationProvider`, behind registry key `doc.onboarding.tips.render`). The method and string names in that provider (`isExampleFile`, `isFileFromCollections`, `whats-new.http`, `showTipCommentInExampleFile`, `isRegularUsersFile`) suggest the rendering is limited to bundled example files and a one-time onboarding comment. **Unconfirmed** for user files. The bundled examples use `//TIP …` heavily.
  - `TODO` comments: [IJPL-65394](https://youtrack.jetbrains.com/issue/IJPL-65394) (Fixed 2024-04) indexes TODO comments in `.http` files (`com/intellij/httpClient/http/request/todo/HttpRequestFilterLexer`).
  - Bare `@name = value` (no comment marker) is an in-place variable, written "above the HTTP method section" ([http-client-variables, "In-place variables"](https://www.jetbrains.com/help/idea/http-client-variables.html)).
- **REST Client prefixes with special meaning:**
  - Any line matching `^#{3,}` (no leading whitespace) is a request **delimiter**, wherever it appears ([selector.ts L240-244](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/selector.ts#L240-L244)). A doc comment such as `#### Params` would split the request.
  - `# @<tag>` / `// @<tag>` before the request line (Q2).
  - Bare `@name = value` anywhere in the file is a file variable. `FileVariableDefinitionRegex = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/` is applied to **every line of the document** ([constants.ts L71](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/common/constants.ts#L71); [fileVariableProvider.ts L72-99](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/httpVariableProviders/fileVariableProvider.ts#L72-L99)). The leading `#` in `# @x = y` keeps such a line from matching.

---

## Q5. Other facts relevant to machine-readable metadata in comments

- **`# @` lines directly above the method line are where both tools look for request tags.**
  - JetBrains docs: "Before the request, add a comment line with the @… tag."
  - REST Client: `parseReqMetadatas` reads only the comment lines before the first non-comment line. A `# @x` line placed *after* the request line (among headers or query lines) is not read as metadata in REST Client; it is just stripped.
  - JetBrains behaviour for tag-like lines below the request line: **Unknown**.
- **`###` followed by text:**
  - JetBrains: a request **name**, per the docs ("Type a name above the request next to `###`, `# @name`, or `# @name =`", [exploring-http-syntax](https://www.jetbrains.com/help/idea/exploring-http-syntax.html)) and staff (IJPL-67335). The 2023 spec still calls it a separator "comment" (§2.5, [L114-127](https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md#25-request-separators)). The docs are newer.
  - REST Client: delimiter only; the text is ignored. Names come only from `# @name`. The document-symbol provider uses `# @name` when present ([httpDocumentSymbolProvider.ts L20-27](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/providers/httpDocumentSymbolProvider.ts#L20-L27)).
- **Comments before the first `###`:**
  - JetBrains: the spec allows leading separators and comments "before or after a request" (§3.1, [L130-147](https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md#31-requests-file); §2.4). The docs' examples start files with `// A basic request`.
  - REST Client: the text before the first delimiter is its own block (`getDelimitedText`, [selector.ts L209-238](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/utils/selector.ts#L209-L238)). `getRequestRanges` skips comment, empty and file-variable lines, so a comments-only preamble yields no request and no "Send Request" CodeLens (L115-158; [httpCodeLensProvider.ts L9-19](https://github.com/Huachao/vscode-restclient/blob/0773d56b65d9e7033259519e99eef8f752f6ba6e/src/providers/httpCodeLensProvider.ts#L9-L19)).
- **`###` inside a body ends the request in both tools.**
  - JetBrains: `message-line` excludes lines starting with `###` (spec §3.2.3, [L345-346](https://github.com/JetBrains/http-request-in-editor-spec/blob/ad743118c2f4edfbffea13863921cf6296198852/spec.md#323-message-body)). There are also dedicated inspections, `HttpRequestRequestSeparatorJsonBodyInspection` / `…XmlBody…` / `…YamlBody…`, in `plugin.xml`.
  - REST Client: `^#{3,}`.
- **Leading indentation**: REST Client's comment regex allows leading whitespace (`^\s*`). Its delimiter regex does not (`^#{3,}`), so `    ###` is a comment there, not a delimiter. JetBrains handling of indented `###`: **Unknown**.
- **`@name` value syntax differs**: JetBrains accepts `# @name foo` and `# @name = foo`. REST Client's regex `@([\w-]+)(?:\s+(.*?))?` would read `# @name = foo` as the name `= foo`, and its request-variable regex needs `\w+`, so `= foo` does not match. Not directly relevant to docs, but it shows that tag *values* are parsed differently by the two tools.

---

## Implications for HttpDesk

Classification only, from the evidence above. This is not a design.

**Safe in both tools**

- `#` or `//` comment lines between the `###` separator and the method line.
- Within those, `# @<tag> …` / `// @<tag> …` where `<tag>` is **not** a recognised tag in either tool, compared case-insensitively. Avoid: `name`, `note`, `prompt`, `no-redirect`, `no-cookie-jar`, `no-log`, `no-auto-encoding`, `timeout`, `connection-timeout`, `use-os-credentials`. Examples: `# @param …`, `# @header …`. REST Client ignores them (source-verified). JetBrains sends the request unchanged with no CLI warning (verified, Appendix B, Case A).
- Comments before the first `###`.

- Comment lines between two header lines, and between the request line and the first header (verified in JetBrains, Cases C and F).
- HttpDesk's existing encoding: `#~ &param` after the request line, `#~ Header:` between headers, `#~|` disabled body in the header area, and `# @httpdesk-*` tags. JetBrains sends none of the disabled parts (verified, Cases E, G and H).

**Risky**

- **Breaks JetBrains:** comment lines between multi-line query continuation lines. A column-0 comment makes the following `&` line a header and the request fails. An indented comment is pasted into the URL (verified, Cases B and B2). REST Client handles both.
- **Tools disagree:** any comment inside the request body. REST Client strips it, while JetBrains sends it as body content (verified, Case D).
- Metadata lines starting with `###` or `####`. Both tools treat these as separators, and JetBrains also reads the text as a request name.
- `//TIP` prefixes (JetBrains onboarding rendering) and `TODO` / `FIXME` prefixes (JetBrains TODO index).
- Bare `@x = y` lines without a comment marker. Both tools treat these as variables (REST Client anywhere in the file).
- A trailing-separator multi-line query (`?` / `x=1&` at line end). REST Client parses the continuation lines as headers. Only the indented leading-`?`/`&` form works in both tools.

**Unknown (the JetBrains run in Appendix B settled the query, header, body and unknown-tag questions; these remain open)**

- Whether JetBrains treats `# @tag` lines below the request line as tags or as plain comments.
- JetBrains tag-name case sensitivity, and how it handles indented `###`.

---

## Appendix A: verification file

To confirm the JetBrains verdicts, run this with the HTTP Client CLI (`ijhttp`, needs JDK 25+; [docs](https://www.jetbrains.com/help/idea/http-client-cli.html)) or from the IDE, against an echo server that logs the raw request line, headers and body. Each request carries an `X-Case` header so the results can be told apart.

```http
# file-level comment before first separator
// another file-level comment

### Case A name from separator
# @param area: description of area
# @header User-Agent: description of UA
// @foo bar baz
GET http://127.0.0.1:18765/a?area=1
X-Case: A

### Case B (comment at col 0 between indented query lines)
GET http://127.0.0.1:18765/b
    ?a=1
# doc for limit
    &limit=5
X-Case: B

### Case B2 (indented comment between query lines)
GET http://127.0.0.1:18765/b2
    ?a=1
    # doc for limit
    &limit=5
X-Case: B2

### Case C (comments between headers)
GET http://127.0.0.1:18765/c
X-Case: C
X-One: 1
# doc for X-Two
// @header X-Two: doc
X-Two: 2

### Case F (comment between request line and first header)
GET http://127.0.0.1:18765/f
# doc right after request line
X-Case: F

### Case D (comments inside a JSON body)
POST http://127.0.0.1:18765/d
X-Case: D
Content-Type: application/json

{
# hash comment at col 0
  // slash comment indented
  "a": 1
}
```

What to check:

- **Case B / B2**: whether the server receives `?a=1&limit=5`, and whether `X-Case` still arrives as a header.
- **Case C**: whether `X-Two` arrives.
- **Case D**: whether the comment lines appear in the body.
- **Case A**: the request name the runner reports, and whether any warning is printed.

---

## Appendix B: empirical JetBrains results

Run on 2026-11-05 with the official JetBrains HTTP Client CLI image (`jetbrains/intellij-http-client`, *IntelliJ HTTP Client 2026.3, build 263.7307.200*, digest `sha256:4afde15abef4a712e407d0d4a83b9a1dd557dffa3fc203bd8d943d609ef5c3d6`) with `-L VERBOSE`. It ran the Appendix A file plus cases E, G and H below against an echo server that logs the request line, headers and body exactly as received. The CLI printed no warnings for any case.

| Case | What it tests | Received by the server | Verdict |
|---|---|---|---|
| A | `# @param` / `# @header` / `// @foo` above the request line; `### text` name | `GET /a?area=1`, `X-Case: A`. The request was named "Case A name from separator". | Unknown tags are harmless. `###` text is the name. |
| B | Column-0 `# doc` between indented `?a=1` / `&limit=5` | **Request failed**: `IllegalArgumentException: a header name can only contain "token" characters … header '    &limit=5'`. | The comment ends the query, and the next line is parsed as a header. |
| B2 | Indented `# doc` between query lines | `GET /b2?a=1%23+doc+for+limit&limit=5` | **The comment text becomes part of the URL.** |
| C | `#` and `// @header` comments between headers | `X-Case`, `X-One`, `X-Two` all arrive. | Safe. |
| F | Comment between the request line and the first header | `X-Case: F` arrives. | Safe. |
| D | `#` and `//` lines inside a JSON body | Body was `{\n# hash comment at col 0\n  // slash comment indented\n  "a": 1\n}` | **Comments are sent as body content** (VS Code strips them). |
| E | HttpDesk format: `# @param`, `# @header`, `# @httpdesk-auth` above; `#~ &status=sold` after the request line; `#~ X-Debug: true` between headers | `GET /e?limit=20` with `X-Case` and `Accept`. No `status`, no `X-Debug`. | HttpDesk's disabled query and headers are ignored as intended. |
| G | HttpDesk disabled body (`#~| …` lines in the header area, no blank line) | `POST /g`, `content-length: 0` | The disabled body is not sent. |
| H | `# @httpdesk-disabled headers` with every header written as `#~` | `GET /h?x=1` with no `X-Case` or `Accept` | The section directive is ignored, and the disabled headers are not sent. |

Cases E, G and H appended to the Appendix A file:

```http
### Case E (HttpDesk: disabled query + disabled header between headers)
# Description line from HttpDesk
# @param status: Filter by status
# @header X-Debug: Enables debug output
# @httpdesk-auth apikey header X-Api-Key
GET http://hd-echo:18765/e?limit=20
#~ &status=sold
X-Case: E
#~ X-Debug: true
Accept: application/json

### Case G (HttpDesk: disabled body lives in header area)
POST http://hd-echo:18765/g
X-Case: G
Content-Type: application/json
#~| {
#~|   "a": 1
#~| }

### Case H (HttpDesk: whole headers section disabled)
# @httpdesk-disabled headers
GET http://hd-echo:18765/h?x=1
#~ X-Case: H
#~ Accept: application/json
```

VS Code REST Client verdicts are still based on reading the source (commit `0773d56`). The extension was not run.
