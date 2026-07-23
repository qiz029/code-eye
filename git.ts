import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommitEntry {
	/** null = uncommitted working-tree changes */
	sha: string | null;
	/** short sha, or a marker for the uncommitted entry */
	label: string;
	subject: string;
	/** Delta item only (ADR-0005): diff the working tree against this commit
	 * instead of HEAD — the "changes since last review" view. */
	since?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

/** Detect the base branch to compare against ("main", "master", or origin's default). */
export async function detectBaseBranch(cwd: string): Promise<string | null> {
	for (const candidate of ["main", "master"]) {
		try {
			await git(cwd, ["rev-parse", "--verify", "--quiet", candidate]);
			return candidate;
		} catch {
			// not found, try next
		}
	}
	try {
		const ref = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
		if (ref) return ref;
	} catch {
		// no origin HEAD
	}
	return null;
}

/**
 * Build the review item list: "Uncommitted changes" first (if any),
 * then commits in `<base>..HEAD` (newest first). Falls back to the last
 * 20 commits when no base branch exists.
 *
 * With `opts.since` (HEAD at the last review close, ADR-0005) and a
 * non-empty `git diff <since>`, the first item becomes a "Δ since last
 * review" delta of the working tree against that commit, replacing the
 * plain uncommitted entry (the delta is a superset of it).
 */
export async function listReviewItems(cwd: string, opts: { since?: string | null } = {}): Promise<CommitEntry[]> {
	const items: CommitEntry[] = [];

	let deltaAdded = false;
	const since = opts.since ? await verifyCommit(cwd, opts.since) : null;
	if (since) {
		const hasDelta = await git(cwd, ["diff", "--quiet", since]).then(
			() => false,
			() => true, // exit 1 = differences
		);
		if (hasDelta) {
			items.push({
				sha: null,
				since,
				label: "Δ since last review",
				subject: `working tree vs ${since.slice(0, 7)}`,
			});
			deltaAdded = true;
		}
	}

	if (!deltaAdded) {
		const status = await git(cwd, ["status", "--porcelain"]);
		if (status.trim()) {
			items.push({ sha: null, label: "working", subject: "Uncommitted changes" });
		}
	}

	const base = await detectBaseBranch(cwd);
	const logArgs = base
		? ["log", "--format=%h%x09%s", `${base}..HEAD`]
		: ["log", "--format=%h%x09%s", "-20"];
	const log = await git(cwd, logArgs);
	for (const line of log.split("\n")) {
		if (!line.trim()) continue;
		const tab = line.indexOf("\t");
		const sha = tab === -1 ? line : line.slice(0, tab);
		const subject = tab === -1 ? "" : line.slice(tab + 1);
		items.push({ sha, label: sha, subject });
	}

	return items;
}

/** Resolve a sha/ref to a commit, or null when it no longer exists (rebased away). */
async function verifyCommit(cwd: string, ref: string): Promise<string | null> {
	try {
		const sha = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
		return sha || null;
	} catch {
		return null;
	}
}

/** Current HEAD sha, or null (not a repo / no commits yet). */
export async function getHeadSha(cwd: string): Promise<string | null> {
	return verifyCommit(cwd, "HEAD");
}

/** Load the patch for one review item. sha === null means uncommitted changes;
 * `since` (delta item) diffs the working tree against that commit instead. */
export async function loadDiff(cwd: string, sha: string | null, since?: string): Promise<string> {
	if (since) {
		return git(cwd, ["diff", since]);
	}
	if (sha === null) {
		return git(cwd, ["diff", "HEAD"]);
	}
	return git(cwd, ["show", "--format=", "--patch", sha]);
}

/**
 * Load the full content of one file at a review item, for expanding the
 * context hidden between diff hunks. Returns null when the file does not
 * exist on that side (added/deleted file, no parent commit, bad path).
 */
export async function loadFileContent(
	cwd: string,
	sha: string | null,
	file: string,
	side: "new" | "old",
	/** Delta item (ADR-0005): read the old side from this commit instead of HEAD. */
	baseRef?: string,
): Promise<string | null> {
	// Guard against path traversal — file comes from the web client.
	if (file.startsWith("/") || file.split("/").includes("..")) return null;
	try {
		if (side === "new" && sha === null) {
			return await readFile(join(cwd, file), "utf8");
		}
		const ref =
			side === "new" ? `${sha}:${file}` : sha === null ? `${baseRef ?? "HEAD"}:${file}` : `${sha}^:${file}`;
		return await git(cwd, ["show", ref]);
	} catch {
		return null;
	}
}
