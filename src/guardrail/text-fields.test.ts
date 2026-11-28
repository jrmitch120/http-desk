// Guardrail: every text field the app draws turns off the OS's autocomplete,
// autocorrect, autocapitalize and spell-check by spreading `textFieldAttrs`.
import { describe, expect, it } from "vitest";
import { checkTextFields } from "./text-fields";

const sources = import.meta.glob(["/src/**/*.svelte"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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
});
