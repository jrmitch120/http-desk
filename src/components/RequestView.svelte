<script lang="ts">
  // Request editor + response viewer in a resizable split.
  import { app, type Tab } from "../lib/store.svelte";
  import RequestEditor from "./RequestEditor.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";

  let { tab }: { tab: Tab } = $props();

  const vertical = $derived(app.settings?.layout === "vertical");
  let ratio = $state(Number(localStorage.getItem("splitRatio")) || 0.5);
  let container: HTMLDivElement;

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const r = vertical ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      ratio = Math.min(0.8, Math.max(0.2, r));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("splitRatio", String(ratio));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<div class="split" class:vertical bind:this={container}>
  <div class="pane" style:flex-basis="{ratio * 100}%">
    <RequestEditor {tab} />
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="divider" onpointerdown={startResize}></div>
  <div class="pane response" style:flex-basis="{(1 - ratio) * 100}%">
    <ResponseViewer {tab} />
  </div>
</div>

<style>
  .split {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .split.vertical {
    flex-direction: column;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    flex-grow: 0;
    flex-shrink: 1;
    overflow: hidden;
  }
  .response {
    background: var(--panel);
  }
  .divider {
    flex: none;
    width: 1px;
    background: var(--border);
    cursor: col-resize;
    position: relative;
  }
  .divider::after {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }
  .divider:hover {
    background: var(--focus);
  }
  .vertical .divider {
    width: auto;
    height: 1px;
    cursor: row-resize;
  }
  .vertical .divider::after {
    inset: -3px 0;
  }
</style>
