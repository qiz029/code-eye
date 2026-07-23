import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CommentStore,
	formatCommentsForAgent,
	pruneComments,
	userComments,
	type ReviewComment,
} from "./comments";
import { getHeadSha, listReviewItems, loadDiff, loadFileContent } from "./git";
import { loadReviewState, saveReviewState } from "./review-state";
import { ReviewView } from "./review-view";
import { stopsToReviewComments, type WalkthroughStop } from "./walkthrough";
import { openWebReview } from "./web-review";

const walkthroughPrompt = (surface: ReviewSurface) => `Please give me a guided walkthrough of the current changes. Inspect the uncommitted changes (git diff HEAD) and the commits in the base..HEAD range (git log, git show), then call the \`review\` tool with \`surface: "${surface}"\`, a summary and an ordered list of walkthrough stops: the key changes, design decisions, and risky spots I should pay attention to.

For each stop provide:
- sha: short commit sha from git log (omit or empty for uncommitted changes)
- file: path exactly as it appears in the diff header (repo-relative, e.g. src/foo.ts — not absolute)
- line: line number on the NEW side of the file (the number after + in the @@ hunk header, counting added/context lines)
- title: short headline
- detail: the context I need to evaluate it
- kind: optional tag like change / risk / note
- severity: for risky stops, one of high / medium / low (drives the risk filter)
- suggestion: optional replacement code for the anchored line(s) — only when you have a concrete fix to propose; shown read-only, I can ask you to apply it

Only point stops at lines that actually appear in the diff (added or context lines). Prefer the first changed line of each conceptual edit.`;

/** Session-scoped: user comments survive reopen until the pi process exits (ADR-0001).
 * Seeded from / flushed to disk on first open / every close (ADR-0005). */
const commentStore = new CommentStore();
let storeSeeded = false;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

type ReviewSurface = "tui" | "web";

interface OpenReviewOptions {
	stops?: WalkthroughStop[];
	/** When true and the user left comments, inject them into the chat as a follow-up. */
	sendCommentsAsFollowUp?: boolean;
	/** Review UI to use; default TUI overlay. */
	surface?: ReviewSurface;
}

/**
 * Open the review panel (TUI overlay or local web surface). Returns null when
 * there is nothing to review. The returned comments are user comments only —
 * agent walkthrough notes never leave the session (ADR-0002).
 */
