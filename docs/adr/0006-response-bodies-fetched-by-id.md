# Response bodies are fetched by id

The reply to `send_request` never carries a body, at any size: it has the status, headers, sizes, content type, body kind, truncated flag, timings, cookies, warnings and the request as sent, and nothing else. The shell keeps each body by response id for as long as a tab shows it (until the webview releases it, or the page loads again), and the webview fetches what the current view needs by id, as raw bytes: Raw and Pretty text as UTF-8, a binary body's exact bytes (`response_body`), or the Hex dump. Copy body goes through the shell as well. We chose this because a body inside the JSON reply froze the window: on a 50 MB JSON body, encoding the reply as JSON and parsing it back took 216–544 ms on the main thread, before the editor had done anything, and binary bodies came with a base64 copy too. A raw IPC response arrives as an `ArrayBuffer` with no JSON step, so the webview can decode it in pieces across frames instead. Even a 200-byte body is fetched separately, so there is one path to keep fast and to test, not two.

The webview knows a body is binary from its body kind (image, PDF, audio or video, or binary), not from a missing text field. A body kept as received because its Content-Encoding couldn't be undone is binary, whatever its content type says.

## Considered options

- **Inline below a size limit, fetched above it.** This is what we had for Pretty text (1 MB). Rejected: two paths for every view, with the large one the less tested, and the limit only moves the freeze to just under it.
- **Streaming the body over a channel as it downloads.** Rejected: each chunk still crosses as a serialized message, and showing a body before it's complete is out of scope; the whole body is needed before Pretty, the filter or Find can work on it.
- **A custom URI scheme serving bodies by id.** Workable (`fetch` gives an `ArrayBuffer` too), but it needs its own CSP and per-platform URL handling (Windows serves custom schemes from `http://<scheme>.localhost`), and errors come back as HTTP statuses instead of the command errors every other view uses. A raw IPC response gives the same bytes through the command layer the app already has.

## Consequences

- Every body costs one extra round trip after the send, so the status, headers and timing show first and the body a moment later.
- Bodies stay in the shell's memory until released, with no count or byte limit; the webview must release a response when its tab closes, gets a newer response or closes with the workspace, or the body leaks until the next page load.
