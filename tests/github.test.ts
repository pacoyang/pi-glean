import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildTree,
  generateContent,
  parseGitHubUrl,
  resolveWithinRepo,
} from "../src/github/extract.ts";

let repo: string;
let outside: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "glean-gh-"));
  repo = join(root, "repo");
  outside = join(root, "outside");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Demo\n\nA test repository.", "utf-8");
  await writeFile(join(repo, "src", "index.ts"), "export const answer = 42;\n", "utf-8");
  await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "module.exports=1;", "utf-8");
  await writeFile(join(outside, "secret.txt"), "SECRET", "utf-8");
});

afterEach(async () => {
  await rm(join(repo, ".."), { recursive: true, force: true });
});

describe("parseGitHubUrl", () => {
  it("parses a repository root", () => {
    const info = parseGitHubUrl("https://github.com/earendil-works/pi-mono");
    assert.deepEqual(info, {
      owner: "earendil-works",
      repo: "pi-mono",
      refIsFullSha: false,
      type: "root",
    });
  });

  it("strips a .git suffix and accepts www", () => {
    assert.equal(parseGitHubUrl("https://www.github.com/a/b.git")?.repo, "b");
  });

  it("parses blob and tree URLs", () => {
    const blob = parseGitHubUrl("https://github.com/a/b/blob/main/src/index.ts");
    assert.equal(blob?.type, "blob");
    assert.equal(blob?.ref, "main");
    assert.equal(blob?.path, "src/index.ts");

    const tree = parseGitHubUrl("https://github.com/a/b/tree/main/src");
    assert.equal(tree?.type, "tree");
    assert.equal(tree?.path, "src");
  });

  it("detects a 40-hex commit ref", () => {
    const sha = "a".repeat(40);
    assert.equal(parseGitHubUrl(`https://github.com/a/b/blob/${sha}/x.ts`)?.refIsFullSha, true);
    assert.equal(parseGitHubUrl("https://github.com/a/b/blob/main/x.ts")?.refIsFullSha, false);
  });

  it("declines non-code pages so they fall through to HTML", () => {
    // Issues and wikis are prose; the HTML path reads them better than a clone.
    for (const path of ["issues/1", "pull/2", "wiki", "actions", "releases", "discussions"]) {
      assert.equal(parseGitHubUrl(`https://github.com/a/b/${path}`), null, path);
    }
  });

  it("declines non-GitHub hosts and malformed URLs", () => {
    assert.equal(parseGitHubUrl("https://gitlab.com/a/b"), null);
    assert.equal(parseGitHubUrl("https://github.com/onlyowner"), null);
    assert.equal(parseGitHubUrl("not a url"), null);
  });

  it("refuses a percent-encoded traversal in any path component", () => {
    // Segments are percent-decoded, and owner/repo/ref all become directory
    // names under the clone root. `join(root, owner, `${repo}@${ref}`)` on a
    // decoded `../../..` normalizes clean out of the root — and cloneRepo then
    // calls rmSync(dir, { recursive: true, force: true }) on the result. A URL
    // is attacker-controlled here, so this must never parse.
    for (const url of [
      "https://github.com/o/r/tree/x%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc",
      "https://github.com/..%2F..%2F..%2Fetc/r",
      "https://github.com/o/..%2F..%2Fr",
      "https://github.com/o/r/blob/..%2F..%2Fpasswd/x.ts",
      "https://github.com/o/r/tree/x%5C..%5C..%5Cwindows",
    ]) {
      assert.equal(parseGitHubUrl(url), null, url);
    }
  });

  it("refuses a traversal in the in-repo path", () => {
    // The path is interpolated into `gh api repos/o/r/contents/<path>`, and gh
    // normalizes the route — so `../../../user` there becomes a call to /user
    // as the authenticated GitHub account.
    for (const url of [
      "https://github.com/o/r/blob/main/..%2F..%2F..%2Fuser",
      "https://github.com/o/r/blob/main/a/..%2F..%2F..%2F..%2Fuser",
      "https://github.com/o/r/tree/main/src/..%2F..",
    ]) {
      assert.equal(parseGitHubUrl(url), null, url);
    }
  });

  it("still accepts the legitimate URLs that look similar", () => {
    // A branch name really can contain a slash — but GitHub spells it with a
    // literal `/`, which the path split has already separated.
    const info = parseGitHubUrl("https://github.com/a/b/tree/feat/foo/src");
    assert.equal(info?.ref, "feat");
    assert.equal(info?.path, "foo/src");
    // Dots are fine anywhere they are not a traversal.
    assert.equal(parseGitHubUrl("https://github.com/a/b.js/tree/v1.2.3")?.repo, "b.js");
    assert.equal(parseGitHubUrl("https://github.com/a/b/tree/release-1.0")?.ref, "release-1.0");
  });
});

