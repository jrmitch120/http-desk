<script lang="ts">
  // The Environments matrix (#83): one row per variable, a column for the
  // shared variables and one per environment, so a variable missing from
  // staging stands out. It edits the modal's unsaved set in place (see
  // src/lib/envMatrix.ts), so saving is the modal's usual save.
  import type { EnvironmentSet } from "../lib/types";
  import { app } from "../lib/store.svelte";
  import { menu, type MenuItem } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { envValueProvider, SHARED } from "../lib/vars";
  import type { Definition, VarProvider } from "../lib/codemirror/setup";
  import { matrixCell, matrixColumns, matrixNames, nextSort, removeEverywhere, rowMatches, setCell, sortNames, unsetCell } from "../lib/envMatrix";
  import KeyValueGrid, { type Column, type GridCell } from "./KeyValueGrid.svelte";
  import VarField from "../lib/codemirror/VarField.svelte";
  import Icon from "./Icon.svelte";
  import { SvelteSet } from "svelte/reactivity";

  interface Props {
    /** The modal's set, as edited. Cells write into it. */
    set: EnvironmentSet;
    /** Narrows the rows (names, and shareable values in any column). */
    filter?: string;
    /** More commands for a variable's row menu (right-click on its name, or its actions button), listed before Delete. */
    rowActions?: (name: string) => MenuItem[];
    /** What else the values can refer to, under `set`'s own: below the root, the environments the folder's requests get (ADR-0004). */
    inherited?: EnvironmentSet | null;
    /** The header's last cell, "+ Environment": adds an environment (a new column). */
    onaddenvironment?: () => void;
  }
  let { set, filter = "", rowActions = () => [], inherited = null, onaddenvironment }: Props = $props();

  /** A row: just the variable's name. Its cells are looked up in `set`. */
  interface MatrixRow {
    name: string;
    value: string;
  }

  // Rows are keyed by object in the grid, so each name keeps one row object:
  // an edit that changes `set` must not remount the row (and drop focus).
  const rowObjects = new Map<string, MatrixRow>();
  const rowFor = (name: string) => {
    let row = rowObjects.get(name);
    if (!row) rowObjects.set(name, (row = { name, value: "" }));
    return row;
  };
  // The rows' order is kept here, not re-derived from `set` alone: filling or
  // unsetting a cell changes where a name is first seen, and the row must not
  // jump while it's being typed in. New names go at the end. A new set (another
  // folder, or the files reloaded) starts from its own order.
  let order: string[] = [];
  let orderOf: EnvironmentSet | null = null;
  const names = $derived.by(() => {
    if (orderOf !== set) [order, orderOf] = [[], set];
    return (order = matrixNames(set, order));
  });
  /** The Variable header's sort, for the app session. It compares names only, so typing a value never moves a row. */
  const sort = $derived(app.envMatrixSort);
  const rows = $derived(sortNames(names, sort).map(rowFor));
  const columns = $derived(matrixColumns(set));
  const columnLabel = (column: string) => (column === SHARED ? "Shared" : column);
  /** Grid column ids are positional (`m0`, `m1`…), since environment names can hold anything. */
  const columnAt = (id: string) => columns[Number(id.slice(1))];

  /** What each column's values can refer to: that environment (as edited) over the shared variables, over what's inherited. */
  const providers = $derived(
    new Map<string, VarProvider>(
      columns.map((column) => [
        column,
        {
          ...envValueProvider(set, inherited, column),
          edit: (d: Definition) => {
            app.definitionWanted = d;
          },
        },
      ]),
    ),
  );

  /** Secrets shown in plain text, by column then name. */
  const revealed = new SvelteSet<string>();
  const key = (column: string, name: string) => JSON.stringify([column, name]);

  const ariaSort = { asc: "ascending", desc: "descending" } as const;
  /** The last column: wide enough for its header's "+ Environment". */
  const ACTIONS_WIDTH = 124;
  const gridColumns = $derived<Column<MatrixRow>[]>([
    { id: "name", header: "Variable", width: "150px", cell: nameCell, headerCell: variableHeader, sort: ariaSort[sort] },
    ...columns.map((column, i): Column<MatrixRow> => ({ id: `m${i}`, header: columnLabel(column), width: "minmax(170px, 1fr)", cell: valueCell })),
    // Each row's actions button, under the header's "+ Environment".
    { id: "actions", header: "", width: `${ACTIONS_WIDTH}px`, cell: actionsCell, headerCell: onaddenvironment && addEnvironmentHeader },
  ]);

  function menuFor(name: string): MenuItem[] {
    const extra = rowActions(name);
    return [
      ...extra,
      ...(extra.length ? [{ separator: true }] : []),
      {
        label: "Delete from all environments",
        icon: "trash",
        danger: true,
        action: () => {
          order = order.filter((n) => n !== name);
          removeEverywhere(set, name);
        },
      },
    ];
  }

  /** Unsets the cell (`el`): the column no longer defines the variable. Focus stays in
   *  the cell, on its Secret lock, rather than in a field that would show the old text. */
  function unset(column: string, name: string, el: HTMLElement) {
    unsetCell(set, column, name);
    el.querySelector<HTMLElement>(".lock")?.focus();
  }

  /** A set cell's context menu. A cell that isn't set keeps the webview's own menu. */
  function cellMenu(e: MouseEvent, column: string, name: string) {
    if (matrixCell(set, column, name).state !== "set") return;
    const el = e.currentTarget as HTMLElement;
    menu.show(e, [{ label: `Unset in ${columnLabel(column)}`, icon: "x", action: () => unset(column, name, el) }]);
  }

  let root: HTMLDivElement;
  /** Focuses the cell of `name` in `column`, scrolled into view (a hover card's Edit). False if it isn't shown. */
  export function focusCell(column: string, name: string): boolean {
    const i = columns.indexOf(column);
    const cell = [...root.querySelectorAll<HTMLElement>(`.m-cell[data-column="m${i}"]`)].find((el) => el.dataset.name === name);
    const target = cell?.querySelector<HTMLElement>('[role="textbox"], .cm-content');
    if (!target) return false;
    target.scrollIntoView({ block: "nearest" });
    target.focus();
    return true;
  }

  /** Scrolls `column`'s header into view, then the "+ Environment" after it (a new environment's column, added at the end). */
  export function revealColumn(column: string) {
    for (const cls of [`c-m${columns.indexOf(column)}`, "c-actions"]) root.querySelector(`.kv-head > .${cls}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
</script>

{#snippet variableHeader()}
  <button
    class="head-btn sort"
    use:tooltip={sort === "asc" ? "Sorted A to Z. Click for Z to A" : "Sorted Z to A. Click for A to Z"}
    onclick={() => (app.envMatrixSort = nextSort(sort))}
  >
    Variable<Icon name={sort === "asc" ? "arrow-up" : "arrow-down"} size={12} />
  </button>
{/snippet}

{#snippet addEnvironmentHeader()}
  <button class="head-btn add-env" aria-label="New environment" use:tooltip={"Add an environment (a new column)"} onclick={onaddenvironment}>
    <Icon name="plus" size={13} />Environment
  </button>
{/snippet}

{#snippet nameCell({ row }: GridCell<MatrixRow>)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="cell m-name ellipsis" oncontextmenu={(e) => menu.show(e, menuFor(row.name))}>{row.name}</span>
{/snippet}

{#snippet valueCell({ row, column: id }: GridCell<MatrixRow>)}
  {@const column = columnAt(id)}
  {@const cell = matrixCell(set, column, row.name)}
  {@const variable = cell.state === "set" ? cell.variable : null}
  {@const shown = !variable?.secret || revealed.has(key(column, row.name))}
  {@const label = columnLabel(column)}
  <!-- svelte-ignore a11y_no_static_element_interactions (the menu's command is also the cell's Unset button) -->
  <div class="m-cell" class:gap={cell.state === "gap"} class:set={cell.state === "set"} data-column={id} data-name={row.name} oncontextmenu={(e) => cellMenu(e, column, row.name)}>
    <VarField
      class="cell"
      value={variable?.value ?? ""}
      placeholder={cell.state === "gap" || cell.state === "unset" ? "Not set" : cell.state === "shared" ? "Uses shared" : "Empty"}
      label="{row.name} in {label}"
      masked={!shown}
      variables={providers.get(column)}
      onchange={(value) => setCell(set, column, row.name, { value })}
    />
    {#if variable?.secret}
      {@const k = key(column, row.name)}
      <button class="icon-btn reveal" aria-label={shown ? "Hide value" : "Show value"} use:tooltip onclick={() => (shown ? revealed.delete(k) : revealed.add(k))}>
        <Icon name={shown ? "eye-off" : "eye"} size={13} />
      </button>
    {/if}
    {#if variable}
      <button
        class="icon-btn unset"
        aria-label="Unset"
        use:tooltip={`Unset in ${label}: remove it from ${column === SHARED ? "the shared variables" : "this environment"}`}
        onclick={(e) => unset(column, row.name, e.currentTarget.closest<HTMLElement>(".m-cell")!)}
      >
        <Icon name="x" size={13} />
      </button>
    {/if}
    <button
      class="icon-btn lock"
      class:active={variable?.secret}
      aria-label="Secret"
      aria-pressed={!!variable?.secret}
      use:tooltip={variable?.secret
        ? `Secret in ${label}: saved only in http-client.private.env.json. Click to make it shareable.`
        : `Shareable in ${label}: saved in http-client.env.json. Click to make it a Secret.`}
      onclick={() => setCell(set, column, row.name, { secret: !variable?.secret })}
    >
      <Icon name={variable?.secret ? "lock" : "unlock"} size={13} />
    </button>
  </div>
{/snippet}

{#snippet actionsCell({ row }: GridCell<MatrixRow>)}
  <button class="icon-btn actions" aria-label="Actions for {row.name}" aria-haspopup="menu" use:tooltip={"Actions"} onclick={(e) => menu.show(e, menuFor(row.name), { anchor: e.currentTarget, align: "end", label: `Actions for ${row.name}` })}>
    <Icon name="more" size={13} />
  </button>
{/snippet}

<div class="matrix" bind:this={root} style:--matrix-min="{150 + ACTIONS_WIDTH + columns.length * 170}px">
  <KeyValueGrid
    items={rows}
    columns={gridColumns}
    label="Environments matrix"
    visible={(row) => rowMatches(set, row.name, filter)}
    bulkEdit={false}
    addRows={false}
    namePlaceholder="Variable"
  />
  {#if !rows.length}
    <p class="empty muted">No variables yet. Add one to all environments, or switch to the list to add one to a single environment.</p>
  {/if}
</div>

<style>
  .matrix :global(.kv) {
    min-width: var(--matrix-min);
  }
  .m-name {
    display: block;
    align-self: center;
    line-height: 31px;
    color: var(--text);
    cursor: default;
  }
  .m-cell {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: stretch;
  }
  .m-cell > :global(.cell) {
    flex: 1;
  }
  /* A variable the environment doesn't define (and Shared doesn't supply). */
  .m-cell.gap {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    box-shadow: inset 2px 0 0 var(--warning);
  }
  /* Set to an empty value: "Empty", in italics, so it doesn't read as "Not set". */
  .m-cell.set :global(.vf-static:empty::before),
  .m-cell.set :global(.cm-placeholder) {
    font-style: italic;
  }
  .reveal,
  .unset,
  .lock {
    align-self: center;
    flex: none;
    width: 22px;
    height: 22px;
  }
  .lock {
    margin-right: var(--space-1);
    opacity: 0.55;
  }
  .lock.active,
  .m-cell:hover .lock,
  .lock:focus-visible {
    opacity: 1;
  }
  /* Like the row's actions: shown on hover, and while the cell has focus. */
  .unset {
    opacity: 0;
  }
  .m-cell:hover .unset,
  .m-cell:focus-within .unset {
    opacity: 1;
  }
  .unset:hover {
    color: var(--danger);
  }
  /* Header cells that are buttons: the Variable sort and "+ Environment". */
  .head-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-h-sm);
    padding: 0 var(--space-2) 0 7px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    color: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .head-btn:hover {
    background: var(--hover);
    color: var(--text);
  }
  .head-btn:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .sort {
    flex: 1;
    min-width: 0;
    margin-right: var(--space-1);
  }
  .actions {
    margin: auto 0 auto var(--space-1);
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    opacity: 0;
  }
  /* Like the list's delete button: shown on hover, and while the row has focus. */
  .matrix :global(.kv-row:hover .actions),
  .matrix :global(.kv-row:focus-within .actions) {
    opacity: 1;
  }
  .empty {
    padding: 14px var(--space-1);
    font-size: 12px;
  }
</style>
