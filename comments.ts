import { isCommentable, type DiffLine } from "./parse-unidiff";
import type { CommitEntry } from "./git";
import { shaMatches } from "./locate";

/** Who wrote a review comment. User comments are editable feedback to the
 * agent; agent comments are read-only walkthrough guidance (ADR-0001). */
export type CommentAuthor = "user" | "agent";

/** Lifecycle of a user comment across review rounds (ADR-0005). */
export type CommentStatus = "open" | "resolved";

/** Risk level of an agent walkthrough note (ADR-0005). */
export type Severity = "high" | "medium" | "low";

/** A review comment anchored to one diff line. */
export interface ReviewComment {
	id: string;
	author: CommentAuthor;
	/** null = uncommitted changes */
	sha: string | null;
	file: string;
	/** add/context → new; del → old */
	side: "new" | "old";
	line: number;
	body: string;
	/** Short headline (agent walkthrough notes). */
	title?: string;
	/** Optional tag like change / risk / note (agent walkthrough notes), or
	 * question / adopt for user comments replying to an agent note. */
	kind?: string;
	/** Code text at the anchor (without +/- prefix), for agent context. */
	lineText?: string;
	/** User comments only; undefined means open. Resolved comments persist
	 * but are not sent back to the agent (ADR-0005). */
	status?: CommentStatus;
	/** Risk level shown as a colored chip (agent walkthrough notes). */
	severity?: Severity;
	/** Replacement code the agent suggests (agent notes; read-only display,
	 * the user adopts it via a kind:"adopt" reply). */
	suggestion?: string;
	/** User comments only: id of the agent note this replies to. */
	replyTo?: string;
}

export interface ReviewResult {
	comments: ReviewComment[];
}

export function commentKey(
	c: Pick<ReviewComment, "author" | "sha" | "file" | "side" | "line"> & Pick<ReviewComment, "replyTo">,
): string {
	// replyTo is part of the identity so a line comment and a reply to an
	// agent note on the same line never collide (ADR-0005).
	return `${c.author}\0${c.sha ?? "working"}\0${c.file}\0${c.side}\0${c.line}\0${c.replyTo ?? ""}`;
}

export function anchorFromDiffLine(
	line: DiffLine,
	sha: string | null,
): Omit<ReviewComment, "id" | "body" | "author"> | null {
	if (!isCommentable(line) || !line.file) return null;
	if (line.kind === "del") {
		if (line.oldLine === undefined) return null;
		return { sha, file: line.file, side: "old", line: line.oldLine, lineText: line.text };
	}
	// add or context → prefer new side
	if (line.newLine === undefined) return null;
	return { sha, file: line.file, side: "new", line: line.newLine, lineText: line.text };
}

/** Upsert a user comment by (sha, file, side, line, replyTo). Empty/whitespace body deletes. Returns new list. */
export function upsertComment(
	comments: ReviewComment[],
	anchor: Omit<ReviewComment, "id" | "body" | "author">,
	body: string,
	idFactory: () => string = nextId,
): ReviewComment[] {
	const trimmed = body.trim();
	const key = commentKey({ ...anchor, author: "user" });
	const without = comments.filter((c) => commentKey(c) !== key);
	if (!trimmed) return without;
	return [
		...without,
		{
			id: idFactory(),
			author: "user",
			sha: anchor.sha,
			file: anchor.file,
			side: anchor.side,
			line: anchor.line,
			body: trimmed,
			lineText: anchor.lineText,
			// Reply metadata rides on the anchor (web question / adopt flows).
			...(anchor.kind ? { kind: anchor.kind } : {}),
			...(anchor.replyTo ? { replyTo: anchor.replyTo } : {}),
		},
	];
}

export function removeCommentAt(
	comments: ReviewComment[],
	anchor: Pick<ReviewComment, "sha" | "file" | "side" | "line" | "replyTo">,
	author: CommentAuthor = "user",
): ReviewComment[] {
	const key = commentKey({ ...anchor, author });
	return comments.filter((c) => commentKey(c) !== key);
}

export function findCommentAt(
	comments: ReviewComment[],
	anchor: Pick<ReviewComment, "sha" | "file" | "side" | "line" | "replyTo">,
	author: CommentAuthor = "user",
): ReviewComment | undefined {
	const key = commentKey({ ...anchor, author });
	return comments.find((c) => commentKey(c) === key);
}

