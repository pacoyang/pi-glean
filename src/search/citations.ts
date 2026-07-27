/**
 * Normalizes each backend's citation shape into one `Citation[]`.
 *
 * Codex is the richest source: its `url_citation` annotations carry
 * `start_index`/`end_index` into the answer text, so `answer.slice(start, end)`
 * yields the exact sentence the model attributed to that source. xAI returns
 * bare URLs, so the sentence has to be recovered from the inline `[[n]](url)`
 * markers instead.
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

/** Renders citations as a numbered source list; rank is the array position. */
export function formatSources(citations: Citation[]): string {
  if (citations.length === 0) return "";
  const lines = citations.map((citation, index) => {
    const label = citation.title ?? hostnameOf(citation.url) ?? citation.url;
    return `${index + 1}. ${label}\n   ${citation.url}`;
  });
  return `**Sources**\n${lines.join("\n")}`;
}

export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
