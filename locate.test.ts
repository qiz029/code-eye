import assert from "node:assert/strict";
import { test } from "node:test";
import { findItemIndex, findLineIndex, normalizePath, pathsMatch, shaMatches } from "./locate.js";
import { parseUnifiedDiff } from "./parse-unidiff.js";
import type { CommitEntry } from "./git.js";

test("normalizePath strips a/b prefixes and ./", () => {
	assert.equal(normalizePath("b/src/foo.ts"), "src/foo.ts");
	assert.equal(normalizePath("./src/foo.ts"), "src/foo.ts");
	assert.equal(normalizePath("a\\src\\foo.ts"), "src/foo.ts");
});

test("pathsMatch handles absolute vs relative", () => {
	assert.equal(pathsMatch("src/foo.ts", "src/foo.ts"), true);
	assert.equal(pathsMatch("/Users/x/proj/src/foo.ts", "src/foo.ts"), true);
	assert.equal(pathsMatch("b/src/foo.ts", "./src/foo.ts"), true);
	assert.equal(pathsMatch("src/foo.ts", "src/bar.ts"), false);
});

test("shaMatches short/full/null both ways", () => {
	assert.equal(shaMatches(null, undefined), true);
	assert.equal(shaMatches(null, ""), true);
	assert.equal(shaMatches(null, "abc"), false);
	assert.equal(shaMatches("abcdef0", "abcdef0123456789"), true);
	assert.equal(shaMatches("abcdef0123456789", "abcdef0"), true);
	assert.equal(shaMatches("abcdef0", "deadbeef"), false);
});

test("findItemIndex prefers matching sha and uncommitted", () => {
	const items: CommitEntry[] = [
		{ sha: null, label: "working", subject: "Uncommitted changes" },
		{ sha: "abc1234", label: "abc1234", subject: "feat" },
	];
	assert.equal(findItemIndex(items, { title: "t", detail: "d", sha: "abc1234dead" }), 1);
	assert.equal(findItemIndex(items, { title: "t", detail: "d" }), 0);
	assert.equal(findItemIndex(items, { title: "t", detail: "d", sha: "nope" }, 0), 0);
});

test("findLineIndex lands on new-side line and fuzzy path", () => {
	const raw = [
		"diff --git a/src/foo.ts b/src/foo.ts",
		"--- a/src/foo.ts",
		"+++ b/src/foo.ts",
		"@@ -10,3 +10,4 @@",
		" keep",
		"-old",
		"+new",
		"+extra",
	].join("\n");
	const lines = parseUnifiedDiff(raw);

	// +new is newLine 11, +extra is 12 (hunk starts at 10: keep=10, -old no new, +new=11, +extra=12)
	const idx = findLineIndex(lines, {
		title: "t",
		detail: "d",
		file: "/abs/proj/src/foo.ts",
		line: 11,
	});
	assert.equal(lines[idx]!.kind, "add");
	assert.equal(lines[idx]!.text, "new");
	assert.equal(lines[idx]!.newLine, 11);
});

test("findLineIndex falls back to nearest line in file", () => {
	const raw = [
		"diff --git a/a.ts b/a.ts",
		"+++ b/a.ts",
		"@@ -1,1 +1,2 @@",
		" keep",
		"+added",
	].join("\n");
	const lines = parseUnifiedDiff(raw);
	const idx = findLineIndex(lines, { title: "t", detail: "d", file: "a.ts", line: 99 });
	assert.ok(idx > 0);
	assert.equal(lines[idx]!.file, "a.ts");
});
