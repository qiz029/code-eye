import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitEntry } from "./git.js";
import { stopsToReviewComments } from "./walkthrough.js";

const items: CommitEntry[] = [
	{ sha: null, label: "working", subject: "Uncommitted changes" },
	{ sha: "abc1234", label: "abc1234", subject: "Add retry" },
];

test("anchored stops become agent comments; file-less stops stay summaries", () => {
	const { comments, summaries } = stopsToReviewComments(
		[
			{ title: "Overview", detail: "big picture", kind: "overview" },
			{ title: "Retry swallows errors", detail: "look here", sha: "abc1234", file: "src/a.ts", line: 42, kind: "risk" },
			{ title: "Working tree tweak", detail: "uncommitted", file: "src/b.ts" },
		],
		items,
	);

	assert.equal(summaries.length, 1);
	assert.equal(summaries[0]!.title, "Overview");

	assert.equal(comments.length, 2);
	const c0 = comments[0]!;
	assert.equal(c0.author, "agent");
	assert.equal(c0.sha, "abc1234"); // short sha resolved against review items
	assert.equal(c0.file, "src/a.ts");
	assert.equal(c0.side, "new");
	assert.equal(c0.line, 42);
	assert.equal(c0.title, "Retry swallows errors");
	assert.equal(c0.body, "look here");
	assert.equal(c0.kind, "risk");

	const c1 = comments[1]!;
	assert.equal(c1.sha, null); // no sha → uncommitted entry
	assert.equal(c1.line, 1); // default anchor line
});
