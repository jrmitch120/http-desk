// What the workspace's Session remembers for a request's Prompt variables, for views
// that show it (the editor's variable marks and cards, the resolved preview). The
// Session lives in the shell; this only reads it, and reads it again whenever the
// store says the Session changed (`app.sessionVersion`).
import { app, type Tab } from "./store.svelte";
import { requestPrompts } from "./http";

/**
 * The tab's request's remembered prompt answers, by name, kept current. Empty until
 * the shell answers, and for a request without prompts (which never asks it). Call
 * while a component initializes: it reads from an effect.
 */
export function promptAnswersOf(tab: () => Tab): { readonly current: Record<string, string> } {
  let answers = $state<Record<string, string>>({});
  // A boolean, so editing the request doesn't ask the shell again on every keystroke.
  const prompted = $derived.by(() => {
    const req = app.requestFor(tab());
    return !!req && requestPrompts(req).length > 0;
  });
  $effect(() => {
    void app.sessionVersion;
    if (!prompted) {
      answers = {};
      return;
    }
    let live = true;
    app.promptAnswers(tab()).then(
      (a) => live && (answers = a),
      () => live && (answers = {}),
    );
    return () => (live = false);
  });
  return {
    get current() {
      return answers;
    },
  };
}
