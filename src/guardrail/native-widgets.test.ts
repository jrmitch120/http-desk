// Guardrail for ADR 0002: the app's own UI uses HttpDesk's owned controls, never
// native form widgets or `title` tooltips. See native-widgets.allowlist.ts for
// the files that haven't been converted yet.
import { describe, expect, it } from "vitest";
import { ALLOWLIST } from "./native-widgets.allowlist";
import { checkSources, emptyAllowlist } from "./native-widgets";

const file = (path: string, source: string) => ({ path, source });

// Every app source except tests and this guardrail (whose fixtures are offenders).
const sources = import.meta.glob(["/src/**/*.svelte", "/src/**/*.ts", "!/src/**/*.test.ts", "!/src/guardrail/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

it("the app uses owned controls, not native widgets, outside the allowlist", () => {
  const files = Object.entries(sources).map(([path, source]) => file(path.slice(1), source));
  expect(files.length).toBeGreaterThan(20);
  const problems = checkSources(files, ALLOWLIST);
  expect(problems, `Use the owned controls (ADR 0002) instead:\n${problems.join("\n")}\n`).toEqual([]);
});

describe("checkSources", () => {
  it("reports a native <select> in a non-allowlisted component, naming the file and widget", () => {
    const problems = checkSources([file("src/components/New.svelte", `<div>\n  <select><option>a</option></select>\n</div>`)], emptyAllowlist());
    expect(problems).toEqual([expect.stringMatching(/^src\/components\/New\.svelte:2 .*<select>/)]);
  });

  it("reports every listed widget kind", () => {
    const source = [
      `<input type="checkbox" />`,
      `<input type='radio' />`,
      `<input type={"number"} />`,
      `<input list="x" /><datalist id="x"></datalist>`,
      `<button title="Close">x</button>`,
    ].join("\n");
    expect(checkSources([file("src/A.svelte", source)], emptyAllowlist())).toEqual([
      'src/A.svelte:1 uses a native <input type="checkbox">',
      'src/A.svelte:2 uses a native <input type="radio">',
      'src/A.svelte:3 uses a native <input type="number">',
      "src/A.svelte:4 uses a native <datalist>",
      "src/A.svelte:5 uses a native title= tooltip",
    ]);
  });

  it("catches a title tooltip however the attribute is written", () => {
    const source = `<span title={label}></span>\n<span {title}></span>`;
    expect(checkSources([file("src/A.svelte", source)], emptyAllowlist())).toEqual([
      "src/A.svelte:1 uses a native title= tooltip",
      "src/A.svelte:2 uses a native title= tooltip",
    ]);
  });

  it("does not treat things that aren't tooltips as title tooltips", () => {
    const source = `<script lang="ts">
  let { title }: { title: string } = $props();
</script>

<svg viewBox="0 0 24 24" role="img"><title>Close</title><path d="M0 0" /></svg>
<Modal title="Settings" onclose={() => {}}>body</Modal>
<iframe title="HTML preview" sandbox="" srcdoc=""></iframe>

<style>
  input[type="checkbox"] { margin: 0; }
  .title { color: red; }
</style>`;
    expect(checkSources([file("src/A.svelte", source)], emptyAllowlist())).toEqual([]);
  });

  it("catches native widgets built from TypeScript (CodeMirror decorations, DOM APIs)", () => {
    const source = [
      `Decoration.line({ class: "warn", attributes: { title: w.message } });`,
      `el.setAttribute("title", text);`,
      `el.title = text;`,
      `const s = document.createElement("select");`,
      `box.type = "checkbox";`,
      `interface Dialog { title: string } // not a tooltip`,
      `if (el.title === "x") {}`,
    ].join("\n");
    expect(checkSources([file("src/lib/x.ts", source)], emptyAllowlist())).toEqual([
      "src/lib/x.ts:1 uses a native title= tooltip",
      "src/lib/x.ts:2 uses a native title= tooltip",
      "src/lib/x.ts:3 uses a native title= tooltip",
      "src/lib/x.ts:4 uses a native <select>",
      'src/lib/x.ts:5 uses a native <input type="checkbox">',
    ]);
  });

  it("checks DOM-building code inside a component's <script> too", () => {
    const source = `<script lang="ts">\n  let el: HTMLElement;\n  $effect(() => { el.title = "x"; });\n</script>\n<div bind:this={el}></div>`;
    expect(checkSources([file("src/A.svelte", source)], emptyAllowlist())).toEqual(["src/A.svelte:3 uses a native title= tooltip"]);
  });

  it("allowlists a file for one widget kind only", () => {
    const allowlist = { ...emptyAllowlist(), select: ["src/A.svelte"] };
    const source = `<select></select>\n<input type="checkbox" />`;
    expect(checkSources([file("src/A.svelte", source)], allowlist)).toEqual(['src/A.svelte:2 uses a native <input type="checkbox">']);
  });

  it("asks for an allowlist entry to be removed once its file no longer has that widget", () => {
    const allowlist = { ...emptyAllowlist(), select: ["src/A.svelte", "src/Gone.svelte"] };
    expect(checkSources([file("src/A.svelte", `<div></div>`)], allowlist)).toEqual([
      'src/A.svelte has no native <select> any more: remove it from the "select" allowlist',
      'src/Gone.svelte has no native <select> any more: remove it from the "select" allowlist',
    ]);
  });
});
