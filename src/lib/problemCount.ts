/** The Problems count as the window status bar shows it, in a fixed-width button that
 *  has room for three characters: counts above 99 show as "99+". */
export function shownProblemCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
