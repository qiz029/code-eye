import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { getHeadSha, listReviewItems, loadDiff } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout;
}

/** Repo with two commits on main and a dirty working tree; returns shas. */
async function makeRepo(): Promise<{ cwd: string; shaA: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "code-eye-git-"));
	await git(cwd, ["init", "-b", "main"]);
	await writeFile(join(cwd, "f.txt"), "v1\n", "utf8");
	await git(cwd, ["add", "."]);
	await git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"]);
	const shaA = (await git(cwd, ["rev-parse", "HEAD"])).trim();
	// Review happens on a feature branch so main..HEAD is non-empty.
	await git(cwd, ["checkout", "-b", "feature"]);
	await writeFile(join(cwd, "f.txt"), "v1\nv2\n", "utf8");
	await git(cwd, ["add", "."]);
	await git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "second"]);
	// Uncommitted change on top.
	await writeFile(join(cwd, "f.txt"), "v1\nv2\nv3\n", "utf8");
	return { cwd, shaA };
}

test("listReviewItems with since: delta item replaces the uncommitted entry", async () => {
	const { cwd, shaA } = await makeRepo();
	const items = await listReviewItems(cwd, { since: shaA });

	const delta = items[0]!;
	assert.equal(delta.sha, null);
	assert.equal(delta.since, shaA);
	assert.equal(delta.label, "Δ since last review");
	// No second sha-null item.
	assert.equal(items.filter((i) => i.sha === null).length, 1);
	// Commits still listed after the delta item.
	assert.ok(items.some((i) => i.subject === "second"));
});

test("delta diff spans new commits and uncommitted changes", async () => {
	const { cwd, shaA } = await makeRepo();
	const diff = await loadDiff(cwd, null, shaA);
	assert.match(diff, /\+v2/); // from the commit after shaA
	assert.match(diff, /\+v3/); // uncommitted
});

test("listReviewItems falls back when since is invalid or empty", async () => {
	const { cwd } = await makeRepo();

	// Garbage ref → plain uncommitted entry.
	const bad = await listReviewItems(cwd, { since: "0".repeat(40) });
	assert.equal(bad[0]!.label, "working");
	assert.equal(bad[0]!.since, undefined);

	// HEAD with clean tree → no delta, no uncommitted item; commits only.
	const head = (await getHeadSha(cwd))!;
	await git(cwd, ["checkout", "--", "."]);
	const clean = await listReviewItems(cwd, { since: head });
	assert.equal(clean.filter((i) => i.sha === null).length, 0);

	// since == HEAD but dirty tree → delta item (covers "edited after review").
	await writeFile(join(cwd, "f.txt"), "v1\nv2\nv3\n", "utf8");
	const dirty = await listReviewItems(cwd, { since: head });
	assert.equal(dirty[0]!.label, "Δ since last review");
});

test("getHeadSha returns HEAD and null outside a repo", async () => {
	const { cwd, shaA } = await makeRepo();
	const head = await getHeadSha(cwd);
	assert.ok(head);
	assert.notEqual(head, shaA); // HEAD moved past shaA after second commit
	const outside = await mkdtemp(join(tmpdir(), "code-eye-nogit-"));
	assert.equal(await getHeadSha(outside), null);
});
