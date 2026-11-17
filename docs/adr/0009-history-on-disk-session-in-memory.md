# History is kept on disk in plaintext; the Session stays in memory

History (#40) puts Exchanges on disk, and a response can't be reliably cleaned of credentials: a login response body *is* the token. We store History in plaintext in the app data directory, never in the workspace, as both editors do with their request logs and cookies. Request-side credentials are masked when an entry is written: `Authorization`, `Proxy-Authorization` and `Cookie` headers, and every Secret value and prompt answer wherever it appears in the request. Responses are stored as received. Users control what's kept through `# @no-log`, an app-wide History switch, retention limits and Clear. The Session (cookies, Global variables, latest Exchanges, prompt answers) is a separate choice, and it stays in memory: a restart starts a fresh Session.

## Considered options

- **Scrub responses too** (`Set-Cookie` values, token-looking fields). Rejected: bodies can't be scrubbed reliably, so it would promise a safety it can't deliver, and it breaks the Cookies view of a History entry.
- **Encrypt the store with a key in the OS keychain.** Rejected: real work on three OSes, adds keychain prompts, and doesn't stop malware running as the same user, which is the realistic threat.
- **Persist the Session (cookies, or everything but prompt answers).** Deferred, not rejected: it's a separate request, and keeping it in memory keeps the Prompt variable promise ("never written to disk") simple.

## Consequences

- A tab restored after a restart shows its last response from History, but that response is not in the Session.
- Turning History off asks whether to delete what's already stored.
