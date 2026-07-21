import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	anchorFromDiffLine,
	commentsForSha,
	findCommentAt,
	findCommentLineIndex,
	removeCommentAt,
	upsertComment,
	type ReviewComment,
	type ReviewResult,
} from "./comments";
import type { CommitEntry } from "./git";
import { findItemIndex, findLineIndex } from "./locate";
import { isCommentable, parseUnifiedDiff, type DiffLine } from "./parse-unidiff";
import type { WalkthroughStop } from "./walkthrough";

type Focus = "commits" | "diff" | "comment";

export interface ReviewViewOptions {
	items: CommitEntry[];
	initialDiff: string;
	loadDiffFor: (sha: string | null) => Promise<string>;
	theme: Theme;
	tui: TUI;
	done: (result: ReviewResult) => void;
	termRows: number;
	/** Agent-provided walkthrough stops; enables the banner and n/p navigation. */
	stops?: WalkthroughStop[];
	/** Called when the user presses w: ask the agent for a walkthrough. */
	onRequestWalkthrough?: () => void;
	/** Seed comments (session store); mutated list is returned via done(). */
	initialComments?: ReviewComment[];
}

/** Truncate or space-pad a (possibly ANSI-styled) line to exactly `width` columns. */
function fitToWidth(line: string, width: number): string {
	const vw = visibleWidth(line);
	if (vw > width) return truncateToWidth(line, width, "");
	if (vw < width) return line + " ".repeat(width - vw);
	return line;
}

/**
 * Two-pane code review overlay: commit list on the left, rendered diff on
 * the right. Supports walkthrough stops and inline user comments.
 *
 * Drawn as a rounded box (╭─╮ / │ │ / ╰─╯) so the floating overlay has a
 * visible frame against the chat behind it.
 */
export class ReviewView implements Component, Focusable {
	/** Set by TUI when this overlay owns focus; forwarded to the Input. */
	focused = false;

	private focus: Focus = "commits";
	private selected = 0;
	private cursor = 0;
	private diffLines: DiffLine[];
	private loadToken = 0;
	private stopIndex = 0;
	private readonly stops: WalkthroughStop[];
	private comments: ReviewComment[];
	private readonly input = new Input();
	/** Status toast shown briefly in the footer (e.g. "comment saved"). */
	private status: string | null = null;

	constructor(private readonly opts: ReviewViewOptions) {
		this.stops = opts.stops ?? [];
		this.comments = (opts.initialComments ?? []).slice();
		this.diffLines = parseUnifiedDiff(opts.initialDiff);
		this.input.onSubmit = (value) => this.commitCommentInput(value);
		this.input.onEscape = () => this.cancelCommentInput();
		if (this.stops.length > 0) {
			void this.gotoStop(0);
		}
	}

	private get theme(): Theme {
		return this.opts.theme;
	}

	private border(ch: string): string {
		return this.theme.fg("border", ch);
	}

	private currentSha(): string | null {
		return this.opts.items[this.selected]!.sha;
	}

	private currentAnchor() {
		const line = this.diffLines[this.cursor];
		if (!line) return null;
		return anchorFromDiffLine(line, this.currentSha());
	}

	private setStatus(msg: string): void {
		this.status = msg;
	}

	private renderDiffLine(line: DiffLine, hasComment: boolean): string {
		const t = this.theme;
		const mark = hasComment ? t.fg("warning", "●") : " ";
		switch (line.kind) {
			case "file":
				return t.fg("accent", t.bold(line.text));
			case "hunk":
				return t.fg("muted", line.text);
			case "add":
				return (
					mark + t.fg("toolDiffAdded", `+${String(line.newLine ?? "").padStart(4)} ${line.text}`)
				);
			case "del":
				return (
					mark + t.fg("toolDiffRemoved", `-${String(line.oldLine ?? "").padStart(4)} ${line.text}`)
				);
			case "context":
				return (
					mark + t.fg("toolDiffContext", ` ${String(line.newLine ?? "").padStart(4)} ${line.text}`)
				);
			default:
				return t.fg("dim", line.text);
		}
	}

