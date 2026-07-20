import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listReviewItems, loadDiff } from "./git";
import { ReviewView } from "./review-view";
import type { WalkthroughStop } from "./walkthrough";

const WALKTHROUGH_PROMPT = `Please give me a guided walkthrough of the current changes. Inspect the uncommitted changes (git diff HEAD) and the commits in the base..HEAD range (git log, git show), then call the \`review\` tool with a summary and an ordered list of walkthrough stops: the key changes, design decisions, and risky spots I should pay attention to. For each stop provide the commit sha (short, empty for uncommitted changes), file, new-side line number, a short title, and the context I need to evaluate it.`;

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** Open the review overlay. Returns false when there is nothing to review. */
async function openReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stops?: WalkthroughStop[],
): Promise<boolean> {
	const items = await listReviewItems(ctx.cwd);
	if (items.length === 0) return false;

	const initialDiff = await loadDiff(ctx.cwd, items[0]!.sha);
	await ctx.ui.custom<null>(
		(tui, theme, _keybindings, done) =>
			new ReviewView({
				items,
				initialDiff,
				loadDiffFor: (sha) => loadDiff(ctx.cwd, sha),
				theme,
				tui,
				done,
				termRows: tui.terminal.rows,
				stops,
				onRequestWalkthrough: () => {
					done(null);
					pi.sendUserMessage(WALKTHROUGH_PROMPT, { deliverAs: "followUp" });
				},
			}),
		{
			overlay: true,
			overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
		},
	);
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("code-eye", {
		description: "Open code review (uncommitted changes + commits in base..HEAD)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				if (!(await openReview(pi, ctx))) {
					ctx.ui.notify("Nothing to review: no uncommitted changes and no commits in base..HEAD", "info");
				}
			} catch (err) {
				ctx.ui.notify(`code-eye: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("code-eye-walkthrough", {
		description: "Ask the agent to walk you through the current changes in the review panel",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			pi.sendUserMessage(WALKTHROUGH_PROMPT, { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: "review",
		label: "Code Review",
		description:
			"Open an interactive code review panel for the user, optionally with a guided walkthrough of the key changes. " +
			"Use this after making changes when the user should review your work. The panel shows commits in base..HEAD " +
			"and uncommitted changes; walkthrough stops point the user at the most important or risky spots. " +
			"The tool blocks until the user closes the panel.",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "One-paragraph overview of what changed and why" })),
			stops: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "Short headline for this stop" }),
						detail: Type.String({ description: "Why this needs attention; context the user needs" }),
						sha: Type.Optional(
							Type.String({ description: "Short commit sha this stop belongs to; omit for uncommitted changes" }),
						),
						file: Type.Optional(Type.String({ description: "File path within that commit's diff" })),
						line: Type.Optional(Type.Number({ description: "Line number in the new version of the file" })),
						kind: Type.Optional(Type.String({ description: "Category tag, e.g. change, risk, note" })),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return textResult("Review panel is not available in this mode; summarize the changes in chat instead.");
			}
			const stops: WalkthroughStop[] = [];
			if (params.summary) {
				stops.push({ title: "Overview", detail: params.summary, kind: "overview" });
			}
			if (params.stops) stops.push(...params.stops);

			const opened = await openReview(pi, ctx, stops.length > 0 ? stops : undefined);
			return textResult(
				opened
					? "The user reviewed the changes in the review panel and closed it."
					: "Nothing to review: no uncommitted changes and no commits in base..HEAD.",
			);
		},
		renderCall(args, theme) {
			const n = args.stops?.length ?? 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("review ")) +
					theme.fg("muted", n > 0 ? `${n} walkthrough stop(s)` : "no walkthrough"),
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Waiting for user review…"), 0, 0);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
		},
	});
}
