import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ReviewComment } from "./comments";

const execFileAsync = promisify(execFile);

/**
 * On-disk review state (ADR-0005): user comments survive host restarts, and
 * lastReviewedHead powers the "Δ since last review" delta item. Lives inside
 * the git dir so it never pollutes the working tree and works in worktrees.
 */
export interface ReviewState {
	version: 1;
	/** All user comments, including resolved ones. */
	comments: ReviewComment[];
	/** HEAD recorded when the last review session closed. */
	lastReviewedHead?: string;
}

export function emptyReviewState(): ReviewState {
	return { version: 1, comments: [] };
}

export function statePathFor(gitDir: string): string {
	return join(gitDir, "code-eye", "state.json");
}

/** Tolerates missing/corrupt files — a broken state file just starts fresh. */
export async function loadReviewStateFrom(path: string): Promise<ReviewState> {
	try {
		const data: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!data || typeof data !== "object") return emptyReviewState();
		const { comments, lastReviewedHead } = data as Record<string, unknown>;
		return {
			version: 1,
			comments: Array.isArray(comments) ? (comments as ReviewComment[]) : [],
			...(typeof lastReviewedHead === "string" ? { lastReviewedHead } : {}),
		};
	} catch {
		return emptyReviewState();
	}
}

export async function saveReviewStateTo(path: string, state: ReviewState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
	await rename(tmp, path);
}

async function gitDir(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["rev-parse", "--absolute-git-dir"], { cwd });
	return stdout.trim();
}

/** Load state for a repo; never throws (falls back to empty outside a repo). */
export async function loadReviewState(cwd: string): Promise<ReviewState> {
	try {
		return await loadReviewStateFrom(statePathFor(await gitDir(cwd)));
	} catch {
		return emptyReviewState();
	}
}

/** Persist state for a repo; best-effort — a failed save must not break review close. */
export async function saveReviewState(cwd: string, state: ReviewState): Promise<void> {
	try {
		await saveReviewStateTo(statePathFor(await gitDir(cwd)), state);
	} catch {
		// best-effort
	}
}