	private async select(index: number): Promise<void> {
		this.selected = index;
		this.cursor = 0;
		const token = ++this.loadToken;
		const raw = await this.opts.loadDiffFor(this.opts.items[index]!.sha);
		if (token !== this.loadToken) return;
		this.diffLines = parseUnifiedDiff(raw);
		this.opts.tui.requestRender();
	}

	// ---- walkthrough ----

	private async gotoStop(i: number): Promise<void> {
		if (this.stops.length === 0) return;
		this.stopIndex = ((i % this.stops.length) + this.stops.length) % this.stops.length;
		const stop = this.stops[this.stopIndex]!;
		const target = findItemIndex(this.opts.items, stop, this.selected);
		if (target !== this.selected) {
			await this.select(target);
		}
		this.cursor = findLineIndex(this.diffLines, stop);
		this.focus = "diff";
		this.opts.tui.requestRender();
	}

	// ---- comments ----

	private beginCommentInput(): void {
		const anchor = this.currentAnchor();
		if (!anchor) {
			this.setStatus("cursor is not on a commentable line");
			this.opts.tui.requestRender();
			return;
		}
		const existing = findCommentAt(this.comments, anchor);
		this.input.setValue(existing?.body ?? "");
		this.input.focused = true;
		this.focus = "comment";
		this.status = null;
		this.opts.tui.requestRender();
	}

	private commitCommentInput(value: string): void {
		const anchor = this.currentAnchor();
		if (!anchor) {
			this.cancelCommentInput();
			return;
		}
		const before = this.comments.length;
		this.comments = upsertComment(this.comments, anchor, value);
		const after = this.comments.length;
		this.input.setValue("");
		this.input.focused = false;
		this.focus = "diff";
		if (!value.trim()) {
			this.setStatus(before > after ? "comment removed" : "cancelled");
		} else if (after === before) {
			this.setStatus("comment updated");
		} else {
			this.setStatus("comment added");
		}
		this.opts.tui.requestRender();
	}

	private cancelCommentInput(): void {
		this.input.setValue("");
		this.input.focused = false;
		this.focus = "diff";
		this.setStatus("cancelled");
		this.opts.tui.requestRender();
	}

	private deleteCommentAtCursor(): void {
		const anchor = this.currentAnchor();
		if (!anchor) {
			this.setStatus("cursor is not on a commentable line");
			this.opts.tui.requestRender();
			return;
		}
		const existing = findCommentAt(this.comments, anchor);
		if (!existing) {
			this.setStatus("no comment on this line");
			this.opts.tui.requestRender();
			return;
		}
		this.comments = removeCommentAt(this.comments, anchor);
		this.setStatus("comment removed");
		this.opts.tui.requestRender();
	}

	/** Jump to next/prev comment, wrapping; switches commit when needed. */
	private async jumpComment(dir: 1 | -1): Promise<void> {
		if (this.comments.length === 0) {
			this.setStatus("no comments yet");
			this.opts.tui.requestRender();
			return;
		}

		// Build ordered list: by item order, then file, then line.
		const ordered = this.orderedComments();
		const anchor = this.currentAnchor();
		let idx = -1;
		if (anchor) {
			idx = ordered.findIndex(
				(c) =>
					c.file === anchor.file &&
					c.side === anchor.side &&
					c.line === anchor.line &&
					(c.sha === null) === (anchor.sha === null) &&
					(anchor.sha === null || c.sha === anchor.sha),
			);
		}
		const next = ordered[((idx < 0 ? (dir === 1 ? -1 : 0) : idx) + dir + ordered.length) % ordered.length]!;
		await this.gotoComment(next);
	}

