// `use:suggestions`: turns a text input into a combobox that suggests values
// from a fixed list (header names today; any KeyValueGrid name cell later).
//
//   <input class="cell" value={name} oninput={(e) => setName(e.currentTarget.value)}
//          use:suggestions={{ options: HEADER_NAMES, label: "Header suggestions" }} />
//
// The input stays the caller's element (its classes, value and handlers). The
// list renders in the shared popup layer (SuggestionList.svelte) and behaves
// like CodeMirror's {{variable}} autocomplete: typing opens it, Up/Down move
// (wrapping), Enter or Tab accept, Escape dismisses without changing the text,
// Ctrl+Space opens it on demand. Accepting sets the input's value and fires an
// `input` event, so the caller's `oninput` sees it like typing. Tab accepts and
// still moves focus on. With no options the input is left a plain textbox.
import { mount, unmount } from "svelte";
import SuggestionList from "../../components/SuggestionList.svelte";
import { matchSuggestions, type SuggestionMatch } from "../suggest";
import { popupLayer } from "./layer";

export interface SuggestionsOptions {
  options: readonly string[];
  /** The list's accessible name, e.g. "Header suggestions". */
  label: string;
}

let ids = 0;

export function suggestions(input: HTMLInputElement, initial: SuggestionsOptions) {
  let opts = initial;
  const id = `suggestions-${++ids}`;
  const view = $state({
    id,
    label: opts.label,
    anchor: input as HTMLElement,
    matches: [] as SuggestionMatch[],
    active: 0,
    onpick: (i: number) => accept(i),
    onclose: () => close(),
  });
  let list: ReturnType<typeof mount> | null = null;

  function sync() {
    const open = list !== null;
    if (!opts.options.length) {
      for (const a of ["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-activedescendant"]) input.removeAttribute(a);
      return;
    }
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", String(open));
    if (open) {
      input.setAttribute("aria-controls", id);
      input.setAttribute("aria-activedescendant", `${id}-${view.active}`);
    } else {
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    }
  }

  function open(matches: SuggestionMatch[]) {
    if (!matches.length) return close();
    view.matches = matches;
    view.active = 0;
    view.label = opts.label;
    list ??= mount(SuggestionList, { target: popupLayer(), props: view });
    sync();
  }

  function close() {
    if (list) unmount(list);
    list = null;
    sync();
  }

  // Set while accept() fires its own `input` event, which mustn't reopen the list.
  let accepting = false;
  function accept(i: number) {
    const m = view.matches[i];
    close();
    if (!m) return;
    input.value = m.value;
    input.setSelectionRange(m.value.length, m.value.length);
    accepting = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    accepting = false;
  }

  function onInput() {
    if (accepting || !opts.options.length) return;
    if (!input.value.trim()) return close();
    open(matchSuggestions(input.value, opts.options));
  }

  function move(by: number) {
    const n = view.matches.length;
    view.active = (view.active + by + n) % n;
    sync();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!opts.options.length) return;
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      return open(matchSuggestions(input.value, opts.options));
    }
    if (!list) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Tab accepts and lets focus move on to the next cell.
      if (e.key === "Enter") e.preventDefault();
      accept(view.active);
    }
  }

  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("blur", close);
  sync();

  return {
    update(next: SuggestionsOptions) {
      opts = next;
      if (!opts.options.length) close();
      sync();
    },
    destroy() {
      close();
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("blur", close);
    },
  };
}
