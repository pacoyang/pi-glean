import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

interface Manifest {
  main?: string;
  keywords: string[];
  files: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: { node?: string };
  pi?: { extensions?: string[] };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as Manifest;

const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

describe("package.json", () => {
  it("declares pi packages as peers, never as runtime dependencies", () => {
    // pi installs with --omit=dev and bundles these itself; a hard dependency
    // would ship a second copy and break the jiti aliasing.
    for (const name of PI_PACKAGES) {
      assert.ok(pkg.peerDependencies?.[name], `${name} must be a peerDependency`);
      assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a dependency`);
    }
  });

  it("does not depend on typebox directly", () => {
    // Type/StringEnum come from @earendil-works/pi-ai; a direct dependency would
    // risk a second TypeBox instance.
    assert.equal(pkg.dependencies?.typebox, undefined);
  });

  it("is discoverable via the pi-package keyword", () => {
    assert.ok(pkg.keywords.includes("pi-package"));
  });

  it("points pi at the entry module", () => {
    assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
  });

  it("ships the licence files", () => {
    const files = pkg.files;
    for (const required of ["index.ts", "src", "LICENSE", "NOTICE"]) {
      assert.ok(files.includes(required), `files must include ${required}`);
    }
  });

  it("requires Node 22 or newer", () => {
    assert.match(pkg.engines?.node ?? "", />=\s*2[2-9]/);
  });

  it("has no build step", () => {
    // Source ships as TypeScript; pi loads it through jiti.
    assert.match(pkg.scripts?.build ?? "", /nothing to build/);
    assert.equal(pkg.main, undefined);
  });

  it("declares each script only once", () => {
    const raw = readFileSync(join(root, "package.json"), "utf-8");
    const scriptNames = Object.keys(pkg.scripts);
    for (const name of scriptNames) {
      const occurrences = raw.split(`"${name}":`).length - 1;
      assert.equal(occurrences, 1, `script "${name}" is declared ${occurrences} times`);
    }
  });
});

describe("source hygiene", () => {
  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(path, found);
      else if (entry.name.endsWith(".ts")) found.push(path);
    }
    return found;
  }

  it("contains no control bytes in any source file", () => {
    // A stray NUL makes grep classify the file as binary, so it silently drops
    // out of every code search — one had crept into commands.ts as a
    // never-matches sentinel and hid the whole file from review.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "tests"))];
    files.push(join(root, "index.ts"));

    for (const file of files) {
      const bytes = readFileSync(file);
      const offset = bytes.findIndex(
        (byte) => byte < 0x09 || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f,
      );
      assert.equal(
        offset,
        -1,
        `${file} has a control byte (0x${bytes[offset]?.toString(16)}) at offset ${offset}`,
      );
    }
  });
});