/** Toggle a user comment's open/resolved status. Returns new list (unchanged when not found). */
export function setCommentStatus(
	comments: ReviewComment[],
	anchor: Pick<ReviewComment, "sha" | "file" | "side" | "line" | "replyTo">,
	status: CommentStatus,
): ReviewComment[] {
	const key = commentKey({ ...anchor, author: "user" });
	return comments.map((c) => (commentKey(c) === key ? { ...c, status } : c));
}

/** User-authored comments — the only ones that leave the session (ADR-0002). */
export function userComments(comments: ReviewComment[]): ReviewComment[] {
	return comments.filter((c) => c.author === "user");
}

/** Open user comments — the only ones fed back to the agent as work items.
 * Resolved comments persist across rounds but don't re-trigger work (ADR-0005). */
export function openComments(comments: ReviewComment[]): ReviewComment[] {
	return comments.filter((c) => c.author === "user" && c.status !== "resolved");
}

/** Agent-authored walkthrough notes (read-only guidance). */
export function agentComments(comments: ReviewComment[]): ReviewComment[] {
	return comments.filter((c) => c.author === "agent");
}

/** Comments belonging to a given review item (commit sha or working tree). */
export function commentsForSha(comments: ReviewComment[], sha: string | null): ReviewComment[] {
	return comments.filter((c) => (c.sha === null) === (sha === null) && (sha === null || c.sha === sha));
}

/**
 * Find the diff-line index of a comment within parsed lines.
 * Returns -1 if not found.
 */
export function findCommentLineIndex(diffLines: DiffLine[], comment: ReviewComment): number {
	return diffLines.findIndex((l) => {
		if (l.file !== comment.file) return false;
		if (comment.side === "old") return l.oldLine === comment.line && (l.kind === "del" || l.kind === "context");
		return l.newLine === comment.line && (l.kind === "add" || l.kind === "context");
	});
}

/** Whether a comment's anchor still resolves against freshly parsed diff lines. */
export type AnchorState = "ok" | "changed" | "missing";

/**
 * Resolve a comment against the current diff: "missing" when the anchor no
 * longer matches any line (stale), "changed" when it resolves but the line
 * text differs from what was commented on (only meaningful for comments that
 * recorded lineText), "ok" otherwise.
 */
export function resolveAnchorState(diffLines: DiffLine[], comment: ReviewComment): AnchorState {
	const idx = findCommentLineIndex(diffLines, comment);
	if (idx < 0) return "missing";
	if (comment.lineText !== undefined && diffLines[idx]!.text !== comment.lineText) return "changed";
	return "ok";
}

/**
 * Drop persisted comments whose commit is no longer in the review items
 * (rebased/amended away). Working-tree comments (sha null) always survive.
 */
export function pruneComments(comments: ReviewComment[], items: CommitEntry[]): ReviewComment[] {
	return comments.filter((c) => c.sha === null || items.some((it) => shaMatches(it.sha, c.sha)));
}

/** Format open user comments for the agent (tool result or follow-up message).
 * Resolved comments are excluded (ADR-0005). */
export function formatCommentsForAgent(comments: ReviewComment[]): string {
	const open = openComments(comments);
	if (open.length === 0) {
		return "The user reviewed the changes in the review panel and left no comments — no further action needed.";
	}
	const lines = [
		`The user reviewed the changes and left ${open.length} comment(s). Please address each one:`,
		"",
	];
	open.forEach((c, i) => {
		const where = c.sha ? `commit ${c.sha}` : "uncommitted changes";
		const code = c.lineText ? `\n   code: \`${truncate(c.lineText, 80)}\`` : "";
		const tag = c.kind === "question" ? " [question]" : c.kind === "adopt" ? " [suggestion to apply]" : "";
		lines.push(`${i + 1}. ${c.file}:${c.line} (${c.side}) [${where}]${tag}${code}`);
		lines.push(`   ${c.body}`);
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

function truncate(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

let _seq = 0;
function nextId(): string {
	_seq += 1;
	return `c${Date.now().toString(36)}_${_seq}`;
}

/** Exported for constructing agent comments from walkthrough stops. */
export function newCommentId(): string {
	return nextId();
}

/**
 * Session-scoped store so reopening the panel keeps prior comments.
 * ADR-0001: only user comments persist; agent walkthrough is regenerated
 * each time the agent opens review.
 */
export class CommentStore {
	private comments: ReviewComment[] = [];

	list(): ReviewComment[] {
		return this.comments.slice();
	}

	setAll(comments: ReviewComment[]): void {
		this.comments = userComments(comments);
	}

	replace(comments: ReviewComment[]): void {
		this.comments = userComments(comments);
	}
}
