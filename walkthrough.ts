import { newCommentId, type ReviewComment } from "./comments";
import type { CommitEntry } from "./git";
import { shaMatches } from "./locate";

/**
 * A walkthrough is an ordered list of stops the agent wants the user to
 * look at. Each stop points into the review data (commit + file + line)
 * and carries the context the user needs to evaluate it.
 */
export interface WalkthroughStop {
	/** Short headline, e.g. "Retry logic swallows errors". */
	title: string;
	/** Why this needs attention; context the user needs. */
	detail: string;
	/** Short commit sha; undefined/null/"" means uncommitted changes. */
	sha?: string | null;
	/** File path within that commit's diff. */
	file?: string;
	/** Line number in the new version of the file. */
	line?: number;
	/** Optional categorization, shown as a tag. */
	kind?: string;
}

/**
 * ADR-0001: model anchored walkthrough stops as agent ReviewComments and
 * keep only file-less overview text as summary chrome.
 *
 * Stops with a `file` become read-only `author: "agent"` comments anchored
 * at (sha, file, "new", line ?? 1); the sha is resolved against the review
 * items so short/full shas from the agent still land on the right entry.
 * Stops without a `file` are returned as `summaries` (banner chrome).
 */
export function stopsToReviewComments(
	stops: WalkthroughStop[],
	items: CommitEntry[],
): { comments: ReviewComment[]; summaries: WalkthroughStop[] } {
	const comments: ReviewComment[] = [];
	const summaries: WalkthroughStop[] = [];
	for (const stop of stops) {
		if (!stop.file) {
			summaries.push(stop);
			continue;
		}
		const item = items.find((it) => shaMatches(it.sha, stop.sha));
		comments.push({
			id: newCommentId(),
			author: "agent",
			sha: item ? item.sha : (stop.sha ?? null),
			file: stop.file,
			side: "new",
			line: stop.line ?? 1,
			title: stop.title,
			body: stop.detail,
			kind: stop.kind,
		});
	}
	return { comments, summaries };
}