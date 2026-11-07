<script lang="ts">
  // A single-line variable-aware text field (#76): `{{name}}` is marked by
  // state, hovering one shows the variable's card, and typing `{{` offers the
  // names in scope. It never holds a line break.
  //
  // It is cheap enough for hundreds of grid rows: while it doesn't have focus
  // it is a static rendering of the text (a focusable `textbox`), and the
  // CodeMirror editor exists only while it has focus. Focus from the keyboard
  // selects all, as in a text input; a click puts the caret (or starts a drag
  // selection) where it lands. The editor owns the text while it has focus;
  // `value` changes from elsewhere show once it loses focus.
  //
  // A `masked` field (a password or a Secret) draws its text as discs and marks
  // nothing, so neither the marks nor a hover card give the text away;
  // autocomplete still works.
  //
  // Text that doesn't fit shows in full in a tooltip, on hover (the static
  // rendering) or keyboard focus (the editor); never for a masked field.
  import { flushSync } from "svelte";
  import { Compartment, EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { masked as maskedExt, singleLineExtensions, theme, varCard, variableExtensions, type VarProvider } from "./setup";
  import { isHeld } from "./holds";
  import { varSegments } from "../vars";
  import { popup } from "../popup/popup";
  import { hideTooltip, tip, tooltip } from "../popup/tooltip.svelte";

  interface Props {
    value: string;
    /** Every edit, with the whole text. */
    onchange: (value: string) => void;
    /** Highlighting, hover cards and autocomplete come from it; without one the field is plain text. */
    variables?: VarProvider | null;
    placeholder?: string;
    /** Accessible name. */
    label?: string;
    /** Enter (and ⌘/Ctrl+Enter). Without it Enter does nothing and ⌘/Ctrl+Enter reaches the app's shortcut. */
    onenter?: () => void;
    /** Draws the text as discs, as a password input does. */
    masked?: boolean;
    /** Marks the field `aria-invalid` (the owner shows the error and the red border). */
    invalid?: boolean;
    /** Classes on the root, e.g. a grid's `cell`. The root sets no padding or font: they come from here. */
    class?: string;
  }
  let { value, onchange, variables = null, placeholder = "", label, onenter, masked = false, invalid = false, class: cls = "" }: Props = $props();

  let root: HTMLDivElement | undefined;
  let staticEl = $state<HTMLDivElement>();
  let editing = $state(false);
  let view: EditorView | null = null;
  /** The press that started editing, replayed on the editor so the caret lands under the pointer. */
  let press: MouseEvent | null = null;
  /** Where a right-click that started editing was: the caret goes there. */
  let caretAt: { x: number; y: number } | null = null;
  const varC = new Compartment();
  const vars = (p: VarProvider | null, masked: boolean, invalid: boolean) => [
    p ? variableExtensions(p, { marks: !masked }) : [],
    masked ? maskedExt : [],
    invalid ? EditorView.contentAttributes.of({ "aria-invalid": "true" }) : [],
  ];

  const segments = $derived(masked ? (value ? [{ text: "•".repeat([...value].length) }] : []) : varSegments(value, variables));

  function startFromPointer(e: MouseEvent) {
    // A right-click doesn't focus the field (which would select all): its menu puts the caret instead.
    if (e.button === 2) e.preventDefault();
    if (e.button !== 0) return;
    e.preventDefault();
    press = e;
    editing = true;
    flushSync();
  }

  // A press on the field's own padding (outside the text) focuses it too, as in an input.
  function onrootdown(e: MouseEvent) {
    if (e.target !== root) return;
    if (editing) e.preventDefault();
    else startFromPointer(e);
  }

  function editor(host: HTMLDivElement) {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          theme,
          EditorView.theme({
            "&": { height: "100%", fontSize: "inherit" },
            // Scrolls horizontally (wheel, trackpad, caret, drag-select) without a visible scrollbar.
            ".cm-scroller": { overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", fontFamily: "inherit", lineHeight: "inherit", alignItems: "center" },
            ".cm-scroller::-webkit-scrollbar": { display: "none" },
            ".cm-content": { padding: "0" },
            ".cm-line": { padding: "0" },
          }),
          singleLineExtensions({ placeholder, label, onenter }),
          varC.of(vars(variables, masked, invalid)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString());
          }),
        ],
      }),
    });
    const e = press;
    press = null;
    if (e) {
      const { clientX, clientY, screenX, screenY, button, buttons, detail, shiftKey, altKey, ctrlKey, metaKey } = e;
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY, screenX, screenY, button, buttons, detail, shiftKey, altKey, ctrlKey, metaKey }));
    }
    // Focus from the keyboard: the whole text in a tooltip if it doesn't fit (a click doesn't pop one).
    const v = view;
    const tipOnFocus = e ? null : tooltip(v.contentDOM, () => (!masked && v.scrollDOM.scrollWidth > v.scrollDOM.clientWidth ? v.state.doc.toString() : null));
    const at = caretAt;
    caretAt = null;
    if (!view.hasFocus) {
      view.focus();
      const pos = at && view.posAtCoords(at);
      view.dispatch({ selection: pos === null || pos === undefined ? { anchor: 0, head: view.state.doc.length } : { anchor: pos } });
    }
    return {
      destroy() {
        tipOnFocus?.destroy();
        view?.destroy();
        view = null;
      },
    };
  }

  $effect(() => {
    const ext = vars(variables, masked, invalid);
    view?.dispatch({ effects: varC.reconfigure(ext) });
  });

  // Back to the static rendering once focus has really left: not while the
  // window is in the background (the field keeps focus then, as an input does),
  // nor while its edit menu or Extract to variable form has it (holds.ts: a Paste
  // or the answer replaces the selection).
  function onfocusout() {
    setTimeout(() => {
      // `root` is gone when the field was removed with focus in it (a modal closing).
      if (editing && root && !root.contains(document.activeElement) && !(view && isHeld(view))) editing = false;
    });
  }

  // A right-click on the static rendering (or the field's padding) opens the edit
  // menu of the editor, with the caret where it was clicked (src/lib/editMenu.ts).
  function onmenu(e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest(".cm-editor")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!editing) {
      caretAt = { x: e.clientX, y: e.clientY };
      editing = true;
      flushSync();
    }
    view?.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
  }

  /** Puts focus in the field (and selects its text). */
  export function focus() {
    if (view) view.focus();
    else staticEl?.focus();
  }

  // ---- the static rendering's tooltip: the whole text, when it doesn't fit and isn't masked.
  // Not over a `{{variable}}`, whose hover card says more.
  let overMark = false;
  const cutText = () => (!masked && !overMark && staticEl && staticEl.scrollWidth > staticEl.clientWidth ? value : null);

  // ---- hover cards on the static rendering (the editor has its own)
  let card = $state<{ anchor: HTMLElement; name: string } | null>(null);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function onpointerover(e: PointerEvent) {
    const mark = (e.target as Element).closest<HTMLElement>("[data-var]");
    overMark = !!mark;
    if (mark && tip.anchor === staticEl) hideTooltip(false);
    clearTimeout(showTimer);
    if (!mark) {
      if (card) hideSoon();
      return;
    }
    clearTimeout(hideTimer);
    if (card?.anchor === mark) return;
    // CodeMirror's hover delay, so both cards feel the same.
    showTimer = setTimeout(() => (card = { anchor: mark, name: mark.dataset.var! }), 300);
  }
  function hideSoon() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (card = null), 120);
  }
  function hideNow() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    card = null;
  }
  function fill(node: HTMLElement, c: { name: string }) {
    const render = (c: { name: string }) => variables && node.replaceChildren(varCard(c.name, variables.info(c.name), { edit: variables.edit, findUsages: variables.findUsages, close: hideNow }));
    render(c);
    return { update: render };
  }
  $effect(() => {
    if (editing) hideNow();
  });
  $effect(() => () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the textbox inside is the field; this only widens its pointer target) -->