	private orderedComments(): ReviewComment[] {
		const itemOrder = new Map<string, number>();
		this.opts.items.forEach((it, i) => itemOrder.set(it.sha ?? "working", i));
		return this.comments.slice().sort((a, b) => {
			const ai = itemOrder.get(a.sha ?? "working") ?? 999;
			const bi = itemOrder.get(b.sha ?? "working") ?? 999;
			if (ai !== bi) return ai - bi;
			if (a.file !== b.file) return a.file.localeCompare(b.file);
			if (a.side !== b.side) return a.side === "new" ? -1 : 1;
			return a.line - b.line;
		});
	}

	private async gotoComment(c: ReviewComment): Promise<void> {
		const target = this.opts.items.findIndex(
			(it) => (it.sha === null) === (c.sha === null) && (c.sha === null || it.sha === c.sha),
		);
		if (target >= 0 && target !== this.selected) {
			await this.select(target);
		}
		const idx = findCommentLineIndex(this.diffLines, c);
		if (idx >= 0) this.cursor = idx;
		this.focus = "diff";
		this.setStatus(`comment on ${c.file}:${c.line}`);
		this.opts.tui.requestRender();
	}

	private close(): void {
		this.opts.done({ comments: this.comments.slice() });
	}

	// ---- layout ----

	private bodyHeight(outerHeight: number, bannerRows: number, extraRows: number): number {
		// top border, subject, title sep, [banner], body, footer sep, help, [input], bottom
		const chrome = 2 + 1 + bannerRows + 1 + 1 + extraRows + 1;
		return Math.max(5, outerHeight - chrome);
	}

	private outerHeight(): number {
		return Math.max(12, Math.floor(this.opts.termRows * 0.85));
	}

	handleInput(data: string): void {
		const tui = this.opts.tui;

		// Comment input mode: route keys to Input
		if (this.focus === "comment") {
			this.input.focused = true;
			this.input.handleInput(data);
			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}

		// Global comment shortcuts (work from either pane)
		if (matchesKey(data, "c")) {
			if (this.focus === "commits") this.focus = "diff";
			this.beginCommentInput();
			return;
		}
		if (matchesKey(data, "d")) {
			if (this.focus !== "diff") {
				// only delete when staring at a line
				this.focus = "diff";
			}
			this.deleteCommentAtCursor();
			return;
		}
		if (matchesKey(data, "]")) {
			void this.jumpComment(1);
			return;
		}
		if (matchesKey(data, "[")) {
			void this.jumpComment(-1);
			return;
		}

		if (this.stops.length > 0) {
			if (matchesKey(data, "n")) {
				void this.gotoStop(this.stopIndex + 1);
				return;
			}
			if (matchesKey(data, "p")) {
				void this.gotoStop(this.stopIndex - 1);
				return;
			}
		} else if (matchesKey(data, "w") && this.opts.onRequestWalkthrough) {
			// Close with current comments, then request walkthrough.
			this.opts.onRequestWalkthrough();
			this.close();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.focus = this.focus === "commits" ? "diff" : "commits";
			tui.requestRender();
			return;
		}

		const outerH = this.outerHeight();
		const bannerRows = this.stops.length > 0 ? 3 : 0;
		// composer rows only apply while focus==='comment', which returns earlier
		const page = this.bodyHeight(outerH, bannerRows, 0);

		if (this.focus === "commits") {
			if (matchesKey(data, Key.up) && this.selected > 0) {
				void this.select(this.selected - 1);
			} else if (matchesKey(data, Key.down) && this.selected < this.opts.items.length - 1) {
				void this.select(this.selected + 1);
			} else if (matchesKey(data, Key.enter)) {
				this.focus = "diff";
			}
			tui.requestRender();
			return;
		}

		// diff pane
		if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
			this.status = null;
		} else if (matchesKey(data, Key.down) && this.cursor < this.diffLines.length - 1) {
			this.cursor++;
			this.status = null;
		} else if (matchesKey(data, Key.pageUp)) {
			this.cursor = Math.max(0, this.cursor - page);
		} else if (matchesKey(data, Key.pageDown)) {
			this.cursor = Math.min(this.diffLines.length - 1, this.cursor + page);
		} else if (matchesKey(data, Key.left)) {
			this.focus = "commits";
		} else if (matchesKey(data, Key.enter)) {
			// Enter on a commentable line → edit/add comment
			const line = this.diffLines[this.cursor];
			if (line && isCommentable(line)) {
				this.beginCommentInput();
				return;
			}
		}
		tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const items = this.opts.items;
		const B = (ch: string) => this.border(ch);
		const innerW = Math.max(20, width - 2);

