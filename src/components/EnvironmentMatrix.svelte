<script lang="ts">
  // The Environments matrix (#83): one row per variable, a column for the
  // shared variables and one per environment, so a variable missing from
  // staging stands out. It edits the modal's unsaved set in place (see
  // src/lib/envMatrix.ts), so saving is the modal's usual save.
  import type { EnvironmentSet } from "../lib/types";
  import { app } from "../lib/store.svelte";
  import { menu, type MenuItem } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { envVariables, makeVarProvider } from "../lib/vars";
  import type { Definition, VarProvider } from "../lib/codemirror/setup";
  import { matrixCell, matrixColumns, matrixNames, removeEverywhere, rowMatches, setCell, SHARED } from "../lib/envMatrix";
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
  }
  let { set, filter = "", rowActions = () => [], inherited = null }: Props = $props();

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
  const rows = $derived(matrixNames(set).map(rowFor));
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
          ...makeVarProvider({
            env: { ...envVariables(inherited, column === SHARED ? null : column), ...envVariables(set, column === SHARED ? null : column) },
            fileVars: [],
            requestVars: [],
            envName: column,
          }),
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

  const gridColumns = $derived<Column<MatrixRow>[]>([
    { id: "name", header: "Variable", width: "150px", cell: nameCell },
    ...columns.map((column, i): Column<MatrixRow> => ({ id: `m${i}`, header: columnLabel(column), width: "minmax(170px, 1fr)", cell: valueCell })),
    // "delete" keeps the last value column free of a divider, like the list's delete column.
    { id: "delete", header: "", width: "34px", cell: actionsCell },
  ]);

  function menuFor(name: string): MenuItem[] {
    const extra = rowActions(name);
    return [
      ...extra,
      ...(extra.length ? [{ separator: true }] : []),
      { label: "Delete from all environments", icon: "trash", danger: true, action: () => removeEverywhere(set, name) },
    ];
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
</script>

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
  <div class="m-cell" class:gap={cell.state === "gap"} data-column={id} data-name={row.name}>
    <VarField
      class="cell"
      value={variable?.value ?? ""}
      placeholder={cell.state === "gap" ? "Missing" : cell.state === "shared" ? "Uses shared" : cell.state === "unset" ? "Not set" : ""}
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

<div class="matrix" bind:this={root} style:--matrix-min="{150 + 34 + columns.length * 170}px">
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
  .reveal,
  .lock {
    align-self: center;
    flex: none;
    width: 22px;
    height: 22px;
  }
  .lock {
    margin-right: 4px;
    opacity: 0.55;
  }
  .lock.active,
  .m-cell:hover .lock,
  .lock:focus-visible {
    opacity: 1;
  }
  .actions {
    margin: auto;
    width: 24px;
    height: 24px;
    opacity: 0;
  }
  /* Like the list's delete button: shown on hover, and while the row has focus. */
  .matrix :global(.kv-row:hover .actions),
  .matrix :global(.kv-row:focus-within .actions) {
    opacity: 1;
  }
  .empty {
    padding: 14px 4px;
    font-size: 12px;
  }
</style>
