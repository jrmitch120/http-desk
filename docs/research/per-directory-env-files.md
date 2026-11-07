# Per-directory environment files: how the JetBrains HTTP Client looks them up

Research for reading `http-client.env.json` / `http-client.private.env.json` pairs from
any folder of a workspace, the way the JetBrains HTTP Client does, so a multi-service
layout sends the same from both tools. This file records what the sources say. The
decisions taken from it are in [ADR-0004](../adr/0004-per-directory-environment-files.md).

## Sources read (versions)

| Source | Version | Notes |
|---|---|---|
| JetBrains docs: [HTTP Client variables](https://www.jetbrains.com/help/idea/http-client-variables.html), section "Manage multiple environment files" | IntelliJ IDEA Help; the page has no date stamp, and its images are under the `2026.3` path. Read 2026-11-06 through the `.html.md` variant. | The only first-party description of the lookup. |
| VS Code REST Client [README](https://github.com/Huachao/vscode-restclient/blob/master/README.md), section "Environments" | `master`, read 2026-11-06 | For `$shared`, which JetBrains doesn't have. |

**Limitation:** the JetBrains HTTP Client is closed source and wasn't run for this note,
so every JetBrains verdict below rests on the docs alone. Where they are silent or
contradict themselves the verdict says so, and the rule HttpDesk follows is marked
**Chosen**.

---

## Summary of verdicts

| # | Question | JetBrains HTTP Client | HttpDesk |
|---|---|---|---|
| 1 | Where does the lookup start, and where does it go next? | **Documented.** The request file's directory, then its parent directory. | Same. The walk stops at the workspace root. |
| 2 | Is the choice made per environment name? | **Documented** (the example only works that way). The nearest file that defines the selected environment supplies it. | Same, for every name including `$shared`. |
| 3 | Are public and private files looked up separately? | **Documented by example.** The root's public `dev` and `service1/`'s private `dev` are combined. | Same. |
| 4 | Are two files of the *same* kind that both define an environment merged variable by variable? | **Unknown.** The docs don't say. | **Chosen:** no. The nearest file supplies the whole environment. |
| 5 | Public or private: which wins on a name conflict? | **Contradictory.** One passage says public wins; two say private wins. | Private wins (as HttpDesk already did for the root pair). |
| 6 | What does the environment picker show? | Two groups: "For File" (current and parent directories) and "From Whole Project" (every other place, duplicate names hidden). | **Chosen:** one global list of every name, with names the active request's folder doesn't define marked. |
| 7 | A selected environment the request's folders don't define | **Unknown.** The docs don't say what happens when a "From Whole Project" environment is used. | **Chosen:** the request runs with no environment (only `$shared`), and the UI says so. Never borrowed from another folder. |
| 8 | `$shared` | **Not a JetBrains feature.** The docs don't mention it. | From REST Client; follows the same nearest-wins rule as any environment. |

---

## Q1–Q3. The lookup

Under "Manage multiple environment files":

- "Your project may have multiple directories with HTTP request files and corresponding environment files in them."
- "For File shows environments stored in the current and parent directories."
- "If you select an environment from this list, the HTTP Client tries to find it in the files (public and private) stored in the current directory."
- "If there is no file with this environment, it checks the parent directory."

The example has a public file at the root and private files in two subfolders:

- `root/http-client.env.json`: public, `dev` environment with `host`.
- `root/service1/http-client.private.env.json`: "private file with 'dev' environment and "key": "myKey1" variable".
- `root/service2/http-client.private.env.json`: the same with `key` = `myKey2`.

A request in `service1/` sent with `dev` uses `myKey1` for `key`, and one in `service2/`
uses `myKey2`; both use the root's `host`. Since neither subfolder has a public file, the
`host` can only come from the root's public file while the `key` comes from the
subfolder's private file. So **public and private files are looked up separately**, each
by the same walk, and their results combined. The example doesn't say how far up the walk
goes; HttpDesk stops at the workspace root (the only folder it was given).

## Q4. Two files of the same kind

The page never addresses two public (or two private) files that both define the same
environment, for example `root/` and `service1/` both with a public `dev`. "Tries to find
it in the files … stored in the current directory. If there is no file with this
environment, it checks the parent directory" reads as stopping at the first file that has
the environment, but it isn't stated outright. **Unknown.**

**Chosen** (ADR-0004): the nearest file supplies the whole environment; a farther file's
`dev` contributes nothing to a nearer `dev`. "This folder's `staging`" is then one place to
read and edit.

## Q5. Public vs. private precedence

The page contradicts itself:

- "Variable types": "In case of a name conflict, public variables take precedence over private ones."
- "Procedure: Define environment variables": "The values of variables that are specified in the `http-client.private.env.json` file override the values in the public environment file."
- "Manage multiple environment files": "…because private files take precedence over public files."

Two of the three say private wins, and the private file only makes sense as an override
(it holds Secrets behind empty placeholders). HttpDesk keeps private over public.

## Q6. The picker

"For File shows environments stored in the current and parent directories." "From Whole
Project shows environments stored in all other places of your project", with duplicate
names hidden, so a uniquely named environment is visible everywhere. HttpDesk has one
picker for the workspace rather than one per file, so it lists every name once and marks
those the active request's folder chain doesn't define (ADR-0004, "Considered options").

## Q7. An environment the folder doesn't define

The docs don't say what JetBrains does when a "From Whole Project" environment is selected
for a request whose own folders don't define it. **Unknown.** HttpDesk runs the request with
no environment and warns, in the pre-send checks strip and as a warning on the response;
borrowing another folder's same-named environment is how a request ends up at another
service's host.

## Q8. `$shared`

JetBrains' page doesn't mention `$shared`. It comes from VS Code REST Client, whose README
("Environments") describes a shared environment, "identified by special environment name",
"to provide a set of variables that are available in all environments", whose values an
environment can "overwrite", and which is "still available" with no environment selected.
REST Client keeps environments in the VS Code settings file, not in per-directory files, so
it says nothing about a lookup. HttpDesk gives `$shared` the same nearest-wins rule as a
named environment.

## Appendix: a layout for checking these verdicts in JetBrains

```
root/http-client.env.json            { "dev": { "host": "root.dev", "port": "1" }, "$shared": { "v": "1" } }
root/http-client.private.env.json    { "dev": { "key": "root-key" } }
root/a/http-client.env.json          { "dev": { "host": "a.dev" } }
root/a/b/http-client.private.env.json { "dev": { "key": "b-key" } }
root/c/http-client.env.json          { "staging": { "host": "c.staging" } }
root/a/b/x.http                      GET http://{{host}}:{{port}}/?key={{key}}
root/d/y.http                        GET http://{{host}}/
```

- Q4: `x.http` with `dev` sends `a.dev` and no `port` if same-kind files aren't merged, `a.dev:1` if they are.
- Q3/Q5: `x.http`'s `key` should be `b-key`.
- Q7: `y.http` with `staging` (picked from "From Whole Project") shows what JetBrains does with an environment the request's folders don't define.
