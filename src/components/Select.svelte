<script module lang="ts">
  export interface SelectOption<V extends string = string> {
    value: V;
    label: string;
    /** CSS colour for the option's text, in the list and on the trigger (e.g. `var(--m-get)`). */
    color?: string;
  }
</script>

<script lang="ts" generics="T extends string">
  // Owned dropdown (ADR 0002). The trigger is a select-only combobox that keeps
  // focus while its listbox is open in the shared popup layer, pointing at the
  // highlighted option with aria-activedescendant. Typing filters the list
  // (case-insensitive, anywhere in the label); arrows, Home/End move; Enter or
  // a click picks; Escape and Tab close without changing anything. `create`
  // offers a "Use X" item for typed text that matches nothing (custom methods).
  // Controlled: it calls `onchange` and the caller updates `value`.
  import { popup, type CloseReason } from "../lib/popup/popup";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    options: SelectOption<T>[];
    value: T;
    onchange: (value: T) => void;
    /** Accessible name of the combobox (and its listbox). */
    label: string;
    /** For typed text no option matches: the value a "Use …" item would pick, or null for no item. */
    create?: (query: string) => T | null;
    /** `sm` is the compact height (`--control-h-sm`) for grid cells. */
    size?: "md" | "sm";
    /** Monospace trigger and list (methods). */
    mono?: boolean;
    /** Tooltip text (use:tooltip). */
    tooltip?: string;
    /** Extra class on the trigger; style it from the parent with `:global(.x)`. */
    class?: string;
  }
  let { options, value, onchange, label, create, size = "md", mono = false, tooltip: tooltipText, class: className = "" }: Props = $props();

  type Item = SelectOption<T> & { created?: boolean };

  const id = $props.id();
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let open = $state(false);
  let query = $state("");
  let active = $state(-1);

  const current = $derived(options.find((o) => o.value === value));
  const items: Item[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    if (matches.length || !q || !create) return matches;
    const made = create(query);
    return made === null ? [] : [{ value: made, label: `Use ${made}`, created: true }];
  });
  const activeItem = $derived(open ? items[active] : undefined);

  $effect(() => {
    if (activeItem) list?.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView({ block: "nearest" });
  });

  function show(text = "") {
    query = text;
    open = true;
    active = text ? 0 : Math.max(0, options.findIndex((o) => o.value === value));
    // WebKit doesn't focus a clicked button; the trigger must have focus to take the keys.
    trigger?.focus();
  }

  /** Opens the list and focuses the trigger, as a click would (e.g. a fix-it button's "Choose environment"). */
  export function openList() {
    if (!open) show();
  }

  function close() {
    open = false;
    query = "";
  }

  function choose(item: Item | undefined) {
    if (!item) return;
    close();
    if (item.value !== value) onchange(item.value);
  }

  function filter(text: string) {
    query = text;
    active = 0;
  }

  function move(to: number) {
    if (items.length) active = Math.min(items.length - 1, Math.max(0, to));
  }

  const typed = (e: KeyboardEvent) => e.key.length === 1 && !e.altKey;

  function onkeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) return; // shortcuts (⌘/Ctrl Enter sends) pass through
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") show();
      else if (typed(e)) show(e.key);
      else return;
    } else if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "PageDown") move(active + 8);
    else if (e.key === "PageUp") move(active - 8);
    else if (e.key === "Enter") choose(activeItem);
    else if (e.key === " " && !query) choose(activeItem);
    else if (e.key === "Backspace") filter(query.slice(0, -1));
    else if (typed(e)) filter(query + e.key);
    else {
      if (e.key === "Tab") close();
      return;
    }
    e.preventDefault();
  }

  function onclose(reason: CloseReason) {
    close();
    if (reason === "escape") trigger?.focus();
  }
</script>

<button
  bind:this={trigger}
  type="button"
  role="combobox"
  class="select-trigger {size} {className}"
  class:mono
  class:open
  aria-label={label}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-controls={open ? listId : undefined}
  aria-activedescendant={activeItem ? optId(active) : undefined}
  use:tooltip={tooltipText ?? null}
  onclick={() => (open ? close() : show())}
  {onkeydown}
  onblur={close}
>
  <span class="value" style:color={current?.color}>{current?.label ?? value}</span>
  <Icon name="chevron-down" size={size === "sm" ? 11 : 12} />
</button>

{#if open}
  <!-- Keeps focus on the trigger when the list is clicked; the keyboard is handled there. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="popup-surface select-popup {size}"
    class:mono
    use:popup={{ anchor: trigger!, matchWidth: true, onclose }}
    onmousedown={(e) => e.preventDefault()}
  >
    {#if query}
      <div class="filter" aria-hidden="true"><Icon name="search" size={12} /><span>{query}</span></div>
    {/if}
    <div class="options" role="listbox" id={listId} aria-label={label} bind:this={list}>
      {#each items as item, i (item.value)}
        <!-- Options aren't focused: the trigger keeps focus and points here with aria-activedescendant. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="option"
          class:active={i === active}
          class:created={item.created}
          role="option"
          tabindex="-1"
          id={optId(i)}
          aria-selected={i === active}
          style:color={item.color}
          onmousemove={() => (active = i)}
          onclick={() => choose(item)}
        >
          <span class="check">{#if !item.created && item.value === value}<Icon name="check" size={12} stroke={2.4} />{/if}</span><span class="label"
            >{item.label}</span
          >
        </div>
      {/each}
    </div>
    {#if !items.length}<div class="empty">No matches</div>{/if}
  </div>
{/if}

<style>
  .select-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--control-h);
    min-width: 0;
    padding: 0 var(--space-2);
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  .select-trigger.sm {
    height: var(--control-h-sm);
    padding: 0 var(--space-1) 0 var(--space-2);
    font-size: 12px;
  }
  .select-trigger:focus-visible {
    border-color: var(--focus);
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .select-trigger.open {
    border-color: var(--focus);
  }
  .select-trigger :global(svg) {
    flex: none;
    color: var(--muted);
  }
  .value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }

  .select-popup {
    padding: var(--space-1);
    font-size: 13px;
    max-width: min(420px, calc(100vw - 12px));
  }
  .select-popup.sm {
    font-size: 12px;
  }
  .options {
    max-height: 280px;
    overflow-y: auto;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    margin-bottom: var(--space-1);
    border-bottom: 1px solid var(--border);
    color: var(--text);
    white-space: pre;
  }
  .filter :global(svg) {
    color: var(--muted);
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .sm .option {
    /* Literal 2px: the compact list is tighter than the scale's smallest step (--space-1). */
    padding: 2px var(--space-2) 2px var(--space-1);
  }
  .option.active {
    background: var(--accent-soft);
  }
  .option.created .label {
    font-style: italic;
  }
  .check {
    display: inline-flex;
    width: 14px;
    flex: none;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: var(--space-1) var(--space-2);
    color: var(--muted);
  }
</style>
