import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ReviewComment } from "./comments.js";
import {
	emptyReviewState,
	loadReviewStateFrom,
	saveReviewStateTo,
	statePathFor,
	type ReviewState,
} from "./review-state.js";

const sampleComment: ReviewComment = {
	id: "u1",
	author: "user",
	sha: "abc1234",
	file: "src/a.ts",
	side: "new",
	line: 11,
	body: "fix this",
	status: "resolved",
};

test("statePathFor nests under <gitdir>/code-eye", () => {
	assert.equal(statePathFor("/repo/.git"), join("/repo/.git", "code-eye", "state.json"));
});

test("save/load round-trips comments and lastReviewedHead", async () => {
	const dir = await mkdtemp(join(tmpdir(), "code-eye-state-"));
	const path = statePathFor(dir);
	const state: ReviewState = { version: 1, comments: [sampleComment], lastReviewedHead: "deadbeef42" };
	await saveReviewStateTo(path, state);
	const loaded = await loadReviewStateFrom(path);
	assert.deepEqual(loaded, state);
});

test("load tolerates missing file and corrupt JSON", async () => {
	const dir = await mkdtemp(join(tmpdir(), "code-eye-state-"));
	assert.deepEqual(await loadReviewStateFrom(join(dir, "nope.json")), emptyReviewState());

	const bad = join(dir, "bad.json");
	await writeFile(bad, "{ not json", "utf8");
	assert.deepEqual(await loadReviewStateFrom(bad), emptyReviewState());

	const wrongShape = join(dir, "wrong.json");
	await writeFile(wrongShape, JSON.stringify({ comments: "nope", lastReviewedHead: 42 }), "utf8");
	assert.deepEqual(await loadReviewStateFrom(wrongShape), emptyReviewState());
});

test("save creates the code-eye directory and replaces state atomically", async () => {
	const dir = await mkdtemp(join(tmpdir(), "code-eye-state-"));
	const path = statePathFor(join(dir, "nested", "gitdir"));
	await saveReviewStateTo(path, { version: 1, comments: [] });
	await saveReviewStateTo(path, { version: 1, comments: [sampleComment] });
	const loaded = await loadReviewStateFrom(path);
	assert.equal(loaded.comments.length, 1);
	assert.equal(loaded.lastReviewedHead, undefined);
});
