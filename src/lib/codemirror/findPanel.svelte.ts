// The editor's search panel: CodeMirror's search state and commands, shown
// through the app's own FindBar.svelte instead of the default panel (which
// builds native checkboxes and unstyled buttons). Plugged in with
// `search({ createPanel: createFindPanel })` in setup.ts.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import FindBar from "./FindBar.svelte";

/** What the find bar edits: the fields of a CodeMirror SearchQuery. */
export interface FindQuery {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

/** What the find bar's controls do. */
export interface FindActions {
  /** Pushes the edited query to the editor (highlights matches). */
  commit(): void;
  next(): void;
  previous(): void;
  replaceNext(): void;
  replaceAll(): void;
  close(): void;
}

/** The editable fields of a CodeMirror search query. */
function toFindQuery(q: SearchQuery): FindQuery {
  return { search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord };
}

export function createFindPanel(view: EditorView): Panel {
  let current = getSearchQuery(view.state);
  const query = $state<FindQuery>(toFindQuery(current));
  const actions: FindActions = {
    commit() {
      const next = new SearchQuery({ ...query });
      if (next.eq(current)) return;
      current = next;
      view.dispatch({ effects: setSearchQuery.of(next) });
    },
    next: () => findNext(view),
    previous: () => findPrevious(view),
    replaceNext: () => replaceNext(view),
    replaceAll: () => replaceAll(view),
    close: () => closeSearchPanel(view),
  };

  const dom = document.createElement("div");
  // Escape (and the other search-panel keys in searchKeymap) act from inside the bar.
  dom.addEventListener("keydown", (e) => {
    if (!e.defaultPrevented && runScopeHandlers(view, e, "search-panel")) e.preventDefault();
  });
  const bar = mount(FindBar, { target: dom, props: { query, readonly: view.state.readOnly, actions } });
  flushSync(); // mount doesn't run effects, and the bar's bind:this is one
  const field = bar.findField();
  // openSearchPanel (⌘/Ctrl F while the bar is open) focuses the [main-field] input.
  field?.setAttribute("main-field", "true");

  return {
    dom,
    top: true,
    mount: () => field?.select(),
    update(u: ViewUpdate) {
      // Keep the bar in step when the query changes from outside (⌘/Ctrl F with a selection).
      for (const tr of u.transactions)
        for (const effect of tr.effects)
          if (effect.is(setSearchQuery) && !effect.value.eq(current)) {
            current = effect.value;
            Object.assign(query, toFindQuery(effect.value));
          }
    },
    destroy: () => void unmount(bar),
  };
}
