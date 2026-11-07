# Per-directory environment files: nearest folder wins, no borrowing

A workspace can have `http-client.env.json` / `http-client.private.env.json` pairs in any folder. For a given request, each environment name (including `$shared`) comes from the nearest file that defines it, searching the request's folder first and then each parent up to the workspace root. Public and private files are searched separately, and private values override public ones. Nearer and farther files of the same kind are never merged variable by variable: the nearest one supplies the whole environment. The environment picker stays global and lists every environment name in the workspace. If none of a request's folders defines the selected environment, the request runs with no environment and is warned about it. It never borrows a same-named environment from another folder.

We follow the JetBrains HTTP Client's documented lookup ("tries to find it in the files… stored in the current directory. If there is no file with this environment, it checks the parent directory"; https://www.jetbrains.com/help/idea/http-client-variables.html, "Manage multiple environment files"), so existing multi-service layouts send the same from both tools. The docs don't say whether two same-kind files that both define an environment are merged; we chose the stricter reading because "this folder's `staging`" is then easy to explain and to edit in one place. We refuse to borrow because silently using another service's `staging` is how a request ends up at the wrong host.

## Considered options

- **Merge variable by variable across every level (nearest wins per variable).** Rejected: a value can come from any folder above, so editing an environment no longer means editing one file, and JetBrains doesn't document this behaviour.
- **Fall back to a same-named environment elsewhere in the workspace when only one exists.** Rejected: adding a second one later silently changes where the first service's requests go.
- **A picker per folder, like JetBrains' "For File" / "From Whole Project" sections.** Rejected: HttpDesk has one environment picker for the workspace. The picker marks names that aren't defined for the active request instead.

## Consequences

- The Environments modal edits one folder's pair of files at a time and opens on the active request's nearest folder.
- Moving a `.http` file between folders can change which environment values it sends with.
- An environment's `SSLConfiguration` comes from the same files as its variables, with paths relative to the folder of the file that holds them.
- The research behind this is in [research/per-directory-env-files.md](../research/per-directory-env-files.md).
