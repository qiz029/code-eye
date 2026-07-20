import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { CommitEntry } from "./git";
import { isCommentable, parseUnifiedDiff, type DiffLine } from "./parse-unidiff";
import type { WalkthroughStop } from "./walkthrough";

type Focus = "commits" | "diff";

export interface ReviewViewOptions {
	items: CommitEntry[];
	initialDiff: string;
	loadDiffFor: (sha: string | null) => Promise<string>;
	theme: Theme;
	tui: TUI;
	done: (result: null) => void;
	termRows: number;
	/** Agent-provided walkthrough stops; enables the banner and n/p navigation. */
	stops?: WalkthroughStop[];
	/** Called when the user presses w: ask the agent for a walkthrough. */
	onRequestWalkthrough?: () => void;
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
 * the right. With walkthrough stops, a banner shows the current stop and
 * n/p jumps between stops. Tab switches focus; Esc closes.
 */
export class ReviewView implements Component {
	private focus: Focus = "commits";
	private selected = 0;
	private cursor = 0;
	private diffLines: DiffLine[];
	private loadToken = 0;
	private stopIndex = 0;
	private readonly stops: WalkthroughStop[];

	constructor(private readonly opts: ReviewViewOptions) {
		this.stops = opts.stops ?? [];
		this.diffLines = parseUnifiedDiff(opts.initialDiff);
		if (this.stops.length > 0) {
			void this.gotoStop(0);
		}
	}

	private get theme(): Theme {
		return this.opts.theme;
	}

	private renderDiffLine(line: DiffLine): string {
		const t = this.theme;
		switch (line.kind) {
			case "file":
				return t.fg("accent", t.bold(line.text));
			case "hunk":
				return t.fg("muted", line.text);
			case "add":
				return t.fg("toolDiffAdded", `+${line.newLine} ${line.text}`);
			case "del":
				return t.fg("toolDiffRemoved", `-${line.oldLine} ${line.text}`);
			case "context":
				return t.fg("toolDiffContext", ` ${line.newLine} ${line.text}`);
			default:
				return t.fg("dim", line.text);
		}
	}

	private async select(index: number): Promise<void> {
		this.selected = index;
		this.cursor = 0;
		const token = ++this.loadToken;
		const raw = await this.opts.loadDiffFor(this.opts.items[index]!.sha);
		if (token !== this.loadToken) return; // a newer selection superseded this load
		this.diffLines = parseUnifiedDiff(raw);
		this.opts.tui.requestRender();
	}

	// ---- walkthrough ----

	private findItemIndex(stop: WalkthroughStop): number {
		if (stop.sha) {
			const idx = this.opts.items.findIndex((it) => it.sha !== null && it.sha.startsWith(stop.sha!));
			if (idx >= 0) return idx;
		} else {
			const idx = this.opts.items.findIndex((it) => it.sha === null);
			if (idx >= 0) return idx;
		}
		return this.selected;
	}

	private findLineIndex(stop: WalkthroughStop): number {
		if (stop.file) {
			const byLine = this.diffLines.findIndex(
				(l) => l.file === stop.file && (l.newLine === stop.line || l.oldLine === stop.line),
			);
			if (byLine >= 0) return byLine;
			const byFile = this.diffLines.findIndex((l) => l.file === stop.file && isCommentable(l));
			if (byFile >= 0) return byFile;
		}
		return 0;
	}

	private async gotoStop(i: number): Promise<void> {
		if (this.stops.length === 0) return;
		this.stopIndex = ((i % this.stops.length) + this.stops.length) % this.stops.length;
		const stop = this.stops[this.stopIndex]!;
		const target = this.findItemIndex(stop);
		if (target !== this.selected) {
			await this.select(target);
		}
		this.cursor = this.findLineIndex(stop);
		this.focus = "diff";
		this.opts.tui.requestRender();
	}

	// ---- layout ----

	private bannerHeight(): number {
		return this.stops.length > 0 ? 3 : 0;
	}

	private bodyHeight(): number {
		// header + separator + footer separator + help line = 4 chrome lines
		return Math.max(5, Math.floor(this.opts.termRows * 0.85) - 4 - this.bannerHeight());
	}

