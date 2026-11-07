<script lang="ts">
  // The strip above a request's sections listing what the request would be sent
  // with (src/lib/checks.ts): each Undefined variable once, where it is used, and its
  // quick fixes. It never blocks sending, and it isn't there when there's nothing
  // to list. Each kind of check renders in its own branch below.
  import { SECTION_LABELS, type Check, type QuickFix } from "../lib/checks";
  import Icon from "./Icon.svelte";

  let { checks, onfix }: { checks: Check[]; onfix: (check: Check, fix: QuickFix) => void } = $props();

  /** "A", "A and B", "A, B and C". */
  function list(items: string[]): string {
    return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  }
</script>

{#if checks.length}
  <section class="checks" aria-label="Pre-send checks">
    <ul>
      {#each checks as check (check.kind + check.name)}
        <li>
          <span class="icon"><Icon name="alert" size={13} /></span>
          {#if check.kind === "undefined"}
            <span class="message">
              <code>{`{{${check.name}}}`}</code> is undefined, used in {list(check.sections.map((s) => SECTION_LABELS[s]))}
            </span>
            <span class="fixes">
              {#each check.fixes as fix (fix.kind)}
                <button class="btn small ghost" onclick={() => onfix(check, fix)}>
                  {#if fix.kind === "addToEnvironment"}
                    Add <code>{check.name}</code> to {fix.env}
                  {:else if fix.kind === "addFileVariable"}
                    Add as File variable
                  {:else}
                    Select environment {fix.env}, which defines it
                  {/if}
                </button>
              {/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .checks {
    --tone: var(--warning);
    flex: none;
    /* Three entries; more scroll, so a long list doesn't push the sections away. */
    max-height: 150px;
    overflow: auto;
    margin: 0 14px 8px 16px;
    border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--tone) 10%, transparent);
    font-size: 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 2px 0;
  }
  /* The message, with its fixes under it (lined up with the text, not the icon). */
  li {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: var(--space-2);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  }
  li + li {
    border-top: 1px solid color-mix(in srgb, var(--tone) 20%, transparent);
  }
  .icon {
    display: flex;
    color: var(--tone);
  }
  .message {
    min-width: 0;
    color: var(--text-2);
    line-height: 20px;
  }
  code {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--var-bad);
  }
  .message code {
    text-decoration: underline wavy;
    text-decoration-skip-ink: none;
    text-underline-offset: 2px;
  }
  .fixes {
    grid-column: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-1);
    /* A ghost button's text starts its padding in, so pull the first one back to the message's edge. */
    margin-left: calc(-1 * var(--space-2));
  }
  .fixes:empty {
    display: none;
  }
  .fixes .btn code {
    color: inherit;
  }
</style>