describe("resolveWithinRepo", () => {
  it("accepts ordinary paths", () => {
    assert.ok(resolveWithinRepo(repo, "src/index.ts"));
    assert.ok(resolveWithinRepo(repo, ""));
  });

  it("blocks traversal out of the repository", () => {
    assert.equal(resolveWithinRepo(repo, "../outside/secret.txt"), null);
    assert.equal(resolveWithinRepo(repo, "../../etc/passwd"), null);
  });

  it("blocks a symlink escaping the repository", async () => {
    // A repo can contain a symlink pointing anywhere; without the realpath
    // check a tree walk would read outside the checkout.
    await symlink(outside, join(repo, "escape"));
    assert.equal(resolveWithinRepo(repo, "escape"), null);
    assert.equal(resolveWithinRepo(repo, "escape/secret.txt"), null);
  });

  it("allows a symlink that stays inside", async () => {
    await symlink(join(repo, "src"), join(repo, "alias"));
    assert.ok(resolveWithinRepo(repo, "alias"));
  });
});

describe("buildTree", () => {
  it("lists files and marks skipped dependency directories", () => {
    const tree = buildTree(repo);
    assert.match(tree, /README\.md/);
    assert.match(tree, /src\//);
    assert.match(tree, /src\/index\.ts/);
    assert.match(tree, /node_modules\/\s+\[skipped]/);
    assert.doesNotMatch(tree, /left-pad/, "skipped directories are not walked into");
  });

  it("omits the .git directory", async () => {
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "config"), "[core]", "utf-8");
    assert.doesNotMatch(buildTree(repo), /\.git/);
  });

  it("caps the entry count", async () => {
    for (let i = 0; i < 300; i++) {
      await writeFile(join(repo, `file-${i}.txt`), "x", "utf-8");
    }
    const tree = buildTree(repo);
    assert.match(tree, /truncated at 200 entries/);
  });
});

describe("generateContent", () => {
  const rootInfo = { owner: "a", repo: "b", refIsFullSha: false, type: "root" as const };

  it("shows the clone path, tree and README for a root URL", () => {
    const content = generateContent(repo, rootInfo);
    assert.match(content, new RegExp(`Repository cloned to: ${repo}`));
    assert.match(content, /## Structure/);
    assert.match(content, /## README/);
    assert.match(content, /A test repository/);
    // The clone exists so the agent can use its own file tools on it.
    assert.match(content, /`read`, `grep` and `bash`/);
  });

  it("returns a single file for a blob URL", () => {
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "src/index.ts",
      type: "blob",
    });
    assert.match(content, /## src\/index\.ts/);
    assert.match(content, /export const answer = 42;/);
  });

  it("hints at slashed branch names when a blob path is missing", () => {
    // A ref like feat/foo is indistinguishable from a path segment, which is a
    // known upstream limitation; the message has to point the way out.
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "feat",
      refIsFullSha: false,
      path: "foo/src/index.ts",
      type: "blob",
    });
    assert.match(content, /not found in the clone/);
    assert.match(content, /branch name contains a slash/);
  });

  it("lists a directory for a tree URL", () => {
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "src",
      type: "tree",
    });
    assert.match(content, /## src/);
    assert.match(content, /index\.ts/);
  });

  it("falls back to the root tree when a directory is missing", () => {
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "does/not/exist",
      type: "tree",
    });
    assert.match(content, /not found in the clone/);
    assert.match(content, /## Structure/);
  });

  it("reports a binary file rather than dumping bytes", async () => {
    await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "logo.png",
      type: "blob",
    });
    assert.match(content, /is a binary file/);
  });

  it("detects a binary file by NUL byte even with a text extension", async () => {
    await writeFile(join(repo, "data.txt"), Buffer.from([0x41, 0x00, 0x42]));
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "data.txt",
      type: "blob",
    });
    assert.match(content, /is a binary file/);
  });

  it("truncates a very large text file", async () => {
    await writeFile(join(repo, "big.ts"), "x".repeat(150_000), "utf-8");
    const content = generateContent(repo, {
      owner: "a",
      repo: "b",
      ref: "main",
      refIsFullSha: false,
      path: "big.ts",
      type: "blob",
    });
    assert.match(content, /File truncated at 100000 chars/);
  });
});
