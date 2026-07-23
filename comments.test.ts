import assert from "node:assert/strict";
import { test } from "node:test";
import {
	anchorFromDiffLine,
	commentKey,
	findCommentAt,
	findCommentLineIndex,
	formatCommentsForAgent,
	pruneComments,
	removeCommentAt,
	resolveAnchorState,
	setCommentStatus,
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
		author: "user" as const,
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
	assert.equal(commentKey(a), ["user", "abc", "f.ts", "new", "3", ""].join("\0"));
});

test("user and agent comments can share a line (ADR-0001)", () => {
	const anchor = { sha: null as string | null, file: "src/a.ts", side: "new" as const, line: 11 };
	const agent: ReviewComment = { id: "a1", author: "agent", ...anchor, body: "note" };
	let list: ReviewComment[] = [agent];
	list = upsertComment(list, anchor, "user note", () => "u1");
	assert.equal(list.length, 2);
	assert.equal(findCommentAt(list, anchor, "agent")?.body, "note");
	assert.equal(findCommentAt(list, anchor, "user")?.body, "user note");
	// Deleting the user comment keeps the agent note.
	list = removeCommentAt(list, anchor, "user");
	assert.equal(list.length, 1);
	assert.equal(list[0]!.author, "agent");
});

test("findCommentLineIndex lands on anchored diff line", () => {
	const lines = parseUnifiedDiff(sampleDiff);
	const comment: ReviewComment = {
		id: "1",
		author: "user",
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
			author: "user",
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
	// ADR-0002: no user comments → short "no further action" result.
	assert.match(formatCommentsForAgent([]), /no further action/);
	// Agent comments are never echoed back as work items.
	assert.match(
		formatCommentsForAgent([{ id: "a", author: "agent", sha: null, file: "f", side: "new", line: 1, body: "note" }]),
		/no further action/,
	);
});

test("commentKey: replyTo keeps replies distinct from line comments", () => {
	const anchor = { sha: null as string | null, file: "src/a.ts", side: "new" as const, line: 11 };
	let list: ReviewComment[] = [];
	list = upsertComment(list, anchor, "line comment", () => "u1");
	list = upsertComment(list, { ...anchor, replyTo: "note-1", kind: "question" }, "why?", () => "u2");
	assert.equal(list.length, 2);
	const reply = findCommentAt(list, { ...anchor, replyTo: "note-1" });
	assert.equal(reply?.body, "why?");
	assert.equal(reply?.kind, "question");
	// Removing the reply keeps the line comment.
	list = removeCommentAt(list, { ...anchor, replyTo: "note-1" }, "user");
	assert.equal(list.length, 1);
	assert.equal(list[0]!.body, "line comment");
});

test("setCommentStatus toggles resolved without touching others", () => {
	const anchor = { sha: null as string | null, file: "src/a.ts", side: "new" as const, line: 11 };
	let list = upsertComment([], anchor, "fix this", () => "u1");
	list = setCommentStatus(list, anchor, "resolved");
	assert.equal(list[0]!.status, "resolved");
	list = setCommentStatus(list, anchor, "open");
	assert.equal(list[0]!.status, "open");
	// Unknown anchor is a no-op.
	assert.equal(setCommentStatus(list, { ...anchor, line: 99 }, "resolved")[0]!.status, "open");
});

test("resolveAnchorState: ok / changed / missing", () => {
	const lines = parseUnifiedDiff(sampleDiff);
	const base = {
		id: "1",
		author: "user" as const,
		sha: null,
		file: "src/a.ts",
		side: "new" as const,
		line: 11,
		body: "n",
	};
	assert.equal(resolveAnchorState(lines, { ...base, lineText: "new line" }), "ok");
	assert.equal(resolveAnchorState(lines, { ...base, lineText: "something else" }), "changed");
	assert.equal(resolveAnchorState(lines, { ...base, line: 999 }), "missing");
	// No lineText recorded (agent notes) → never "changed".
	assert.equal(resolveAnchorState(lines, base), "ok");
});

test("pruneComments drops comments for commits no longer in items", () => {
	const items = [
		{ sha: null, label: "working", subject: "Uncommitted changes" },
		{ sha: "abc1234", label: "abc1234", subject: "keep me" },
	];
	const mk = (sha: string | null, id: string): ReviewComment => ({
		id,
		author: "user",
		sha,
		file: "f.ts",
		side: "new",
		line: 1,
		body: id,
	});
	const list = [mk(null, "working"), mk("abc1234", "full-sha"), mk("abc1234ffff", "prefix-match"), mk("deadbeef", "gone")];
	const pruned = pruneComments(list, items);
	assert.deepEqual(pruned.map((c) => c.id), ["working", "full-sha", "prefix-match"]);
});

test("formatCommentsForAgent skips resolved, tags questions and adopt requests", () => {
	const mk = (id: string, extra: Partial<ReviewComment>): ReviewComment => ({
		id,
		author: "user",
		sha: null,
		file: "f.ts",
		side: "new",
		line: 1,
		body: `body-${id}`,
		...extra,
	});
	const text = formatCommentsForAgent([
		mk("1", { status: "resolved" }),
		mk("2", { kind: "question" }),
		mk("3", { kind: "adopt" }),
	]);
	assert.match(text, /2 comment\(s\)/);
	assert.doesNotMatch(text, /body-1/);
	assert.match(text, /\[question\][\s\S]*body-2/);
	assert.match(text, /\[suggestion to apply\][\s\S]*body-3/);
	// All resolved → no further action.
	assert.match(formatCommentsForAgent([mk("1", { status: "resolved" })]), /no further action/);
});
