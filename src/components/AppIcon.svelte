<script lang="ts">
  // The app's icon, drawn in the theme's accent colour (Welcome, About HttpDesk).
  let { size }: { size: number } = $props();
</script>

<svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="var(--accent)" />
  <path d="M300 330 L460 512 L300 694" fill="none" stroke="#fff" stroke-width="84" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M540 694 H730" fill="none" stroke="#fff" stroke-width="84" stroke-linecap="round" />
</svg>
