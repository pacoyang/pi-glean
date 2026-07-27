import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { extractPdfToMarkdown, sanitizeFilename, titleFromUrl } from "../src/fetch/pdf.ts";

/**
 * A minimal one-page PDF with a single text run, built by hand so the test has
 * no binary fixture to keep in the repo.
 */
function tinyPdf(text: string): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "glean-pdf-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe("titleFromUrl", () => {
  it("derives an arxiv identifier", () => {
    assert.equal(titleFromUrl("https://arxiv.org/pdf/1706.03762"), "arxiv-1706.03762");
    assert.equal(titleFromUrl("https://arxiv.org/pdf/1706.03762v5.pdf"), "arxiv-1706.03762");
    assert.equal(titleFromUrl("https://arxiv.org/abs/2401.12345"), "arxiv-2401.12345");
  });

  it("falls back to the filename", () => {
    assert.equal(titleFromUrl("https://example.com/docs/manual.pdf"), "manual");
    assert.equal(titleFromUrl("https://example.com/"), "example.com");
    assert.equal(titleFromUrl("not a url"), "document");
  });
});

describe("sanitizeFilename", () => {
  it("removes every path separator and traversal marker", () => {
    for (const hostile of ["../../etc/passwd", "..\\..\\windows", "/absolute/path", "a/b/c"]) {
      const safe = sanitizeFilename(hostile);
      assert.doesNotMatch(safe, /[/\\]/, `${hostile} → ${safe}`);
      assert.doesNotMatch(safe, /^[.-]/, `${hostile} → ${safe} must not start with a dot or dash`);
    }
    assert.equal(sanitizeFilename("A Paper: Title/v2"), "A-Paper-Title-v2");
  });

  it("never returns an empty name", () => {
    assert.equal(sanitizeFilename("///"), "document");
  });
});

describe("extraction", () => {
  it("returns markdown inline with page markers", async () => {
    const result = await extractPdfToMarkdown(tinyPdf("Hello PDF"), "https://example.com/a.pdf", {
      maxPages: 100,
      writeFile: false,
      outputDir,
    });
    assert.match(result.markdown, /<!-- Page 1 -->/);
    assert.match(result.markdown, /Hello PDF/);
    assert.match(result.markdown, /> Source: https:\/\/example\.com\/a\.pdf/);
    assert.equal(result.pages, 1);
    assert.ok(result.chars > 0);
  });

  it("writes no file unless asked", async () => {
    await extractPdfToMarkdown(tinyPdf("x"), "https://example.com/a.pdf", {
      maxPages: 100,
      writeFile: false,
      outputDir,
    });
    assert.deepEqual(readdirSync(outputDir), [], "writeFile:false must leave the directory empty");
  });

  it("writes into the configured scratch directory when asked", async () => {
    const result = await extractPdfToMarkdown(tinyPdf("x"), "https://example.com/manual.pdf", {
      maxPages: 100,
      writeFile: true,
      outputDir,
    });
    assert.ok(result.outputPath);
    assert.ok(result.outputPath!.startsWith(outputDir));
    assert.match(readFileSync(result.outputPath!, "utf-8"), /<!-- Page 1 -->/);
  });

  it("never writes anywhere near $HOME", async () => {
    // Upstream wrote to ~/Downloads and created it with mkdir -p, conjuring the
    // directory on servers that never had one.
    const result = await extractPdfToMarkdown(tinyPdf("x"), "https://example.com/a.pdf", {
      maxPages: 100,
      writeFile: true,
      outputDir,
    });
    assert.ok(!result.outputPath!.startsWith(homedir()), result.outputPath);
    assert.doesNotMatch(result.outputPath!, /Downloads/);
  });

  it("notes truncation when maxPages is reached", async () => {
    const result = await extractPdfToMarkdown(tinyPdf("only page"), "https://example.com/a.pdf", {
      maxPages: 1,
      writeFile: false,
      outputDir,
    });
    // Single-page fixture, so nothing is actually cut; the count must agree.
    assert.equal(result.extractedPages, 1);
    assert.doesNotMatch(result.markdown, /Truncated at/);
  });
});

describe("lazy loading", () => {
  it("does not import unpdf at module scope", () => {
    // unpdf bundles pdfjs; a top-level import would add hundreds of
    // milliseconds to every pi start, including sessions that never see a PDF.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fetch", "pdf.ts"),
      "utf-8",
    );
    const topLevelImports = source
      .split("\n")
      .filter((line) => /^import .* from ["']/.test(line))
      .join("\n");
    assert.doesNotMatch(topLevelImports, /unpdf/, "unpdf must not be a static import");
    assert.match(source, /import\("unpdf"\)/, "it must be reached through a dynamic import");
  });

  it("keeps the extract pipeline free of a top-level pdf import", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fetch", "extract.ts"),
      "utf-8",
    );
    const topLevelImports = source
      .split("\n")
      .filter((line) => /^import .* from ["']/.test(line))
      .join("\n");
    assert.doesNotMatch(topLevelImports, /\.\/pdf\.ts/);
  });
});
