/** Text helpers used by the retrieval layer and the tool output formatters. */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
  'this', 'that', 'these', 'those', 'we', 'you', 'i', 'they', 'he', 'she', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'no',
  'add', 'make', 'need', 'want', 'please', 'implement', 'create', 'use', 'using', 'into',
]);

/** Extract candidate search terms from a free-form request. */
export function extractKeywords(input: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/** Truncate to a byte-ish budget, keeping the head and tail (most informative). */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 40;
  return (
    text.slice(0, head) +
    `\n\n... [truncated ${text.length - maxChars} characters] ...\n\n` +
    text.slice(text.length - Math.max(tail, 0))
  );
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... [truncated]`;
}

/** Rough token estimate (~4 chars/token). Only used for budgeting, never billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function slugify(input: string, maxLength = 48): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength) || 'task';
}

/** Score text against keywords — the fallback ranker when Mongo text search is unavailable. */
export function keywordScore(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    let index = haystack.indexOf(kw);
    while (index !== -1) {
      score += 1;
      index = haystack.indexOf(kw, index + kw.length);
      if (score > 50) return score;
    }
  }
  return score;
}
