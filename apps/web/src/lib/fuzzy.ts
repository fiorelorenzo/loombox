/**
 * A small, dependency-free fuzzy subsequence matcher (SPEC.md §7.3
 * "Keyboard & command palette are a cross-cutting requirement: a fuzzy
 * jump-to-session/project quick-switcher"; issue #132). No new dependency
 * per this wave's brief — this is the same class of algorithm VS Code's
 * quick-open and most fuzzy-finders use (subsequence match + a positional
 * score), just hand-rolled small.
 */

/** A query matches `text` when every query character appears in `text`, in order (not necessarily contiguous), case-insensitively. */
export function fuzzyMatch(query: string, text: string): { matched: boolean; score: number } {
  if (query === '') return { matched: true, score: 0 };

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let qi = 0;
  let score = 0;
  let previousMatchIndex = -1;
  let consecutiveRun = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    // Reward: a match right at the start of `text`, a match right after
    // the previous one (a contiguous run — "sesh" inside "session" scores
    // higher than the same letters scattered far apart), and a match that
    // starts a word (after a space/-/_) — the usual fuzzy-finder heuristics.
    let charScore = 1;
    if (ti === 0) charScore += 3;
    if (ti === previousMatchIndex + 1) {
      consecutiveRun += 1;
      charScore += consecutiveRun * 2;
    } else {
      consecutiveRun = 0;
      if (ti > 0 && /[\s\-_/]/.test(t[ti - 1])) charScore += 2;
    }

    score += charScore;
    previousMatchIndex = ti;
    qi += 1;
  }

  return { matched: qi === q.length, score };
}

/** Filters and sorts `items` by fuzzy match score against `getText(item)`, best match first. An empty query returns every item unfiltered, in its original order (issue #132's "quick-switcher" should show everything before the user types anything). */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...items];

  const scored = items
    .map((item) => ({ item, ...fuzzyMatch(trimmed, getText(item)) }))
    .filter((entry) => entry.matched);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}
