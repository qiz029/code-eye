import { isCommentable, type DiffLine } from "./parse-unidiff";

/** A user review comment anchored to one diff line. */
export interface ReviewComment {
	id: string;
	/** null = uncommitted changes */
	sha: string | null;
	file: string;
	/** add/context → new; del → old */
	side: "new" | "old";
	line: number;
	body: string;
	/** Code text at the anchor (without +/- prefix), for agent context. */
	lineText?: string;
}

export interface ReviewResult {
	comments: ReviewComment[];
}

export function commentKey(c: Pick<ReviewComment, "sha" | "file" | "side" | "line">): string {
	return `${c.sha ?? "working"}\0${c.file}\0${c.side}\0${c.line}`;
}

export function anchorFromDiffLine(
	line: DiffLine,
	sha: string | null,
): Omit<ReviewComment, "id" | "body"> | null {
	if (!isCommentable(line) || !line.file) return null;
	if (line.kind === "del") {
		if (line.oldLine === undefined) return null;
		return { sha, file: line.file, side: "old", line: line.oldLine, lineText: line.text };
	}
	// add or context → prefer new side
	if (line.newLine === undefined) return null;
	return { sha, file: line.file, side: "new", line: line.newLine, lineText: line.text };
}

/** Upsert by (sha, file, side, line). Empty/whitespace body deletes. Returns new list. */
export function upsertComment(
	comments: ReviewComment[],
	anchor: Omit<ReviewComment, "id" | "body">,
	body: string,
	idFactory: () => string = nextId,
): ReviewComment[] {
	const trimmed = body.trim();
	const key = commentKey(anchor);
	const without = comments.filter((c) => commentKey(c) !== key);
	if (!trimmed) return without;
	return [
		...without,
		{
			id: idFactory(),
			sha: anchor.sha,
			file: anchor.file,
			side: anchor.side,
			line: anchor.line,
			body: trimmed,
			lineText: anchor.lineText,
		},
	];
}

export function removeCommentAt(
	comments: ReviewComment[],
	anchor: Pick<ReviewComment, "sha" | "file" | "side" | "line">,
): ReviewComment[] {
	const key = commentKey(anchor);
	return comments.filter((c) => commentKey(c) !== key);
}

export function findCommentAt(
	comments: ReviewComment[],
	anchor: Pick<ReviewComment, "sha" | "file" | "side" | "line">,
): ReviewComment | undefined {
	const key = commentKey(anchor);
	return comments.find((c) => commentKey(c) === key);
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

/** Format comments for the agent (tool result or follow-up message). */
export function formatCommentsForAgent(comments: ReviewComment[]): string {
	if (comments.length === 0) {
		return "The user reviewed the changes in the review panel and closed it without leaving comments.";
	}
	const lines = [
		`The user reviewed the changes and left ${comments.length} comment(s). Please address each one:`,
		"",
	];
	comments.forEach((c, i) => {
		const where = c.sha ? `commit ${c.sha}` : "uncommitted changes";
		const code = c.lineText ? `\n   code: \`${truncate(c.lineText, 80)}\`` : "";
		lines.push(`${i + 1}. ${c.file}:${c.line} (${c.side}) [${where}]${code}`);
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

/** Session-scoped store so reopening the panel keeps prior comments. */
export class CommentStore {
	private comments: ReviewComment[] = [];

	list(): ReviewComment[] {
		return this.comments.slice();
	}

	setAll(comments: ReviewComment[]): void {
		this.comments = comments.slice();
	}

	replace(comments: ReviewComment[]): void {
		this.comments = comments.slice();
	}
}
