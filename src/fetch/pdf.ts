/**
 * PDF → markdown.
 *
 * The text is returned inline (paged through `glean_get_content` when long)
 * rather than written to disk and referenced by path — that saved a round trip
 * for the common case of a paper the agent wants to read once.
 *
 * When `pdf.writeFile` is on, output goes to a uid-scoped directory under
 * `os.tmpdir()`. Never `~/Downloads`: that is a directory the user curates by
 * hand, and upstream's `mkdir -p` would conjure one on a server that never had
 * it.
 *
 * `unpdf` bundles pdfjs and is imported lazily, so a pi session that never
 * touches a PDF pays nothing for it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedContent } from "./types.ts";

export interface PdfConfig {
  maxPages: number;
  writeFile: boolean;
  outputDir: string;
}

export interface PdfExtractResult {
  title: string;
  pages: number;
  extractedPages: number;
  chars: number;
  markdown: string;
  outputPath?: string;
}

async function loadUnpdf() {
  // Promise.try landed in Node 23; engines allows 22, and unpdf needs it.
  if (typeof (Promise as PromiseConstructor & { try?: unknown }).try !== "function") {
    const { default: promiseTry } = await import("promise.try");
    promiseTry.shim();
  }
  const [unpdf, pdfjs] = await Promise.all([import("unpdf"), import("unpdf/pdfjs")]);
  const { VerbosityLevel } = pdfjs as unknown as { VerbosityLevel: { ERRORS: number } };
  return { getDocumentProxy: unpdf.getDocumentProxy, VerbosityLevel };
}

/** arXiv URLs carry the identifier but no title; use the id so the file is findable. */
export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const arxiv = parsed.pathname.match(/\/(?:abs|pdf)\/([\w.]+?)(?:v\d+)?(?:\.pdf)?$/i);
    if (arxiv && parsed.hostname.includes("arxiv.org")) return `arxiv-${arxiv[1]}`;
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return (last ?? parsed.hostname).replace(/\.pdf$/i, "");
  } catch {
    return "document";
  }
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w\-. ]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "document"
  );
}

export async function extractPdfToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  config: PdfConfig,
): Promise<PdfExtractResult> {
  const { getDocumentProxy, VerbosityLevel } = await loadUnpdf();
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: VerbosityLevel.ERRORS });

  const metadata = await pdf.getMetadata().catch(() => undefined);
  const metaTitle = (metadata?.info as { Title?: unknown } | undefined)?.Title;
  const metaAuthor = (metadata?.info as { Author?: unknown } | undefined)?.Author;
  const title =
    typeof metaTitle === "string" && metaTitle.trim() ? metaTitle.trim() : titleFromUrl(url);

  const extractedPages = Math.min(pdf.numPages, config.maxPages);
  const parts: string[] = [`# ${title}`, "", `> Source: ${url}`, `> Pages: ${pdf.numPages}`];
  if (typeof metaAuthor === "string" && metaAuthor.trim())
    parts.push(`> Author: ${metaAuthor.trim()}`);
  parts.push("");

  for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (item as { str?: string }).str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    parts.push(`<!-- Page ${pageNumber} -->`, "", text, "");
  }

  if (extractedPages < pdf.numPages) {
    parts.push(
      "",
      `_Truncated at ${extractedPages} of ${pdf.numPages} pages. Raise pdf.maxPages to extract more._`,
    );
  }

  const markdown = parts.join("\n");
  const result: PdfExtractResult = {
    title,
    pages: pdf.numPages,
    extractedPages,
    chars: markdown.length,
    markdown,
  };

  if (config.writeFile) {
    // 0700: a scratch directory shared by uid on a multi-user host.
    await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
    const outputPath = join(config.outputDir, `${sanitizeFilename(title)}.md`);
    await writeFile(outputPath, markdown, "utf-8");
    result.outputPath = outputPath;
  }

  return result;
}

export async function extractPdf(
  buffer: ArrayBuffer,
  url: string,
  config: PdfConfig,
): Promise<ExtractedContent> {
  try {
    const result = await extractPdfToMarkdown(buffer, url, config);
    const content = result.outputPath
      ? `${result.markdown}\n\n_Also written to ${result.outputPath}_`
      : result.markdown;
    return { url, title: result.title, content, error: null, via: "pdf" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, title: "", content: "", error: `Failed to extract PDF: ${message}` };
  }
}