async function openReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: OpenReviewOptions = {},
): Promise<{ comments: ReviewComment[] } | null> {
	// ADR-0005: on-disk state feeds the delta item and seeds persisted comments.
	const state = await loadReviewState(ctx.cwd);
	const items = await listReviewItems(ctx.cwd, { since: state.lastReviewedHead });
	if (items.length === 0) return null;

	if (!storeSeeded) {
		storeSeeded = true;
		commentStore.replace(pruneComments(state.comments, items));
	}

	// The delta item (sha null + since) diffs the working tree against the
	// last-reviewed commit instead of HEAD.
	const deltaSince = items.find((i) => i.since)?.since;
	const loadDiffFor = (sha: string | null) =>
		sha === null && deltaSince ? loadDiff(ctx.cwd, null, deltaSince) : loadDiff(ctx.cwd, sha);
	const loadFileFor = (sha: string | null, file: string, side: "new" | "old") =>
		loadFileContent(ctx.cwd, sha, file, side, sha === null ? deltaSince : undefined);

	let all: ReviewComment[];
	if (opts.surface === "web") {
		const split = stopsToReviewComments(opts.stops ?? [], items);
		const result = await openWebReview({
			cwd: ctx.cwd,
			items,
			agentComments: split.comments,
			summaries: split.summaries,
			initialComments: commentStore.list(),
			loadDiffFor,
			loadFileFor,
		});
		all = result.comments;
	} else {
		const initialDiff = await loadDiffFor(items[0]!.sha);
		const result = await ctx.ui.custom<{ comments: ReviewComment[] }>(
			(tui, theme, _keybindings, done) =>
				new ReviewView({
					items,
					initialDiff,
					loadDiffFor,
					theme,
					tui,
					done,
					termRows: tui.terminal.rows,
					stops: opts.stops,
					initialComments: commentStore.list(),
					onRequestWalkthrough: () => {
						// Walkthrough request closes the panel via done path; send prompt after.
						pi.sendUserMessage(walkthroughPrompt("tui"), { deliverAs: "followUp" });
					},
				}),
			{
				overlay: true,
				overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
			},
		);
		all = result?.comments ?? [];
	}

	// ADR-0002: only user comments persist and may re-trigger the agent.
	const comments = userComments(all);
	commentStore.replace(comments);
	// ADR-0005: persist across sessions; record HEAD for the next delta item.
	await saveReviewState(ctx.cwd, {
		version: 1,
		comments: commentStore.list(),
		lastReviewedHead: (await getHeadSha(ctx.cwd)) ?? undefined,
	});

	if (opts.sendCommentsAsFollowUp && comments.length > 0) {
		pi.sendUserMessage(formatCommentsForAgent(comments), { deliverAs: "followUp" });
	}

	return { comments };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "error") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("code-eye", {
		description: "Open code review (uncommitted changes + commits in base..HEAD)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				const opened = await openReview(pi, ctx, { sendCommentsAsFollowUp: true });
				if (!opened) {
					notify(ctx, "Nothing to review: no uncommitted changes and no commits in base..HEAD", "info");
				} else if (opened.comments.length > 0) {
					notify(ctx, `Sent ${opened.comments.length} comment(s) to the agent`, "info");
				}
			} catch (err) {
				notify(ctx, `code-eye: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("code-eye-web", {
		description: "Walk through the current changes, then open the review in the browser (local web surface, ADR-0003)",
		handler: async (_args, ctx) => {
			// Web surface defaults to walkthrough-first: the agent generates stops,
			// then opens the browser review with them already attached.
			pi.sendUserMessage(walkthroughPrompt("web"), { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("code-eye-walkthrough", {
		description: "Ask the agent to walk you through the current changes in the review panel",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			pi.sendUserMessage(walkthroughPrompt("tui"), { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: "review",
		label: "Code Review",
		description:
			"Open an interactive code review panel for the user, optionally with a guided walkthrough of the key changes. " +
			"Use this after making changes when the user should review your work. The panel shows commits in base..HEAD " +
			"and uncommitted changes; walkthrough stops point the user at the most important or risky spots. " +
			"The user can leave line comments on the diff. " +
			"The tool blocks until the user closes the panel and returns any comments they left — address each one. " +
			"Comments the user marked resolved are not returned. Replies to your walkthrough notes come back " +
			"tagged as questions or suggestion-adoption requests. " +
			"Closing without comments means the review is accepted; do not treat it as a request for more work.",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "One-paragraph overview of what changed and why" })),
			stops: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "Short headline for this stop" }),
						detail: Type.String({ description: "Why this needs attention; context the user needs" }),
						sha: Type.Optional(
							Type.String({
								description: "Short commit sha this stop belongs to; omit for uncommitted changes",
							}),
						),
						file: Type.Optional(Type.String({ description: "File path within that commit's diff" })),
						line: Type.Optional(Type.Number({ description: "Line number in the new version of the file" })),
						kind: Type.Optional(Type.String({ description: "Category tag, e.g. change, risk, note" })),
						severity: Type.Optional(
							Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
								description: "Risk level for risky stops; shown as a colored chip and drives the risk filter",
							}),
						),
						suggestion: Type.Optional(
							Type.String({
								description:
									"Replacement code for the anchored line(s); shown read-only, the user can ask you to apply it",
							}),
						),
					}),
				),
			),
			surface: Type.Optional(
				Type.Union([Type.Literal("tui"), Type.Literal("web")], {
					description: 'Review UI: "tui" overlay (default) or "web" (opens a local browser page)',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const surface: ReviewSurface = params.surface ?? "tui";
			if (surface === "tui" && !ctx.hasUI) {
				return textResult("Review panel is not available in this mode; summarize the changes in chat instead.");
			}
			const stops: WalkthroughStop[] = [];
			if (params.summary) {
				stops.push({ title: "Overview", detail: params.summary, kind: "overview" });
			}
			if (params.stops) stops.push(...params.stops);

			// Tool path: comments come back in the tool result (no extra follow-up message).
			const opened = await openReview(pi, ctx, {
				stops: stops.length > 0 ? stops : undefined,
				sendCommentsAsFollowUp: false,
				surface,
			});
			if (!opened) {
				return textResult("Nothing to review: no uncommitted changes and no commits in base..HEAD.");
			}
			// ADR-0002: empty user-comment result is a short "no further action" message.
			return textResult(formatCommentsForAgent(opened.comments));
		},
		renderCall(args, theme) {
			const n = args.stops?.length ?? 0;
			const surface = args.surface === "web" ? "web · " : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("review ")) +
					theme.fg("muted", surface + (n > 0 ? `${n} walkthrough stop(s)` : "no walkthrough")),
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Waiting for user review…"), 0, 0);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const hasComments = /left \d+ comment/.test(text);
			return new Text(
				hasComments ? theme.fg("warning", `✓ ${text.split("\n")[0]}`) : theme.fg("success", `✓ ${text}`),
				0,
				0,
			);
		},
	});
}
