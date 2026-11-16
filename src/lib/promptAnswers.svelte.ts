// What the workspace's Session remembers for a request's Prompt variables, for views
// that show it (the editor's variable marks and cards, the resolved preview): a
// `sessionView`, so it's read again whenever the Session changes.
import { api } from "./api";
import { requestPrompts } from "./http";
import { sessionView } from "./sessionView.svelte";
import { app, type Tab } from "./store.svelte";

/**
 * The tab's request's remembered prompt answers, by name, kept current. Empty until
 * the shell answers, and for a request without prompts (which never asks it). Call
 * while a component initializes: it reads from an effect.
 */
export function promptAnswersOf(tab: () => Tab): { readonly current: Record<string, string> } {
  // A boolean, so editing the request doesn't ask the shell again on every keystroke.
  const prompted = $derived.by(() => {
    const req = app.requestFor(tab());
    return !!req && requestPrompts(req).length > 0;
  });
  const answers = sessionView<Record<string, string>>(() => (prompted ? api.promptAnswers(tab().key) : Promise.resolve({})), {});
  return {
    get current() {
      return answers.current ?? {};
    },
  };
}
