// Guardrail: every text field the app draws turns off the OS's autocomplete,
// autocorrect, autocapitalize and spell-check by spreading `textFieldAttrs`.
import { describe, expect, it } from "vitest";
import { checkTextFields } from "./text-fields";

// Every app source except tests and the guardrails (whose fixtures are offenders).
const sources = import.meta.glob(["/src/**/*.svelte", "/src/**/*.ts", "!/src/**/*.test.ts", "!/src/guardrail/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

it("every <input> and <textarea> spreads textFieldAttrs", () => {
  const files = Object.entries(sources).map(([path, source]) => ({ path: path.slice(1), source }));
  expect(files.length).toBeGreaterThan(20);
  const problems = checkTextFields(files);
  expect(problems, `Add {...textFieldAttrs} from src/lib/textField.ts:\n${problems.join("\n")}\n`).toEqual([]);
});

describe("checkTextFields", () => {
  it("reports an input or textarea without the spread, naming file and line", () => {
    const source = `<div>\n  <input class="input" />\n  <textarea></textarea>\n</div>`;
    expect(checkTextFields([{ path: "src/A.svelte", source }])).toEqual([
      "src/A.svelte:2 <input> without {...textFieldAttrs}",
      "src/A.svelte:3 <textarea> without {...textFieldAttrs}",
    ]);
  });

  it("accepts a field that spreads it, wherever the spread sits", () => {
    const source = `<input class="input" {...textFieldAttrs} value={x} />\n<textarea {...textFieldAttrs}></textarea>`;
    expect(checkTextFields([{ path: "src/A.svelte", source }])).toEqual([]);
  });

  it("reports a text field built with createElement, in .ts sources and Svelte scripts", () => {
    const ts = `const a = 1;\nconst el = document.createElement("input");\nconst t = document.createElement('textarea');\nconst d = document.createElement("div");`;
    const svelte = `<script lang="ts">\n  const x = 1;\n  const el = document.createElement("input");\n</script>\n<div></div>`;
    expect(checkTextFields([{ path: "src/a.ts", source: ts }, { path: "src/B.svelte", source: svelte }])).toEqual([
      "src/a.ts:2 createElement(\"input\") builds a text field outside markup; draw it in a .svelte file with {...textFieldAttrs}",
      "src/a.ts:3 createElement(\"textarea\") builds a text field outside markup; draw it in a .svelte file with {...textFieldAttrs}",
      "src/B.svelte:3 createElement(\"input\") builds a text field outside markup; draw it in a .svelte file with {...textFieldAttrs}",
    ]);
  });
});
