<!--
  A read-only region of its own inside another (readOnly.ts): its fields and editors are
  read-only while `when()` holds, whatever the region around it says. A request tab's
  Source view stays editable while only its own text doesn't parse (#174).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { setReadOnlyRegion } from "./readOnly";

  let { when, children }: { when: () => boolean; children: Snippet } = $props();
  setReadOnlyRegion(() => when());
</script>

{@render children()}