	handleInput(data: string): void {
		const tui = this.opts.tui;
		if (matchesKey(data, Key.escape)) {
			this.opts.done(null);
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
			this.opts.onRequestWalkthrough();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.focus = this.focus === "commits" ? "diff" : "commits";
			tui.requestRender();
			return;
		}

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
		const page = this.bodyHeight();
		if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
		} else if (matchesKey(data, Key.down) && this.cursor < this.diffLines.length - 1) {
			this.cursor++;
		} else if (matchesKey(data, Key.pageUp)) {
			this.cursor = Math.max(0, this.cursor - page);
		} else if (matchesKey(data, Key.pageDown)) {
			this.cursor = Math.min(this.diffLines.length - 1, this.cursor + page);
		} else if (matchesKey(data, Key.left)) {
			this.focus = "commits";
		}
		tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const items = this.opts.items;
		const body = this.bodyHeight();
		const leftWidth = Math.max(24, Math.min(44, Math.floor(width * 0.3)));
		const rightWidth = Math.max(10, width - leftWidth - 3); // 3 = " │ "

		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				t.fg("accent", t.bold(" Code Review ")) +
					t.fg("dim", `${items.length} item(s) — ${items[this.selected]!.subject}`),
				width,
				"",
			),
		);
		lines.push(t.fg("border", "─".repeat(width)));

		// Walkthrough banner
		if (this.stops.length > 0) {
			const stop = this.stops[this.stopIndex]!;
			const tag = `[${this.stopIndex + 1}/${this.stops.length}]`;
			const kind = stop.kind ? t.fg("warning", ` ${stop.kind} `) : "";
			const loc = stop.file ? t.fg("dim", ` ${stop.file}${stop.line ? `:${stop.line}` : ""}`) : "";
			lines.push(truncateToWidth(t.fg("accent", ` ${tag} `) + t.bold(stop.title) + kind + loc, width, ""));
			for (const detailLine of wrapTextWithAnsi(stop.detail, width - 2).slice(0, 2)) {
				lines.push(" " + t.fg("muted", detailLine));
			}
			lines.push(t.fg("border", "─".repeat(width)));
		}

		// Left pane: commit list, windowed around the selection
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
			const text = `${isSelected ? "> " : "  "}${item.label} ${item.subject}`;
			const styled = isSelected
				? this.focus === "commits"
					? t.fg("accent", t.bold(text))
					: t.fg("accent", text)
				: item.sha === null
					? t.fg("warning", text)
					: text;
			leftLines.push(fitToWidth(styled, leftWidth));
		}

		// Right pane: diff lines, windowed around the cursor
		const rightStart = Math.min(
			Math.max(0, this.cursor - Math.floor(body / 2)),
			Math.max(0, this.diffLines.length - body),
		);
		const rightLines: string[] = [];
		for (let r = 0; r < body; r++) {
			const i = rightStart + r;
			let line = i < this.diffLines.length ? this.renderDiffLine(this.diffLines[i]!) : "";
			line = truncateToWidth(line, rightWidth, "");
			if (this.focus === "diff" && i === this.cursor) {
				line = t.bg("selectedBg", fitToWidth(line, rightWidth));
			}
			rightLines.push(line);
		}

		const sep = t.fg("border", " │ ");
		for (let r = 0; r < body; r++) {
			lines.push(leftLines[r]! + sep + rightLines[r]!);
		}

		lines.push(t.fg("border", "─".repeat(width)));
		const walkHint = this.stops.length > 0 ? " · n/p prev/next stop" : " · w walkthrough";
		const help =
			this.focus === "commits"
				? ` ↑↓ select commit · enter/tab view diff${walkHint} · esc close`
				: ` ↑↓ scroll · PgUp/PgDn page · ←/tab commit list${walkHint} · esc close`;
		lines.push(truncateToWidth(t.fg("dim", help), width, ""));
		return lines;
	}

	invalidate(): void {
		// no cached render state; theme colors are applied fresh in render()
	}
}