<div class="var-field {cls}" class:editing bind:this={root} {onfocusout} onmousedown={onrootdown} oncontextmenu={onmenu}>
  {#if editing}
    <div class="vf-editor" use:editor></div>
  {:else}
    <div
      bind:this={staticEl}
      class="vf-static"
      role="textbox"
      tabindex="0"
      aria-label={label}
      aria-placeholder={placeholder || undefined}
      aria-multiline="false"
      aria-invalid={invalid ? "true" : undefined}
      data-placeholder={placeholder}
      onfocus={() => (editing = true)}
      onmousedown={startFromPointer}
      use:tooltip={cutText}
      {onpointerover}
      onpointerleave={hideSoon}
    >{#each segments as s, i (i)}{#if s.name !== undefined}<span class={s.cls} data-var={s.name}>{s.text}</span>{:else}{s.text}{/if}{/each}</div>
  {/if}
</div>

{#if card}
  <div class="popup-surface vf-card" role="tooltip" use:popup={{ anchor: card.anchor, onclose: hideNow }} use:fill={card} onpointerenter={() => clearTimeout(hideTimer)} onpointerleave={hideSoon}></div>
{/if}

<style>
  .var-field {
    display: flex;
    align-items: center;
    min-width: 0;
    line-height: 20px;
    cursor: text;
  }
  .vf-static,
  .vf-editor {
    flex: 1;
    min-width: 0;
  }
  /* The text colour is the owner's (a grid dims a disabled row's cells). */
  .vf-editor :global(.cm-editor) {
    color: inherit;
  }
  .vf-static {
    overflow: hidden;
    white-space: pre;
    outline: none;
  }
  .vf-static:empty::before {
    content: attr(data-placeholder);
    color: var(--faint);
  }
</style>
