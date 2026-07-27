/**
 * Normalizes each backend's citation shape into one `Citation[]`.
 *
 * Codex is the richest source: its `url_citation` annotations carry
 * `start_index`/`end_index` into the answer text, so `answer.slice(start, end)`
 * yields the exact sentence the model attributed to that source. xAI returns
 * bare URLs, so the sentence has to be recovered from the inline `[[n]](url)`
 * markers instead.
 *
 * Implementation lands in phase 1; the types are needed by storage.ts now.
 */

export type Backend = "codex" | "xai" | "tavily" | "perplexity" | "exa";

export interface Citation {
  url: string;
  title?: string;
  /** Offset into the answer text, when the backend provides one. */
  startIndex?: number;
  endIndex?: number;
}

export interface SearchCall {
  query?: string;
  url?: string;
  status?: string;
}

export interface SearchAnswer {
  backend: Backend;
  query: string;
  answer: string;
  citations: Citation[];
  searchCalls: SearchCall[];
  raw: unknown;
}

/** Dedupes by URL, preserving first-seen order — that order becomes the rank. */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const citation of citations) {
    let normalized: string;
    try {
      normalized = new URL(citation.url).toString();
    } catch {
      continue; // Relative or malformed URLs are not citable.
    }
    if (!seen.has(normalized)) seen.set(normalized, { ...citation, url: normalized });
  }
  return Array.from(seen.values());
}
