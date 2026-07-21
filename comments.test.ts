import assert from "node:assert/strict";
import { test } from "node:test";
import {
	anchorFromDiffLine,
	commentKey,
	findCommentAt,
	findCommentLineIndex,
	formatCommentsForAgent,
	removeCommentAt,
	upsertComment,
	type ReviewComment,
} from "./comments.js";
import { parseUnifiedDiff } from "./parse-unidiff.js";

const sampleDiff = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -10,3 +10,4 @@",
	" keep",
	"-old line",
	"+new line",
	"+extra",
].join("\n");

test("anchorFromDiffLine maps add/del/context", () => {
	const lines = parseUnifiedDiff(sampleDiff);
	const add = lines.find((l) => l.kind === "add" && l.text === "new line")!;
	const del = lines.find((l) => l.kind === "del")!;
	const ctx = lines.find((l) => l.kind === "context")!;
	const file = lines.find((l) => l.kind === "file")!;

	assert.deepEqual(anchorFromDiffLine(add, null), {
		sha: null,
		file: "src/a.ts",
		side: "new",
		line: 11,
		lineText: "new line",
	});
	assert.equal(anchorFromDiffLine(del, "abc")!.side, "old");
	assert.equal(anchorFromDiffLine(del, "abc")!.line, 11);
	assert.equal(anchorFromDiffLine(ctx, null)!.side, "new");
	assert.equal(anchorFromDiffLine(file, null), null);
});

test("upsertComment replaces same line; empty body deletes", () => {
	const anchor = { sha: null as string | null, file: "src/a.ts", side: "new" as const, line: 11, lineText: "x" };
	let list: ReviewComment[] = [];
	list = upsertComment(list, anchor, "first", () => "id1");
	assert.equal(list.length, 1);
	assert.equal(list[0]!.body, "first");

	list = upsertComment(list, anchor, "second", () => "id2");
	assert.equal(list.length, 1);
	assert.equal(list[0]!.body, "second");
	assert.equal(list[0]!.id, "id2");

	list = upsertComment(list, anchor, "   ", () => "id3");
	assert.equal(list.length, 0);
});

test("find/remove by key", () => {
	const a = {
		id: "1",
		sha: "abc",
		file: "f.ts",
		side: "new" as const,
		line: 3,
		body: "hi",
	};
	const b = { ...a, id: "2", line: 4, body: "bye" };
	const list = [a, b];
	assert.equal(findCommentAt(list, a)?.body, "hi");
	assert.equal(removeCommentAt(list, a).length, 1);
	assert.equal(commentKey(a), ["abc", "f.ts", "new", "3"].join("\0"));
});

test("findCommentLineIndex lands on anchored diff line", () => {
	const lines = parseUnifiedDiff(sampleDiff);
	const comment: ReviewComment = {
		id: "1",
		sha: null,
		file: "src/a.ts",
		side: "new",
		line: 11,
		body: "n",
	};
	const idx = findCommentLineIndex(lines, comment);
	assert.ok(idx >= 0);
	assert.equal(lines[idx]!.text, "new line");
});

test("formatCommentsForAgent lists locations and bodies", () => {
	const text = formatCommentsForAgent([
		{
			id: "1",
			sha: "abc123",
			file: "src/a.ts",
			side: "new",
			line: 11,
			body: "please rename",
			lineText: "const x = 1",
		},
	]);
	assert.match(text, /1 comment/);
	assert.match(text, /src\/a\.ts:11/);
	assert.match(text, /please rename/);
	assert.match(text, /const x = 1/);
	assert.match(formatCommentsForAgent([]), /without leaving comments/);
});
