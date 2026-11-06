// Sets the page theme before its first paint. theme.rs injects this as the main
// window's initialization script, replacing the placeholder in the last line
// with the saved theme setting as a JSON string; e2e/startup-theme.spec.ts runs
// the same file. System (or anything unknown) resolves the way `effectiveTheme`
// in src/lib/store.svelte.ts does: dark unless the OS appearance says otherwise.
(function (choice) {
  var theme =
    choice === "light" || choice === "dark" ? choice : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  var apply = function () {
    document.documentElement.dataset.theme = theme;
  };
  if (document.documentElement) return apply();
  // Some webviews run this before <html> exists. The observer fires as the parser
  // adds it, which is still before the first paint.
  new MutationObserver(function (_, observer) {
    if (!document.documentElement) return;
    observer.disconnect();
    apply();
  }).observe(document, { childList: true });
})(__THEME__);
