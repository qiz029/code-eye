#!/usr/bin/env node
/**
 * MCP stdio server: cross-host entry point for Claude Code and Codex (ADR-0004).
 *
 * Exposes the same `review` tool as the pi extension, backed by the web
 * surface only (neither host has a custom TUI component API). The tool call
 * blocks while the user reviews in the browser; line comments come back as
 * the tool result. MCP server processes are spawned by the host outside any
 * sandbox, so the ephemeral 127.0.0.1 server + browser open works everywhere.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CommentStore, formatCommentsForAgent, userComments } from "./comments";
import { listReviewItems, loadDiff, loadFileContent } from "./git";
import { stopsToReviewComments, type WalkthroughStop } from "./walkthrough";
import { openWebReview } from "./web-review";

/** Process-lifetime store: user comments survive reopen within the host session (ADR-0001). */
const commentStore = new CommentStore();

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "code-eye", version: "0.4.0" });

server.registerTool(
	"review",
	{
		title: "Code Review",
		description:
			"Open an interactive code review panel in the user's browser, optionally with a guided walkthrough of the key changes. " +
			"Use this after making changes when the user should review your work. The panel shows commits in base..HEAD " +
			"and uncommitted changes; walkthrough stops point the user at the most important or risky spots. " +
			"The user can leave line comments on the diff. " +
			"The tool blocks until the user closes the panel and returns any comments they left — address each one. " +
			"Closing without comments means the review is accepted; do not treat it as a request for more work.",
		inputSchema: {
			summary: z.string().optional().describe("One-paragraph overview of what changed and why"),
			stops: z
				.array(
					z.object({
						title: z.string().describe("Short headline for this stop"),
						detail: z.string().describe("Why this needs attention; context the user needs"),
						sha: z
							.string()
							.optional()
							.describe("Short commit sha this stop belongs to; omit for uncommitted changes"),
						file: z.string().optional().describe("File path within that commit's diff"),
						line: z.number().optional().describe("Line number in the new version of the file"),
						kind: z.string().optional().describe("Category tag, e.g. change, risk, note"),
					}),
				)
				.optional(),
		},
	},
	async ({ summary, stops }, extra) => {
		const cwd = process.cwd();

		// Headless sessions (claude -p, codex exec, CI) have nobody to review; fail fast.
		if (process.env.CI) {
			return textResult(
				"Interactive review is not available in this environment (CI). Summarize the changes in chat instead.",
			);
		}

		const items = await listReviewItems(cwd);
		if (items.length === 0) {
			return textResult("Nothing to review: no uncommitted changes and no commits in base..HEAD.");
		}

		const all: WalkthroughStop[] = [];
		if (summary) all.push({ title: "Overview", detail: summary, kind: "overview" });
		if (stops) all.push(...stops);
		const split = stopsToReviewComments(all, items);

		// Heartbeat while the user reviews: hosts with an idle timeout (Claude
		// Code kills calls idle for 30min) count progress notifications as activity.
		const progressToken = extra._meta?.progressToken;
		const heartbeat =
			progressToken !== undefined
				? setInterval(() => {
						void extra
							.sendNotification({
								method: "notifications/progress",
								params: { progressToken, progress: 0, message: "Waiting for user review…" },
							})
							.catch(() => {});
					}, 60_000)
				: undefined;

		try {
			const result = await openWebReview({
				cwd,
				items,
				agentComments: split.comments,
				summaries: split.summaries,
				initialComments: commentStore.list(),
				loadDiffFor: (sha) => loadDiff(cwd, sha),
				loadFileFor: (sha, file, side) => loadFileContent(cwd, sha, file, side),
			});
			// ADR-0002: only user comments persist and are fed back to the agent.
			const comments = userComments(result.comments);
			commentStore.replace(comments);
			return textResult(formatCommentsForAgent(comments));
		} finally {
			if (heartbeat !== undefined) clearInterval(heartbeat);
		}
	},
);

await server.connect(new StdioServerTransport());
