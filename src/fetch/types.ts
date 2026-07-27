/** Shared shapes for the fetch/extract pipeline. */

export interface FrameData {
  data: string;
  mimeType: string;
}

export interface VideoFrame extends FrameData {
  /** Human-readable position, e.g. `1:23`. */
  timestamp: string;
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  /** Stripped before the record reaches the session log. */
  thumbnail?: FrameData;
  /** Stripped before the record reaches the session log. */
  frames?: VideoFrame[];
  /** Total media duration in seconds, when known. */
  duration?: number;
  /** Which path produced this content: `http`, `jina`, `github`, `pdf`, … */
  via?: string;
}

export interface ExtractOptions {
  timeoutMs?: number;
  forceClone?: boolean;
  prompt?: string;
  timestamp?: string;
  frames?: number;
  signal?: AbortSignal;
}
