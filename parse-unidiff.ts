/**
 * Parse git unified diff output into structured lines.
 * The structure (file, old/new line numbers) is what review comments anchor to.
 */
export interface DiffLine {
	kind: "file" | "meta" | "hunk" | "add" | "del" | "context";
	/** Content without the +/-/space prefix. */
	text: string;
	/** Path of the file this line belongs to ("" before the first file header). */
	file: string;
	/** Line number on the old side, for del/context lines. */
	oldLine?: number;
	/** Line number on the new side, for add/context lines. */
	newLine?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(raw: string): DiffLine[] {
	const out: DiffLine[] = [];
	let file = "";
	let oldLine = 0;
	let newLine = 0;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			file = m ? m[2]! : "";
			out.push({ kind: "file", text: line, file });
		} else if (line.startsWith("+++ b/")) {
			file = line.slice(6);
			out.push({ kind: "meta", text: line, file });
		} else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			out.push({ kind: "meta", text: line, file });
		} else if (HUNK_RE.test(line)) {
			const m = line.match(HUNK_RE)!;
			oldLine = Number.parseInt(m[1]!, 10);
			newLine = Number.parseInt(m[2]!, 10);
			out.push({ kind: "hunk", text: line, file });
		} else if (line.startsWith("+")) {
			out.push({ kind: "add", text: line.slice(1), file, newLine: newLine++ });
		} else if (line.startsWith("-")) {
			out.push({ kind: "del", text: line.slice(1), file, oldLine: oldLine++ });
		} else if (line.startsWith(" ")) {
			out.push({ kind: "context", text: line.slice(1), file, oldLine: oldLine++, newLine: newLine++ });
		} else {
			// file metadata (index/---/new file mode/...), "\ No newline at end of file",
			// and blank separator lines
			out.push({ kind: "meta", text: line, file });
		}
	}
	return out;
}

/** True for lines a review comment can anchor to. */
export function isCommentable(line: DiffLine): boolean {
	return line.kind === "add" || line.kind === "del" || line.kind === "context";
}
