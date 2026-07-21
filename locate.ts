import { isCommentable, type DiffLine } from "./parse-unidiff";
import type { CommitEntry } from "./git";
import type { WalkthroughStop } from "./walkthrough";

/** Normalize file paths so agent-provided and git-diff paths can match. */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^(a|b)\//, "")
		.replace(/\/+$/, "");
}

/**
 * Fuzzy path equality: exact match after normalize, or either side is a
 * suffix of the other (absolute vs repo-relative, nested prefixes, etc.).
 */
export function pathsMatch(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	return na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

/** Match short/full/null SHAs both ways (item may be abbreviated). */
export function shaMatches(itemSha: string | null, stopSha?: string | null): boolean {
	if (stopSha === undefined || stopSha === null || stopSha === "") {
		return itemSha === null;
	}
	if (itemSha === null) return false;
	const a = itemSha.toLowerCase();
	const b = stopSha.toLowerCase();
	return a === b || a.startsWith(b) || b.startsWith(a);
}

export function findItemIndex(items: CommitEntry[], stop: WalkthroughStop, fallback = 0): number {
	const idx = items.findIndex((it) => shaMatches(it.sha, stop.sha));
	return idx >= 0 ? idx : fallback;
}

/**
 * Locate the diff line a walkthrough stop should land on.
 * Prefers new-side line on add/context, then old-side on del lines,
 * then any commentable line in the file, then the file header.
 */
export function findLineIndex(diffLines: DiffLine[], stop: WalkthroughStop): number {
	if (!stop.file) return 0;

	const inFile = diffLines
		.map((l, i) => ({ l, i }))
		.filter(({ l }) => pathsMatch(l.file, stop.file!));

	if (inFile.length === 0) return 0;

	if (stop.line !== undefined && stop.line !== null) {
		const byNew = inFile.find(
			({ l }) => isCommentable(l) && l.newLine === stop.line && (l.kind === "add" || l.kind === "context"),
		);
		if (byNew) return byNew.i;

		const byNewAny = inFile.find(({ l }) => isCommentable(l) && l.newLine === stop.line);
		if (byNewAny) return byNewAny.i;

		const byOld = inFile.find(({ l }) => isCommentable(l) && l.oldLine === stop.line);
		if (byOld) return byOld.i;

		// Nearest commentable line by newLine distance, then oldLine.
		const commentable = inFile.filter(({ l }) => isCommentable(l));
		if (commentable.length > 0) {
			let best = commentable[0]!;
			let bestDist = Infinity;
			for (const c of commentable) {
				const candidates = [c.l.newLine, c.l.oldLine].filter((n): n is number => n !== undefined);
				for (const n of candidates) {
					const d = Math.abs(n - stop.line);
					if (d < bestDist) {
						bestDist = d;
						best = c;
					}
				}
			}
			return best.i;
		}
	}

	const firstCommentable = inFile.find(({ l }) => isCommentable(l));
	if (firstCommentable) return firstCommentable.i;

	return inFile[0]!.i;
}
