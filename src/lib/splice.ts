// The one rule for putting a new sequence in place of an old one by changing only the
// span where they differ: an editor's text (Editor.svelte's `setValue`), so a selection
// outside that span stays put, and a document's requests (`TextViews`), so only what
// shows the requests an edit changed is updated.

/**
 * How many items an old sequence of `before` items and a new one of `after` share at
 * their start (`head`), and then at their end (`tail`): what lies between is all that
 * differs. `same(i, j)` says whether the old one's item `i` is the new one's item `j`.
 */
export function sharedEnds(before: number, after: number, same: (i: number, j: number) => boolean): { head: number; tail: number } {
  let head = 0;
  while (head < before && head < after && same(head, head)) head++;
  let tail = 0;
  while (tail < before - head && tail < after - head && same(before - 1 - tail, after - 1 - tail)) tail++;
  return { head, tail };
}