		// Keep Input focus in sync (TUI sets ReviewView.focused)
		this.input.focused = this.focused && this.focus === "comment";

		// Banner content
		const bannerInner: string[] = [];
		if (this.stops.length > 0) {
			const stop = this.stops[this.stopIndex]!;
			const tag = `[${this.stopIndex + 1}/${this.stops.length}]`;
			const kind = stop.kind ? t.fg("warning", ` · ${stop.kind}`) : "";
			const loc = stop.file
				? t.fg("dim", ` · ${stop.file}${stop.line != null ? `:${stop.line}` : ""}`)
				: "";
			bannerInner.push(
				fitToWidth(t.fg("accent", t.bold(` ${tag} `)) + t.bold(stop.title) + kind + loc, innerW),
			);
			const detailLines = wrapTextWithAnsi(stop.detail, innerW - 2).slice(0, 2);
			for (const dl of detailLines) {
				bannerInner.push(fitToWidth("  " + t.fg("muted", dl), innerW));
			}
			while (bannerInner.length < 3) bannerInner.push(" ".repeat(innerW));
		}

		// Peek: show comment body under cursor (when not composing)
		const cursorAnchor = this.diffLines[this.cursor]
			? anchorFromDiffLine(this.diffLines[this.cursor]!, this.currentSha())
			: null;
		const cursorComment = cursorAnchor ? findCommentAt(this.comments, cursorAnchor) : undefined;
		const peekRows: string[] = [];
		if (cursorComment && this.focus !== "comment") {
			const peeks = wrapTextWithAnsi(`💬 ${cursorComment.body}`, innerW - 2).slice(0, 2);
			for (const p of peeks) peekRows.push(fitToWidth(" " + t.fg("warning", p), innerW));
		}

		const composing = this.focus === "comment";
		const extraRows = (composing ? 2 : 0) + peekRows.length;
		const body = this.bodyHeight(this.outerHeight(), bannerInner.length, extraRows);
		const leftWidth = Math.max(22, Math.min(40, Math.floor(innerW * 0.28)));
		const rightWidth = Math.max(10, innerW - leftWidth - 3);

		const lines: string[] = [];

		// top border with title
		const nComments = this.comments.length;
		const titleText =
			nComments > 0
				? ` Code Review · ${items.length} item(s) · ${nComments} comment${nComments === 1 ? "" : "s"} `
				: ` Code Review · ${items.length} item(s) `;
		const titleStyled = t.fg("accent", t.bold(titleText));
		const titleW = visibleWidth(titleText);
		const leftPad = Math.max(0, Math.floor((innerW - titleW) / 2));
		const rightPad = Math.max(0, innerW - titleW - leftPad);
		lines.push(B("╭") + B("─".repeat(leftPad)) + titleStyled + B("─".repeat(rightPad)) + B("╮"));

