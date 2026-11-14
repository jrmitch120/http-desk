# Chaining and scripts use both editors' syntaxes, though neither is portable

ARCHITECTURE §9 put scripting, chaining, assertions and cookies out of scope. We are bringing them in (#107) by running the constructs users' files already contain, VS Code REST Client request variables (`{{login.response.body.$.token}}`) and JetBrains scripts (`< {% %}`, `> {% %}`, `client.*`), and by adding no syntax of our own. Neither construct is portable: REST Client sends a script block as body text, and a pre-request block above the method line breaks the request; Rider refuses to send a request containing `{{name.response…}}` (IJPL-253135). We support both anyway, because people bring files written for one tool and expect them to work here, and running them doesn't make those files any less portable than they already are. HttpDesk never writes either construct on its own; when the user adds one, the UI says which editor it breaks in.

## Considered options

- **JetBrains scripts only.** `client.global.set` can chain values too, but files written for VS Code would silently send `{{login.response…}}` as text.
- **REST Client request variables only.** No JS engine, sandbox or workspace trust to build, but Rider users' handlers and `client.test` results would be ignored, which is the gap #107 set out to close.
- **An HttpDesk syntax that both editors tolerate.** Rejected: it would run nowhere but HttpDesk, and the core principle is that files keep working unmodified in both editors.

## Consequences

- An unsent request behind a Request variable blocks the send instead of sending it on its own, and the user chooses to send it. Neither editor auto-sends a dependency.
- Scripts come from files other people wrote, so they run sandboxed, with time and memory limits, and only in a workspace the user has trusted. Trust is stored in app settings, never in the workspace.
- The Session (latest exchanges, Global variables, cookies) is kept in memory only. Both editors keep cookies on disk; we don't, until session restore (#40) settles how credentials are stored at rest.
