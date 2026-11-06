// Matching for SuggestInput's list (header names today, any name cell later).

export interface SuggestionMatch {
  value: string;
  /** The matched part of `value`, `[from, to)`, which the list underlines. */
  from: number;
  to: number;
}

/**
 * The suggestions worth offering for `text`: names containing it (ignoring
 * case and surrounding spaces), those starting with it first, each group in
 * list order. Empty text offers everything. Nothing is offered once the text
 * is exactly the only match, since accepting it would change nothing.
 */
export function matchSuggestions(text: string, options: readonly string[]): SuggestionMatch[] {
  const q = text.trim();
  const needle = q.toLowerCase();
  const starts: SuggestionMatch[] = [];
  const contains: SuggestionMatch[] = [];
  for (const value of options) {
    const at = value.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    (at === 0 ? starts : contains).push({ value, from: at, to: at + needle.length });
  }
  const all = [...starts, ...contains];
  return all.length === 1 && all[0].value === q ? [] : all;
}