		const subject = truncateToWidth(
			` ${items[this.selected]!.label} · ${items[this.selected]!.subject}`,
			innerW,
			"",
		);
		lines.push(B("│") + fitToWidth(t.fg("dim", subject), innerW) + B("│"));
		lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));

		if (bannerInner.length > 0) {
			for (const row of bannerInner) lines.push(B("│") + row + B("│"));
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		}

		// two-pane body
		const leftStart = Math.min(
			Math.max(0, this.selected - Math.floor(body / 2)),
			Math.max(0, items.length - body),
		);
		const leftLines: string[] = [];
		for (let r = 0; r < body; r++) {
			const i = leftStart + r;
			if (i >= items.length) {
				leftLines.push(" ".repeat(leftWidth));
				continue;
			}
			const item = items[i]!;
			const isSelected = i === this.selected;
			const nOnItem = commentsForSha(this.comments, item.sha).length;
			const badge = nOnItem > 0 ? t.fg("warning", ` (${nOnItem})`) : "";
			const marker = isSelected ? (this.focus === "commits" ? "▸ " : "• ") : "  ";
			const text = `${marker}${item.label} ${item.subject}`;
			// reserve room for badge in width calc roughly
			const base = truncateToWidth(text, Math.max(4, leftWidth - (nOnItem > 0 ? 5 : 0)), "");
			let styled: string;
			if (isSelected && this.focus === "commits") {
				styled = t.bg("selectedBg", t.fg("accent", t.bold(base))) + badge;
			} else if (isSelected) {
				styled = t.fg("accent", base) + badge;
			} else if (item.sha === null) {
				styled = t.fg("warning", base) + badge;
			} else {
				styled = base + badge;
			}
			leftLines.push(fitToWidth(styled, leftWidth));
		}

		const shaComments = commentsForSha(this.comments, this.currentSha());
		const commentedKeys = new Set(
			shaComments.map((c) => `${c.file}\0${c.side}\0${c.line}`),
		);

		const rightStart = Math.min(
			Math.max(0, this.cursor - Math.floor(body / 2)),
			Math.max(0, this.diffLines.length - body),
		);
		const rightLines: string[] = [];
		for (let r = 0; r < body; r++) {
			const i = rightStart + r;
			if (i >= this.diffLines.length) {
				rightLines.push(" ".repeat(rightWidth));
				continue;
			}
			const dl = this.diffLines[i]!;
			const anchor = anchorFromDiffLine(dl, this.currentSha());
			const has =
				!!anchor && commentedKeys.has(`${anchor.file}\0${anchor.side}\0${anchor.line}`);
			let line = this.renderDiffLine(dl, has);
			if (i === this.cursor && (this.focus === "diff" || this.focus === "comment")) {
				line = t.bg("selectedBg", fitToWidth(truncateToWidth(line, rightWidth, ""), rightWidth));
			} else {
				line = fitToWidth(truncateToWidth(line, rightWidth, ""), rightWidth);
			}
			rightLines.push(line);
		}

		const paneSep = B("│");
		for (let r = 0; r < body; r++) {
			lines.push(B("│") + leftLines[r]! + " " + paneSep + " " + rightLines[r]! + B("│"));
		}

		// comment peek under cursor
		if (peekRows.length > 0) {
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
			for (const p of peekRows) lines.push(B("│") + p + B("│"));
		}

		// composer
		if (composing) {
			const anchor = cursorAnchor;
			const loc = anchor
				? `${anchor.file}:${anchor.line} (${anchor.side})`
				: "unknown";
			lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
			const label = t.fg("accent", " comment ") + t.fg("dim", loc + " · enter save · esc cancel");
			lines.push(B("│") + fitToWidth(label, innerW) + B("│"));
			const inputLines = this.input.render(Math.max(1, innerW - 2));
			const inputRow = fitToWidth(" " + (inputLines[0] ?? ""), innerW);
			lines.push(B("│") + inputRow + B("│"));
		}

		// footer
		lines.push(B("├") + B("─".repeat(innerW)) + B("┤"));
		let help: string;
		if (this.status) {
			help = ` ${this.status}`;
		} else if (composing) {
			help = " type comment · enter save · esc cancel";
		} else {
			const walkHint = this.stops.length > 0 ? " · n/p stop" : " · w walkthrough";
			const cHint = " · c comment · d del · [/] jump";
			help =
				this.focus === "commits"
					? ` ↑↓ commit · enter/tab diff${cHint}${walkHint} · esc`
					: ` ↑↓ scroll · enter/c comment${cHint}${walkHint} · esc`;
		}
		lines.push(B("│") + fitToWidth(t.fg("dim", help), innerW) + B("│"));
		lines.push(B("╰") + B("─".repeat(innerW)) + B("╯"));

		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
