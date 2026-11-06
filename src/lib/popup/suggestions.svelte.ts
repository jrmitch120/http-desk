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
//
// For text with structure (a JSONPath filter), pass a `source` instead of
// `options`: it suggests for the text before the caret, and accepting replaces
// just that part (from its `from` up to the caret) with the match's `insert`.
import { mount, unmount } from "svelte";
import SuggestionList from "../../components/SuggestionList.svelte";
import { matchSuggestions, type SuggestionMatch } from "../suggest";
import { popupLayer } from "./layer";

/** A suggestion from a `source`: `value` is shown, `insert` replaces the typed part. */
export interface SourceMatch extends SuggestionMatch {
  insert: string;
}

/** What a `source` suggests: accepting a match replaces `value.slice(from, caret)`. */
export interface SourceSuggestions {
  from: number;
  matches: SourceMatch[];
}

export interface SuggestionsOptions {
  /** Values for the whole input (header names). */
  options?: readonly string[];
  /** Or suggestions computed from the text before the caret. */
  source?: (value: string, caret: number) => SourceSuggestions | null;
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
  /** Where accepting from the open list starts replacing, and each match's text to insert. */
  let replaceFrom = 0;
  let inserts: string[] = [];
  const enabled = () => !!opts.source || !!opts.options?.length;

  /** The suggestions for the input's text and caret. */
  function suggest(): SourceSuggestions | null {
    const value = input.value;
    if (opts.source) return opts.source(value, input.selectionStart ?? value.length);
    return { from: 0, matches: matchSuggestions(value, opts.options ?? []).map((m) => ({ ...m, insert: m.value })) };
  }

  function sync() {
    const open = list !== null;
    if (!enabled()) {
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

  function open(found: SourceSuggestions | null) {
    if (!found?.matches.length) return close();
    replaceFrom = found.from;
    inserts = found.matches.map((m) => m.insert);
    view.matches = found.matches.map(({ value, from, to }) => ({ value, from, to }));
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
    const insert = inserts[i];
    const from = replaceFrom;
    close();
    if (insert === undefined) return;
    // A list of whole values replaces all the text; a source, up to the caret.
    const v = input.value;
    const to = opts.source ? (input.selectionStart ?? v.length) : v.length;
    input.value = v.slice(0, from) + insert + v.slice(to);
    const caret = from + insert.length;
    input.setSelectionRange(caret, caret);
    accepting = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    accepting = false;
  }

  function onInput() {
    if (accepting || !enabled()) return;
    if (!input.value.trim()) return close();
    open(suggest());
  }

  function move(by: number) {
    const n = view.matches.length;
    view.active = (view.active + by + n) % n;
    sync();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!enabled()) return;
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      return open(suggest());
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
      const changed = !!next.source && next.source !== opts.source;
      opts = next;
      if (!enabled()) close();
      // A source whose data loads late answers what was typed while it loaded.
      else if (changed && !list && document.activeElement === input && input.value.trim()) open(suggest());
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
