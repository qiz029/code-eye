/**
 * Temporary local web review surface (ADR-0003).
 *
 * Spins up an ephemeral 127.0.0.1 HTTP server for one review session,
 * opens the system browser, and resolves with all comments (user + agent)
 * when the user submits/closes the page or the server errors.
 * Everything lives in memory; nothing is written to disk.
 */
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename } from "node:path";
import {
	commentsForSha,
	removeCommentAt,
	resolveAnchorState,
	setCommentStatus,
	upsertComment,
	type ReviewComment,
} from "./comments";
import type { CommitEntry } from "./git";
import { parseUnifiedDiff, type DiffLine } from "./parse-unidiff";
import type { WalkthroughStop } from "./walkthrough";

export interface WebReviewOptions {
	cwd: string;
	items: CommitEntry[];
	/** Read-only agent walkthrough notes (author: "agent"). */
	agentComments: ReviewComment[];
	/** Overview summaries (no file anchor) shown as chrome. */
	summaries: WalkthroughStop[];
	/** Session-persisted user comments to seed the session. */
	initialComments: ReviewComment[];
	loadDiffFor: (sha: string | null) => Promise<string>;
	/** Full file content at one side of an item; null when unavailable. */
	loadFileFor?: (sha: string | null, file: string, side: "new" | "old") => Promise<string | null>;
}

type CommentAnchor = Omit<ReviewComment, "id" | "body" | "author">;

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			data += chunk;
			if (data.length > 5 * 1024 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

/** Validate a client-supplied comment anchor. */
function parseAnchor(value: unknown): CommentAnchor | null {
	if (typeof value !== "object" || value === null) return null;
	const a = value as Record<string, unknown>;
	if (a.sha !== null && typeof a.sha !== "string") return null;
	if (typeof a.file !== "string" || a.file.length === 0) return null;
	if (a.side !== "new" && a.side !== "old") return null;
	if (typeof a.line !== "number" || !Number.isInteger(a.line) || a.line < 1) return null;
	const anchor: CommentAnchor = {
		sha: a.sha as string | null,
		file: a.file,
		side: a.side,
		line: a.line,
	};
	if (typeof a.lineText === "string") anchor.lineText = a.lineText;
	if (typeof a.replyTo === "string") anchor.replyTo = a.replyTo;
	if (typeof a.kind === "string") anchor.kind = a.kind;
	return anchor;
}

function openBrowser(url: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	execFile(cmd, args, () => {
		// best effort — the URL is on stdout as a fallback
	});
}

/** Open the web review; resolves with ALL comments (user + agent) when the user closes/submits. */
export function openWebReview(opts: WebReviewOptions): Promise<{ comments: ReviewComment[] }> {
	const items = opts.items;
	const agentComments = opts.agentComments;
	const summaries = opts.summaries;
	let userComments = opts.initialComments.filter((c) => c.author === "user");
	const diffCache = new Map<number, DiffLine[]>();

	return new Promise((resolve) => {
		const sockets = new Set<Socket>();
		let settled = false;
		let listening = false;

		const server = createServer((req, res) => {
			handle(req, res).catch(() => {
				if (!res.headersSent) sendJSON(res, 500, { error: "internal error" });
				else res.end();
			});
		});

		const finish = (): void => {
			if (settled) return;
			settled = true;
			for (const s of sockets) s.destroy();
			const done = (): void => resolve({ comments: [...userComments, ...agentComments] });
			if (listening) server.close(() => done());
			else done();
		};

		async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
			const method = req.method ?? "GET";
			const url = new URL(req.url ?? "/", "http://127.0.0.1");

			if (method === "GET" && url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(PAGE);
				return;
			}

			if (method === "GET" && url.pathname === "/api/session") {
				sendJSON(res, 200, {
					repo: basename(opts.cwd),
					items,
					agentComments,
					summaries,
					userComments,
				});
				return;
			}

			if (method === "GET" && url.pathname === "/api/diff") {
				const i = Number(url.searchParams.get("i"));
				if (!Number.isInteger(i) || i < 0 || i >= items.length) {
					sendJSON(res, 400, { error: "invalid item index" });
					return;
				}
				let lines = diffCache.get(i);
				if (!lines) {
					const raw = await opts.loadDiffFor(items[i]!.sha);
					lines = parseUnifiedDiff(raw);
					diffCache.set(i, lines);
				}
				const states: Record<string, string> = {};
				for (const c of commentsForSha([...userComments, ...agentComments], items[i]!.sha)) {
					states[c.id] = resolveAnchorState(lines, c);
				}
				sendJSON(res, 200, { lines, states });
				return;
			}

			if (method === "GET" && url.pathname === "/api/file") {
				const i = Number(url.searchParams.get("i"));
				const file = url.searchParams.get("file");
				const side = url.searchParams.get("side") ?? "new";
				if (!Number.isInteger(i) || i < 0 || i >= items.length || !file || (side !== "new" && side !== "old")) {
					sendJSON(res, 400, { error: "expected i, file, and side new|old" });
					return;
				}
				if (!opts.loadFileFor) {
					sendJSON(res, 404, { error: "file content unavailable" });
					return;
				}
				const content = await opts.loadFileFor(items[i]!.sha, file, side);
				if (content === null) {
					sendJSON(res, 404, { error: "file not found" });
					return;
				}
				sendJSON(res, 200, { content });
				return;
			}

			if (method === "POST" && url.pathname === "/api/comments") {
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readBody(req));
				} catch {
					sendJSON(res, 400, { error: "invalid JSON body" });
					return;
				}
				const body = parsed as { anchor?: unknown; body?: unknown; status?: unknown };
				const anchor = parseAnchor(body?.anchor);
				const status = body?.status === "open" || body?.status === "resolved" ? body.status : null;
				if (!anchor || (typeof body?.body !== "string" && !status)) {
					sendJSON(res, 400, { error: "expected { anchor, body } or { anchor, status }" });
					return;
				}
				if (status) userComments = setCommentStatus(userComments, anchor, status);
				if (typeof body?.body === "string") userComments = upsertComment(userComments, anchor, body.body);
				sendJSON(res, 200, { userComments });
				return;
			}

			if (method === "POST" && url.pathname === "/api/comments/delete") {
				let parsed: unknown;
				try {
					parsed = JSON.parse(await readBody(req));
				} catch {
					sendJSON(res, 400, { error: "invalid JSON body" });
					return;
				}
				const anchor = parseAnchor((parsed as { anchor?: unknown })?.anchor);
				if (!anchor) {
					sendJSON(res, 400, { error: "expected { anchor }" });
					return;
				}
				userComments = removeCommentAt(userComments, anchor);
				sendJSON(res, 200, { userComments });
				return;
			}

			if (method === "POST" && url.pathname === "/api/close") {
				sendJSON(res, 200, { ok: true });
				finish();
				return;
			}

			sendJSON(res, 404, { error: "not found" });
		}

		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.on("error", finish);
		server.listen(0, "127.0.0.1", () => {
			listening = true;
			const addr = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${addr.port}/`;
			// stderr, not stdout: under MCP stdio (ADR-0004) stdout is the protocol channel.
			console.error(`code-eye web review: ${url}`);
			openBrowser(url);
		});
	});
}

/**
 * The single self-contained review page. No external assets — must work
 * offline. Built with plain string-safe JS (no template literals inside,
 * so the outer backtick literal stays intact).
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Review</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
:root {
	--bg: #0d1117; --bg1: #161b22; --bg2: #21262d;
	--border: #30363d; --border-soft: #21262d;
	--fg: #c9d1d9; --dim: #8b949e; --faint: #6e7681; --bright: #f0f6fc;
	--blue: #58a6ff; --green: #3fb950; --red: #f85149; --amber: #d29922;
	--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
	--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
	--gutters: 140px;
}
body { background: var(--bg); color: var(--fg); font: 14px/1.55 var(--sans); --topbar-h: 50px; -webkit-font-smoothing: antialiased; }
.mono { font-family: var(--mono); }
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg2); border: 3px solid var(--bg); border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background: #3d444d; }
:where(button, textarea, .item, .fhead):focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.fhead:focus-visible { outline-offset: -2px; }
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: rgba(22,27,34,.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.brand { display: flex; gap: 8px; align-items: baseline; font-weight: 600; letter-spacing: .01em; color: var(--bright); }
.brand .sep { color: var(--dim); font-weight: 400; }
.stats { display: flex; gap: 12px; color: var(--dim); font-size: 13px; }
.hint { color: var(--faint); font-size: 12px; }
.actions { margin-left: auto; display: flex; gap: 8px; }
.btn { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.btn:hover { background: #30363d; }
.btn.primary { background: #1f6feb; border-color: #1f6feb; color: #ffffff; }
.btn.primary:hover { background: #388bfd; }
.btn.small { padding: 2px 8px; font-size: 12px; }
.btn.danger { color: var(--red); }
.btn:disabled { opacity: .5; cursor: default; }
.layout { display: flex; align-items: flex-start; }
aside { width: 280px; flex: none; position: sticky; top: var(--topbar-h); max-height: calc(100vh - var(--topbar-h)); overflow-y: auto; border-right: 1px solid var(--border); padding: 12px 8px; }
main { flex: 1; min-width: 0; padding: 20px 24px; }
.item { padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; margin-bottom: 4px; }
.item:hover { background: var(--bg1); }
.item.active { background: var(--bg1); border-color: var(--border); box-shadow: inset 2px 0 0 var(--blue); }
.item-top { display: flex; align-items: center; gap: 8px; }
.sha { font-size: 12px; color: var(--blue); }
.sha.amber { color: var(--amber); }
.badge-count { margin-left: auto; background: var(--bg2); color: var(--fg); border-radius: 10px; padding: 0 8px; font-size: 12px; line-height: 18px; }
.subject { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.item.uncommitted .subject { color: var(--amber); }
.summaries { margin-bottom: 20px; display: flex; flex-direction: column; gap: 10px; }
.summary { background: linear-gradient(180deg, rgba(88,166,255,.06), rgba(88,166,255,.02)), var(--bg1); border: 1px solid var(--border); border-left: 3px solid var(--blue); border-radius: 8px; padding: 12px 14px; }
.summary-title { font-weight: 600; color: var(--bright); margin-bottom: 4px; }
.summary-detail { color: var(--dim); white-space: pre-wrap; }
.file { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 20px; background: var(--bg); box-shadow: 0 1px 2px rgba(1,4,9,.6); }
.fhead { position: sticky; top: var(--topbar-h); z-index: 10; display: flex; align-items: center; gap: 8px; background: var(--bg1); padding: 9px 12px; border-bottom: 1px solid var(--border); border-radius: 8px 8px 0 0; cursor: pointer; user-select: none; }
.fhead:hover { background: #1c2129; }
.fchev { color: var(--dim); font-size: 11px; width: 14px; text-align: center; flex: none; }
.file.collapsed .fbody { display: none; }
.file.collapsed .fhead { border-bottom-color: transparent; border-radius: 8px; }
.file.collapsed .fchev { transform: rotate(-90deg); }
.ficon { font-size: 13px; }
.fpath { color: var(--bright); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fstats { margin-left: auto; display: flex; gap: 8px; font-size: 12px; flex: none; }
.fadd { color: var(--green); }
.fdel { color: var(--red); }
.fchip { font-size: 11px; border-radius: 10px; padding: 1px 8px; border: 1px solid; flex: none; }
.fchip.added { color: var(--green); border-color: rgba(63,185,80,.4); background: rgba(63,185,80,.1); }
.fchip.deleted { color: var(--red); border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.1); }
.fchip.renamed { color: var(--blue); border-color: rgba(56,139,253,.4); background: rgba(56,139,253,.1); }
.fbody { overflow-x: auto; border-radius: 0 0 8px 8px; padding: 4px 0; }
.drow { display: grid; grid-template-columns: 24px 48px 48px 20px 1fr; width: max-content; min-width: 100%; }
.gutter { position: relative; }
.gbtn { display: none; position: absolute; left: 2px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; line-height: 1; padding: 0; background: #1f6feb; color: #ffffff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
.drow:hover .gbtn, .gbtn:focus-visible { display: block; }
.ln { text-align: right; padding: 0 8px; color: var(--faint); font-size: 12px; line-height: 20px; user-select: none; }
.drow:hover .ln { color: var(--dim); }
.sign { text-align: center; color: var(--dim); line-height: 20px; user-select: none; }
.code { white-space: pre; padding-right: 16px; font-size: 12.5px; line-height: 20px; tab-size: 4; }
.drow.context:hover { background: rgba(139,148,158,.06); }
.drow.add { background: rgba(63,185,80,.12); }
.drow.add .sign { color: var(--green); }
.drow.del { background: rgba(248,81,73,.12); }
.drow.del .sign { color: var(--red); }
.hunk { color: var(--blue); background: rgba(56,139,253,.1); padding: 4px 12px; font-size: 12px; width: max-content; min-width: 100%; border-top: 1px solid var(--border-soft); }
.expander { display: flex; align-items: center; gap: 10px; padding: 4px 12px; background: var(--bg1); border-top: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft); width: max-content; min-width: 100%; }
.exp-btn { background: none; border: none; color: var(--blue); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 4px; }
.exp-btn:hover { background: rgba(56,139,253,.12); }
.exp-label { color: var(--faint); font-size: 12px; }
.crow { padding: 8px 12px 8px var(--gutters); display: flex; flex-direction: column; gap: 8px; width: max-content; min-width: 100%; }
.card { background: var(--bg1); border: 1px solid var(--border); border-left: 3px solid var(--blue); border-radius: 8px; padding: 10px 14px; max-width: 760px; box-shadow: 0 1px 2px rgba(1,4,9,.5); }
.card.agent { border-left-color: var(--amber); }
.card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.badge { font-size: 12px; border-radius: 10px; padding: 1px 8px; }
.b-user { background: rgba(56,139,253,.15); color: var(--blue); border: 1px solid rgba(56,139,253,.4); }
.b-agent { background: rgba(210,153,34,.15); color: var(--amber); border: 1px solid rgba(210,153,34,.4); }
.chip { font-size: 11px; color: var(--dim); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; letter-spacing: .02em; }
.card-title { font-weight: 600; color: var(--bright); margin-bottom: 4px; }
.card-body { white-space: pre-wrap; }
.card-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.card.flash { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(88,166,255,.35); }
.sev { font-size: 11px; border-radius: 10px; padding: 1px 8px; border: 1px solid; }
.sev-high { color: var(--red); border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.1); }
.sev-medium { color: var(--amber); border-color: rgba(210,153,34,.4); background: rgba(210,153,34,.1); }
.sev-low { color: var(--blue); border-color: rgba(56,139,253,.4); background: rgba(56,139,253,.1); }
.b-state { background: rgba(210,153,34,.15); color: var(--amber); border: 1px solid rgba(210,153,34,.4); }
.b-resolved { background: rgba(63,185,80,.15); color: var(--green); border: 1px solid rgba(63,185,80,.4); }
.card.resolved { opacity: .55; }
.card.resolved .card-body { display: none; }
.card.stale { opacity: .6; border-left-color: var(--faint); }
.card.reply { margin-left: 24px; padding: 6px 10px; font-size: 13px; max-width: 716px; box-shadow: none; }
.sugg { margin: 8px 0 0; padding: 8px 10px; background: #010409; border: 1px solid var(--border); border-radius: 6px; font-family: var(--mono); font-size: 12px; line-height: 18px; white-space: pre; overflow-x: auto; }
.adopted { color: var(--green); font-size: 12px; }
.sevfilter { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; font-size: 12px; }
.editor-row { padding: 8px 12px 8px var(--gutters); width: max-content; min-width: 100%; }
.editor-row textarea { width: 100%; max-width: 760px; min-width: min(760px, 60vw); min-height: 80px; background: #010409; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; resize: vertical; }
.editor-row textarea:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(88,166,255,.3); }
.editor-actions { display: flex; gap: 8px; justify-content: flex-end; max-width: 760px; margin-top: 8px; }
.placeholder { color: var(--dim); padding: 48px; text-align: center; }
.done { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.done-title { font-size: 20px; font-weight: 600; color: var(--bright); }
.done-sub { color: var(--dim); }
.tok-c { color: #8b949e; }
.tok-s { color: #a5d6ff; }
.tok-k { color: #ff7b72; }
.tok-n { color: #79c0ff; }
.tok-t { color: #ffa657; }
.tok-f { color: #d2a8ff; }
.tok-p { color: #79c0ff; }
.tok-v { color: #ffa657; }
.tok-e { color: #7ee787; }
.tok-b { font-weight: 600; }
.tok-h { color: #79c0ff; font-weight: 600; }
.tok-l { color: #58a6ff; }
@media (prefers-reduced-motion: no-preference) {
	.btn, .item, .exp-btn, .card { transition: background-color .12s ease, border-color .12s ease, box-shadow .12s ease; }
	.fhead { transition: background-color .12s ease; }
	.fchev { transition: transform .15s ease; }
	.card.flash { animation: flashfade 1.5s ease-out; }
}
@keyframes flashfade { 0% { box-shadow: 0 0 0 5px rgba(88,166,255,.55); } 100% { box-shadow: 0 0 0 3px rgba(88,166,255,.35); } }
</style>
</head>
<body>
<header class="topbar">
	<div class="brand"><span id="repo" class="mono"></span><span class="sep">/</span><span>Code Review</span></div>
	<div class="stats"><span id="icount"></span><span id="ucount"></span><select id="sevfilter" class="sevfilter" title="Filter agent notes by severity"><option value="all">All risks</option><option value="med">High+Medium</option><option value="high">High only</option></select><span class="hint">n/p agent &middot; [/] mine</span></div>
	<div class="actions"><button id="collapseall" class="btn">Collapse all</button><button id="closebtn" class="btn">Close</button><button id="submit" class="btn primary">Submit review</button></div>
</header>
<div class="layout">
	<aside>
		<div id="items"></div>
	</aside>
	<main id="main"></main>
</div>
<script>
(function () {
"use strict";
var session = null;
var cur = 0;
var lines = [];
var cache = {};
var openEditorEl = null;
var navPtr = { agent: -1, user: -1 };
// Expansion state survives refresh(): per item|file|gap index -> revealed line counts.
var gapState = {};
// Collapse state per item|file -> true when the file body is folded away.
var collapsedState = {};
// New-side file content per item|file -> array of lines (null = unavailable).
var fileCache = {};
var filePending = {};
// Anchor state per comment id ("ok" | "changed" | "missing"), from /api/diff.
var noteStates = {};
// Severity filter for agent notes: "all" | "med" | "high".
var severityFilter = "all";

var HUNK_RE = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/;

// ---------- lightweight syntax highlighting (no dependencies) ----------
var EXT_LANG = {
	js: "js", mjs: "js", cjs: "js", jsx: "js",
	ts: "js", mts: "js", cts: "js", tsx: "js",
	rs: "rust", go: "go", py: "python",
	json: "json", css: "css",
	html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
	sh: "shell", bash: "shell", zsh: "shell",
	md: "md", markdown: "md",
	yml: "yaml", yaml: "yaml",
	toml: "yaml", ini: "yaml"
};

function langForPath(p) {
	var m = (p || "").match(/\.([A-Za-z0-9]+)$/);
	if (!m) return null;
	return EXT_LANG[m[1].toLowerCase()] || null;
}

function wordSet(s) {
	var o = {};
	s.split(" ").forEach(function (w) { o[w] = true; });
	return o;
}

var KW = {
	js: wordSet("const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this null undefined true false import from export async await try catch finally throw yield static get set void interface type enum implements public private protected readonly abstract declare namespace keyof infer as is"),
	rust: wordSet("fn let mut pub struct enum impl trait for in while loop if else match return use mod crate self Self super where async await move ref static const type unsafe extern dyn as break continue true false"),
	go: wordSet("func var const type struct interface map chan go defer return if else for range switch case default break continue package import select fallthrough goto nil true false iota"),
	python: wordSet("def class return if elif else for while import from as pass break continue with lambda try except finally raise global nonlocal yield async await assert del in is not and or None True False"),
	shell: wordSet("if then else elif fi for while do done case esac function in select until local export return exit source eval set unset shift readonly true false"),
	yaml: wordSet("true false null yes no on off"),
	json: wordSet("true false null")
};

// lc: line comment, bc: block comment pair, strs: quote chars,
// ml: quote char allowed to run past EOL, keyColon: "ident:" is a property,
// dollar: $vars, deco: @decorators, triple: python triple-quoted strings.
var SPECS = {
	js: { lc: "//", bc: ["/*", "*/"], strs: ["\\"", "'", "\x60"], ml: "\x60", kw: KW.js },
	rust: { lc: "//", bc: ["/*", "*/"], strs: ["\\"", "'"], ml: "", kw: KW.rust },
	go: { lc: "//", bc: ["/*", "*/"], strs: ["\\"", "'", "\x60"], ml: "\x60", kw: KW.go },
	python: { lc: "#", bc: null, strs: ["\\"", "'"], ml: "", kw: KW.python, triple: true, deco: true },
	shell: { lc: "#", bc: null, strs: ["\\"", "'"], ml: "", kw: KW.shell, dollar: true },
	yaml: { lc: "#", bc: null, strs: ["\\"", "'"], ml: "", kw: KW.yaml, keyColon: true },
	json: { lc: null, bc: null, strs: ["\\""], ml: "", kw: KW.json, keyColon: true }
};

function escHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeEmitter() {
	var out = "";
	return {
		emit: function (cls, txt) {
			if (!txt) return;
			out += cls ? '<span class="' + cls + '">' + escHtml(txt) + "</span>" : escHtml(txt);
		},
		html: function () { return out; },
	};
}

var RE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;
var RE_NUM = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/;

// Generic scanner for C-like / scripting languages. st = { block, str } and
// carries unterminated block comments / multiline strings across lines.
function scanCode(line, spec, st) {
	var e = makeEmitter();
	var i = 0;
	var n = line.length;
	while (i < n) {
		if (st.block) {
			var be = line.indexOf(st.block, i);
			if (be === -1) { e.emit("tok-c", line.slice(i)); i = n; }
			else { e.emit("tok-c", line.slice(i, be + st.block.length)); i = be + st.block.length; st.block = null; }
			continue;
		}
		if (st.str) {
			var j = i;
			var end = -1;
			while (j < n) {
				if (line.charAt(j) === "\\\\") { j += 2; continue; }
				if (line.substr(j, st.str.length) === st.str) { end = j; break; }
				j++;
			}
			if (end === -1) { e.emit("tok-s", line.slice(i)); i = n; }
			else { e.emit("tok-s", line.slice(i, end + st.str.length)); i = end + st.str.length; st.str = null; }
			continue;
		}
		var ch = line.charAt(i);
		if (spec.lc && line.substr(i, spec.lc.length) === spec.lc) {
			e.emit("tok-c", line.slice(i));
			break;
		}
		if (spec.bc && line.substr(i, 2) === spec.bc[0]) {
			var ce = line.indexOf(spec.bc[1], i + 2);
			if (ce === -1) { e.emit("tok-c", line.slice(i)); st.block = spec.bc[1]; i = n; }
			else { e.emit("tok-c", line.slice(i, ce + 2)); i = ce + 2; }
			continue;
		}
		if (spec.triple) {
			var t3 = line.substr(i, 3);
			if (t3 === '"""' || t3 === "'''") {
				var te = line.indexOf(t3, i + 3);
				if (te === -1) { e.emit("tok-s", line.slice(i)); st.str = t3; i = n; }
				else { e.emit("tok-s", line.slice(i, te + 3)); i = te + 3; }
				continue;
			}
		}
		if (spec.strs.indexOf(ch) !== -1) {
			var k = i + 1;
			var closed = -1;
			while (k < n) {
				if (line.charAt(k) === "\\\\") { k += 2; continue; }
				if (line.charAt(k) === ch) { closed = k; break; }
				k++;
			}
			if (closed === -1) {
				e.emit("tok-s", line.slice(i));
				if (spec.ml && ch === spec.ml) st.str = ch;
				i = n;
			} else {
				var p2 = closed + 1;
				while (p2 < n && (line.charAt(p2) === " " || line.charAt(p2) === "\\t")) p2++;
				if (spec.keyColon && line.charAt(p2) === ":") e.emit("tok-p", line.slice(i, closed + 1));
				else e.emit("tok-s", line.slice(i, closed + 1));
				i = closed + 1;
			}
			continue;
		}
		if (spec.dollar && ch === "$") {
			var dm = line.slice(i).match(/^\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{[^}]*\\}|[0-9@#?$!*-])/);
			if (dm) { e.emit("tok-v", dm[0]); i += dm[0].length; continue; }
		}
		if (spec.deco && ch === "@") {
			var am = line.slice(i).match(/^@[A-Za-z_][A-Za-z0-9_.]*/);
			if (am) { e.emit("tok-t", am[0]); i += am[0].length; continue; }
		}
		if (/[0-9]/.test(ch)) {
			var nm = line.slice(i).match(RE_NUM);
			e.emit("tok-n", nm[0]);
			i += nm[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			var w = line.slice(i).match(RE_IDENT)[0];
			var p = i + w.length;
			while (p < n && (line.charAt(p) === " " || line.charAt(p) === "\\t")) p++;
			if (spec.kw[w]) e.emit("tok-k", w);
			else if (spec.keyColon && line.charAt(p) === ":") e.emit("tok-p", w);
			else if (line.charAt(p) === "(") e.emit("tok-f", w);
			else if (/^[A-Z]/.test(w)) e.emit("tok-t", w);
			else e.emit(null, w);
			i += w.length;
			continue;
		}
		e.emit(null, ch);
		i++;
	}
	return e.html();
}

// HTML/XML: st = { block (<!-- -->), tag, str }.
function scanMarkup(line, st) {
	var e = makeEmitter();
	var i = 0;
	var n = line.length;
	while (i < n) {
		if (st.block) {
			var ce = line.indexOf("-->", i);
			if (ce === -1) { e.emit("tok-c", line.slice(i)); i = n; }
			else { e.emit("tok-c", line.slice(i, ce + 3)); i = ce + 3; st.block = null; }
			continue;
		}
		if (st.tag) {
			if (st.str) {
				var se = line.indexOf(st.str, i);
				if (se === -1) { e.emit("tok-s", line.slice(i)); i = n; }
				else { e.emit("tok-s", line.slice(i, se + 1)); i = se + 1; st.str = null; }
				continue;
			}
			var ch2 = line.charAt(i);
			if (ch2 === ">") { e.emit(null, ">"); st.tag = false; i++; continue; }
			if (ch2 === "\\"" || ch2 === "'") { st.str = ch2; e.emit("tok-s", ch2); i++; continue; }
			var am = line.slice(i).match(/^[A-Za-z_:][-A-Za-z0-9_:.]*/);
			if (am) { e.emit("tok-p", am[0]); i += am[0].length; continue; }
			e.emit(null, ch2);
			i++;
			continue;
		}
		if (line.substr(i, 4) === "<!--") {
			var xe = line.indexOf("-->", i + 4);
			if (xe === -1) { e.emit("tok-c", line.slice(i)); st.block = true; i = n; }
			else { e.emit("tok-c", line.slice(i, xe + 3)); i = xe + 3; }
			continue;
		}
		if (line.charAt(i) === "<") {
			var tm = line.slice(i).match(/^<\\/?[A-Za-z][A-Za-z0-9-]*/);
			if (tm) { e.emit("tok-e", tm[0]); i += tm[0].length; st.tag = true; continue; }
			e.emit(null, "<");
			i++;
			continue;
		}
		var lt = line.indexOf("<", i);
		if (lt === -1) { e.emit(null, line.slice(i)); i = n; }
		else { e.emit(null, line.slice(i, lt)); i = lt; }
	}
	return e.html();
}

// CSS: st = { block }.
function scanCss(line, st) {
	var e = makeEmitter();
	var i = 0;
	var n = line.length;
	while (i < n) {
		if (st.block) {
			var be = line.indexOf("*/", i);
			if (be === -1) { e.emit("tok-c", line.slice(i)); i = n; }
			else { e.emit("tok-c", line.slice(i, be + 2)); i = be + 2; st.block = null; }
			continue;
		}
		var ch = line.charAt(i);
		if (line.substr(i, 2) === "/*") {
			var ce = line.indexOf("*/", i + 2);
			if (ce === -1) { e.emit("tok-c", line.slice(i)); st.block = "*/"; i = n; }
			else { e.emit("tok-c", line.slice(i, ce + 2)); i = ce + 2; }
			continue;
		}
		if (ch === "\\"" || ch === "'") {
			var se = line.indexOf(ch, i + 1);
			if (se === -1) { e.emit("tok-s", line.slice(i)); i = n; }
			else { e.emit("tok-s", line.slice(i, se + 1)); i = se + 1; }
			continue;
		}
		if (ch === "@") {
			var am = line.slice(i).match(/^@[A-Za-z-]+/);
			if (am) { e.emit("tok-k", am[0]); i += am[0].length; continue; }
		}
		if (ch === "#") {
			var hm = line.slice(i).match(/^#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/);
			if (hm) { e.emit("tok-n", hm[0]); i += hm[0].length; continue; }
		}
		if (/[0-9]/.test(ch)) {
			var nm = line.slice(i).match(/^[0-9][0-9.]*(?:[a-z%]+)?/);
			e.emit("tok-n", nm[0]);
			i += nm[0].length;
			continue;
		}
		if (/[A-Za-z_-]/.test(ch)) {
			var w = line.slice(i).match(/^-?[A-Za-z_][-A-Za-z0-9_]*/);
			if (!w) { e.emit(null, ch); i++; continue; }
			var p = i + w[0].length;
			while (p < n && (line.charAt(p) === " " || line.charAt(p) === "\\t")) p++;
			if (line.charAt(p) === ":" && line.charAt(p + 1) !== ":") e.emit("tok-p", w[0]);
			else if (line.charAt(p) === "(") e.emit("tok-f", w[0]);
			else e.emit(null, w[0]);
			i += w[0].length;
			continue;
		}
		e.emit(null, ch);
		i++;
	}
	return e.html();
}

// Markdown: single-line, regex passes over the escaped text.
function scanMd(line) {
	if (/^\\s{0,3}#{1,6}\\s/.test(line)) return '<span class="tok-h">' + escHtml(line) + "</span>";
	var out = escHtml(line);
	out = out.replace(/\x60[^\x60]+\x60/g, '<span class="tok-s">$&</span>');
	out = out.replace(/\\*\\*[^*]+\\*\\*/g, '<span class="tok-b">$&</span>');
	out = out.replace(/\\[([^\\]]*)\\]\\(([^)]*)\\)/g, '<span class="tok-l">[$1]</span><span class="tok-c">($2)</span>');
	out = out.replace(/^(\\s*(?:[-*+]|\\d+\\.)\\s)/, '<span class="tok-k">$1</span>');
	return out;
}

function highlightLine(text, lang, st) {
	if (!text) return "";
	if (lang === "markup") return scanMarkup(text, st);
	if (lang === "css") return scanCss(text, st);
	if (lang === "md") return scanMd(text);
	return scanCode(text, SPECS[lang], st);
}

function el(tag, cls, text) {
	var e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined && text !== null) e.textContent = text;
	return e;
}

function shaEq(a, b) {
	return (a == null ? null : a) === (b == null ? null : b);
}

function api(path, opts) {
	return fetch(path, opts).then(function (r) {
		if (!r.ok) throw new Error("request failed: " + r.status);
		return r.json();
	});
}

function postJSON(path, obj) {
	return api(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(obj),
	});
}

function currentItem() {
	return session.items[cur];
}

function plural(n, word) {
	return n + " " + word + (n === 1 ? "" : "s");
}

function userCountFor(sha) {
	return session.userComments.filter(function (c) { return shaEq(c.sha, sha); }).length;
}

function renderTop() {
	document.getElementById("repo").textContent = session.repo || "repo";
	document.getElementById("icount").textContent = plural(session.items.length, "item");
	document.getElementById("ucount").textContent = plural(session.userComments.length, "comment");
	document.getElementById("sevfilter").value = severityFilter;
}

function sevRank(c) {
	return c.severity === "high" ? 3 : c.severity === "medium" ? 2 : c.severity === "low" ? 1 : 0;
}

function sevMinRank() {
	return severityFilter === "high" ? 3 : severityFilter === "med" ? 2 : 0;
}

function renderSidebar() {
	var list = document.getElementById("items");
	list.textContent = "";
	session.items.forEach(function (it, i) {
		var row = el("div", "item" + (i === cur ? " active" : "") + (it.sha === null ? " uncommitted" : ""));
		var top = el("div", "item-top");
		if (it.sha === null) top.appendChild(el("span", "sha amber mono", "working"));
		else top.appendChild(el("span", "sha mono", it.label));
		var n = userCountFor(it.sha);
		if (n > 0) top.appendChild(el("span", "badge-count", String(n)));
		row.appendChild(top);
		row.appendChild(el("div", "subject", it.subject || (it.sha === null ? "Uncommitted changes" : "(no subject)")));
		row.addEventListener("click", function () { selectItem(i); });
		list.appendChild(row);
	});
}

function selectItem(i) {
	cur = i;
	try { window.location.hash = "i=" + i; } catch (e) {}
	renderTop();
	renderSidebar();
	return loadDiff(i).then(function () { renderDiff(false); });
}

function loadDiff(i) {
	var main = document.getElementById("main");
	if (cache[i]) {
		lines = cache[i];
		return Promise.resolve();
	}
	main.textContent = "";
	main.appendChild(el("div", "placeholder", "Loading diff…"));
	return api("/api/diff?i=" + i).then(function (d) {
		cache[i] = d.lines;
		lines = d.lines;
		if (d.states) for (var k in d.states) noteStates[k] = d.states[k];
	});
}

function commentMatches(c, line, sha) {
	if (!shaEq(c.sha, sha)) return false;
	if (c.file !== line.file) return false;
	if (c.side === "old") {
		return line.oldLine === c.line && (line.kind === "del" || line.kind === "context");
	}
	return line.newLine === c.line && (line.kind === "add" || line.kind === "context");
}

function commentsOn(line, sha) {
	var out = [];
	var minRank = sevMinRank();
	// Replies render nested inside their agent note's card, never standalone.
	session.userComments.forEach(function (c) { if (!c.replyTo && commentMatches(c, line, sha)) out.push(c); });
	session.agentComments.forEach(function (c) { if (sevRank(c) >= minRank && commentMatches(c, line, sha)) out.push(c); });
	return out;
}

function renderDiff(keepScroll) {
	var main = document.getElementById("main");
	var scroll = keepScroll ? window.scrollY : 0;
	main.textContent = "";

	if (session.summaries && session.summaries.length) {
		var banner = el("div", "summaries");
		session.summaries.forEach(function (s) {
			var card = el("div", "summary");
			card.appendChild(el("div", "summary-title", s.title));
			if (s.detail) card.appendChild(el("div", "summary-detail", s.detail));
			banner.appendChild(card);
		});
		main.appendChild(banner);
	}

	var it = currentItem();
	var fl = null;
	var sections = 0;
	for (var idx = 0; idx < lines.length; idx++) {
		var l = lines[idx];
		if (l.kind === "file") {
			if (fl) { main.appendChild(buildFileSection(fl, it)); sections++; }
			fl = [l];
		} else if (fl) {
			fl.push(l);
		}
	}
	if (fl) { main.appendChild(buildFileSection(fl, it)); sections++; }
	if (!sections) main.appendChild(el("div", "placeholder", "No changes in this item."));
	updateCollapseAllBtn();
	window.scrollTo(0, scroll);
}

function parseHunk(l) {
	var m = l.text.match(HUNK_RE);
	var startOld = m ? Number(m[1]) : 0;
	var countOld = m && m[2] !== undefined ? Number(m[2]) : 1;
	var startNew = m ? Number(m[3]) : 0;
	var countNew = m && m[4] !== undefined ? Number(m[4]) : 1;
	// For a 0-count range, "start" is the line the range sits after, so
	// start + max(count,1) - 1 gives the last covered line in both cases.
	return {
		header: l.text,
		startNew: startNew,
		endOld: startOld + Math.max(countOld, 1) - 1,
		endNew: startNew + Math.max(countNew, 1) - 1,
		lines: [],
	};
}

function fileHeader(name, fl, collapsed) {
	var adds = 0;
	var dels = 0;
	var status = null;
	fl.forEach(function (l) {
		if (l.kind === "add") adds++;
		else if (l.kind === "del") dels++;
		else if (l.kind === "meta") {
			if (l.text.indexOf("new file mode") === 0) status = "added";
			else if (l.text.indexOf("deleted file mode") === 0) status = "deleted";
			else if (l.text.indexOf("rename from") === 0) status = "renamed";
		}
	});
	var h = el("div", "fhead");
	h.tabIndex = 0;
	h.setAttribute("role", "button");
	h.setAttribute("aria-expanded", collapsed ? "false" : "true");
	h.title = "Toggle this file's diff";
	h.appendChild(el("span", "fchev", "▾"));
	h.appendChild(el("span", "ficon", "📄"));
	h.appendChild(el("span", "fpath mono", name));
	if (status) h.appendChild(el("span", "fchip " + status, status));
	var stats = el("span", "fstats mono");
	if (adds) stats.appendChild(el("span", "fadd", "+" + adds));
	if (dels) stats.appendChild(el("span", "fdel", "−" + dels));
	h.appendChild(stats);
	return h;
}

// Toggle one file's collapse state. Only flips a class on the live DOM —
// no re-render — so an open comment editor inside the file keeps its text.
function toggleFile(sec, head, key) {
	var collapsed = !collapsedState[key];
	collapsedState[key] = collapsed;
	sec.classList.toggle("collapsed", collapsed);
	head.setAttribute("aria-expanded", collapsed ? "false" : "true");
	updateCollapseAllBtn();
}

function currentFiles() {
	var files = [];
	lines.forEach(function (l) { if (l.kind === "file") files.push(l.file || l.text); });
	return files;
}

function updateCollapseAllBtn() {
	var btn = document.getElementById("collapseall");
	if (!btn || !session) return;
	var files = currentFiles();
	var anyExpanded = files.some(function (f) { return !collapsedState[cur + "|" + f]; });
	btn.textContent = anyExpanded ? "Collapse all" : "Expand all";
	btn.disabled = files.length === 0;
}

function toggleAllFiles() {
	var files = currentFiles();
	if (!files.length) return;
	var anyExpanded = files.some(function (f) { return !collapsedState[cur + "|" + f]; });
	files.forEach(function (f) { collapsedState[cur + "|" + f] = anyExpanded; });
	// Apply in place (no re-render) to preserve any open editor.
	var secs = document.getElementById("main").querySelectorAll(".file");
	for (var i = 0; i < secs.length && i < files.length; i++) {
		secs[i].classList.toggle("collapsed", anyExpanded);
		var head = secs[i].querySelector(".fhead");
		if (head) head.setAttribute("aria-expanded", anyExpanded ? "false" : "true");
	}
	updateCollapseAllBtn();
}

function ensureFileContent(file) {
	var k = cur + "|" + file;
	if (fileCache[k] !== undefined) return Promise.resolve(fileCache[k]);
	if (filePending[k]) return filePending[k];
	filePending[k] = api("/api/file?i=" + cur + "&file=" + encodeURIComponent(file) + "&side=new")
		.then(function (d) {
			var arr = d.content.split("\\n");
			if (arr.length && arr[arr.length - 1] === "") arr.pop();
			fileCache[k] = arr;
			delete filePending[k];
			return arr;
		})
		.catch(function () {
			fileCache[k] = null;
			delete filePending[k];
			return null;
		});
	return filePending[k];
}

function expandGap(file, gap, key, dir) {
	var st = gapState[key];
	ensureFileContent(file).then(function (content) {
		if (!content) {
			st.hidden = true;
			renderDiff(true);
			return;
		}
		if (!gap.known) {
			// Trailing gap: everything after the last hunk up to EOF.
			var count = content.length - (gap.newStart - 1);
			if (count <= 0) {
				st.hidden = true;
				renderDiff(true);
				return;
			}
			st.count = count;
			gap.count = count;
			gap.known = true;
		}
		var total = st.count !== undefined ? st.count : gap.count;
		var remaining = total - st.top - st.bottom;
		var n = Math.min(20, remaining);
		if (dir === "down") st.top += n;
		else st.bottom += n;
		renderDiff(true);
	});
}

// Render one gap's revealed rows (top and bottom) plus its expander row.
function renderGap(fbody, file, gapIdx, gap, it, renderRow) {
	var key = cur + "|" + file + "|" + gapIdx;
	var st = gapState[key] || (gapState[key] = { top: 0, bottom: 0, hidden: false });
	if (st.hidden) return;
	if (!gap.known && st.count !== undefined) {
		gap.known = true;
		gap.count = st.count;
		gap.dir = "both";
	}
	if (gap.known && gap.count <= 0) return;
	var content = fileCache[cur + "|" + file] || null;

	var k;
	if (content) {
		for (k = 0; k < st.top && k < gap.count; k++) {
			renderRow({ kind: "context", text: content[gap.newStart + k - 1] || "", file: file, oldLine: gap.oldStart + k, newLine: gap.newStart + k });
		}
	}
	var remaining = gap.known ? gap.count - st.top - st.bottom : -1;
	if (!gap.known || remaining > 0) {
		var er = el("div", "expander");
		if (gap.dir === "both") {
			var up = el("button", "exp-btn", "↑ Expand up");
			up.addEventListener("click", function () { expandGap(file, gap, key, "up"); });
			er.appendChild(up);
		}
		var down = el("button", "exp-btn", "↓ Expand down");
		down.addEventListener("click", function () { expandGap(file, gap, key, "down"); });
		er.appendChild(down);
		if (gap.known) er.appendChild(el("span", "exp-label", plural(remaining, "hidden line")));
		fbody.appendChild(er);
	}
	if (content) {
		for (k = Math.max(st.top, gap.count - st.bottom); k < gap.count; k++) {
			renderRow({ kind: "context", text: content[gap.newStart + k - 1] || "", file: file, oldLine: gap.oldStart + k, newLine: gap.newStart + k });
		}
	}
}

function buildFileSection(fl, it) {
	var name = fl[0].file || fl[0].text;
	var lang = langForPath(name);
	// Cross-line token state (block comments, multiline strings): rows are
	// appended in file order, so a single state object replays consistently
	// on every re-render.
	var hlState = { block: null, str: null, tag: false };
	var ckey = cur + "|" + name;
	var sec = el("div", "file" + (collapsedState[ckey] ? " collapsed" : ""));
	var head = fileHeader(name, fl, !!collapsedState[ckey]);
	sec.appendChild(head);
	head.addEventListener("click", function () { toggleFile(sec, head, ckey); });
	head.addEventListener("keydown", function (ev) {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			toggleFile(sec, head, ckey);
		}
	});
	var fbody = el("div", "fbody");
	sec.appendChild(fbody);

	var hunks = [];
	var h = null;
	fl.forEach(function (l) {
		if (l.kind === "hunk") {
			h = parseHunk(l);
			hunks.push(h);
		} else if (h && (l.kind === "add" || l.kind === "del" || l.kind === "context")) {
			h.lines.push(l);
		}
	});

	function renderRow(l) {
		fbody.appendChild(diffRow(l, it, lang, hlState));
		var cs = commentsOn(l, it.sha);
		if (cs.length) {
			var crow = el("div", "crow");
			cs.forEach(function (c) { crow.appendChild(commentCard(c)); });
			fbody.appendChild(crow);
		}
	}

	if (!hunks.length) {
		fbody.appendChild(el("div", "placeholder", "No hunks in this file."));
		return sec;
	}

	var gapIdx = 0;
	if (hunks[0].startNew > 1) {
		renderGap(fbody, name, gapIdx++, { oldStart: 1, newStart: 1, count: hunks[0].startNew - 1, known: true, dir: "down" }, it, renderRow);
	}
	hunks.forEach(function (hk, hi) {
		fbody.appendChild(el("div", "hunk mono", hk.header));
		hk.lines.forEach(renderRow);
		var next = hunks[hi + 1];
		if (next) {
			var count = next.startNew - hk.endNew - 1;
			if (count > 0) {
				renderGap(fbody, name, gapIdx++, { oldStart: hk.endOld + 1, newStart: hk.endNew + 1, count: count, known: true, dir: "both" }, it, renderRow);
			}
		} else {
			// Trailing gap: count unknown until the file content is fetched.
			renderGap(fbody, name, gapIdx++, { oldStart: hk.endOld + 1, newStart: hk.endNew + 1, count: 0, known: false, dir: "down" }, it, renderRow);
		}
	});
	return sec;
}

function diffRow(l, it, lang, hlState) {
	var row = el("div", "drow " + l.kind);
	row._line = l;
	row._item = it;
	var gutter = el("div", "gutter");
	var btn = el("button", "gbtn", "+");
	btn.title = "Add a comment";
	btn.addEventListener("click", function () { openEditor(row, null); });
	gutter.appendChild(btn);
	row.appendChild(gutter);
	row.appendChild(el("div", "ln mono", l.oldLine == null ? "" : String(l.oldLine)));
	row.appendChild(el("div", "ln mono", l.newLine == null ? "" : String(l.newLine)));
	row.appendChild(el("div", "sign mono", l.kind === "add" ? "+" : (l.kind === "del" ? "-" : "")));
	var codeEl = el("div", "code mono");
	if (lang && l.text) codeEl.innerHTML = highlightLine(l.text, lang, hlState);
	else codeEl.textContent = l.text;
	row.appendChild(codeEl);
	return row;
}

function anchorOf(c) {
	var a = { sha: c.sha, file: c.file, side: c.side, line: c.line };
	if (c.replyTo) a.replyTo = c.replyTo;
	return a;
}

function rowBefore(node) {
	var crow = node.parentNode;
	var rowEl = crow && crow.previousElementSibling;
	return rowEl && rowEl._line ? rowEl : null;
}

function replyCard(r) {
	var rc = el("div", "card reply user");
	rc.id = "user-" + r.id;
	rc.appendChild(el("div", "card-body", r.body));
	var acts = el("div", "card-actions");
	var editBtn = el("button", "btn small", "Edit");
	editBtn.addEventListener("click", function () {
		var rowEl = rowBefore(rc.parentNode);
		if (rowEl) openEditor(rowEl, r, { replyTo: r.replyTo, kind: r.kind, placeholder: "Ask the agent about this note…" });
	});
	var delBtn = el("button", "btn small danger", "Delete");
	delBtn.addEventListener("click", function () {
		delBtn.disabled = true;
		postJSON("/api/comments/delete", {
			anchor: { sha: r.sha, file: r.file, side: r.side, line: r.line, replyTo: r.replyTo },
		}).then(function (d) {
			session.userComments = d.userComments;
			refresh();
		}).catch(function () { delBtn.disabled = false; });
	});
	acts.appendChild(editBtn);
	acts.appendChild(delBtn);
	rc.appendChild(acts);
	return rc;
}

function commentCard(c) {
	var isAgent = c.author === "agent";
	var state = noteStates[c.id];
	var cls = "card " + (isAgent ? "agent" : "user");
	if (!isAgent && c.status === "resolved") cls += " resolved";
	if (isAgent && state === "missing") cls += " stale";
	var card = el("div", cls);
	card.id = (isAgent ? "agent-" : "user-") + c.id;
	var head = el("div", "card-head");
	head.appendChild(el("span", "badge " + (isAgent ? "b-agent" : "b-user"), isAgent ? "🤖 agent" : "you"));
	if (c.kind) head.appendChild(el("span", "chip", c.kind));
	if (c.severity) head.appendChild(el("span", "sev sev-" + c.severity, c.severity));
	if (!isAgent && c.status === "resolved") head.appendChild(el("span", "badge b-resolved", "resolved"));
	if (state === "changed") head.appendChild(el("span", "badge b-state", "line changed"));
	else if (state === "missing") head.appendChild(el("span", "badge b-state", isAgent ? "code changed" : "anchor lost"));
	card.appendChild(head);
	if (c.title) card.appendChild(el("div", "card-title", c.title));
	card.appendChild(el("div", "card-body", c.body));
	if (isAgent) {
		if (c.suggestion) card.appendChild(el("pre", "sugg", c.suggestion));
		session.userComments.forEach(function (u) {
			if (u.replyTo === c.id && u.kind !== "adopt") card.appendChild(replyCard(u));
		});
		var acts = el("div", "card-actions");
		var askBtn = el("button", "btn small", "Ask");
		askBtn.addEventListener("click", function () {
			var rowEl = rowBefore(card);
			if (rowEl) openEditor(rowEl, null, { replyTo: c.id, kind: "question", note: c, placeholder: "Ask the agent about this note…" });
		});
		acts.appendChild(askBtn);
		if (c.suggestion) {
			var adopted = session.userComments.some(function (u) { return u.replyTo === c.id && u.kind === "adopt"; });
			if (adopted) {
				acts.appendChild(el("span", "adopted", "Adoption requested ✓"));
			} else {
				var adoptBtn = el("button", "btn small", "Adopt suggestion");
				adoptBtn.addEventListener("click", function () {
					adoptBtn.disabled = true;
					postJSON("/api/comments", {
						anchor: { sha: c.sha, file: c.file, side: c.side, line: c.line, lineText: c.lineText, replyTo: c.id, kind: "adopt" },
						body: "Please apply this suggestion:\\n\`\`\`\\n" + c.suggestion + "\\n\`\`\`",
					}).then(function (d) {
						session.userComments = d.userComments;
						refresh();
					}).catch(function () { adoptBtn.disabled = false; });
				});
				acts.appendChild(adoptBtn);
			}
		}
		card.appendChild(acts);
	} else {
		var acts = el("div", "card-actions");
		var editBtn = el("button", "btn small", "Edit");
		editBtn.addEventListener("click", function () {
			var rowEl = rowBefore(card);
			if (rowEl) openEditor(rowEl, c);
		});
		var resBtn = el("button", "btn small", c.status === "resolved" ? "Reopen" : "Resolve");
		resBtn.addEventListener("click", function () {
			resBtn.disabled = true;
			postJSON("/api/comments", {
				anchor: anchorOf(c),
				status: c.status === "resolved" ? "open" : "resolved",
			}).then(function (d) {
				session.userComments = d.userComments;
				refresh();
			}).catch(function () { resBtn.disabled = false; });
		});
		var delBtn = el("button", "btn small danger", "Delete");
		delBtn.addEventListener("click", function () {
			delBtn.disabled = true;
			postJSON("/api/comments/delete", {
				anchor: anchorOf(c),
			}).then(function (d) {
				session.userComments = d.userComments;
				refresh();
			}).catch(function () { delBtn.disabled = false; });
		});
		acts.appendChild(editBtn);
		acts.appendChild(resBtn);
		acts.appendChild(delBtn);
		card.appendChild(acts);
	}
	return card;
}

function closeEditor() {
	if (openEditorEl) {
		openEditorEl.remove();
		openEditorEl = null;
	}
}

function openEditor(row, existing, opts) {
	closeEditor();
	var l = row._line;
	var it = row._item;
	var er = el("div", "editor-row");
	var ta = el("textarea");
	ta.placeholder = (opts && opts.placeholder) || "Leave a comment (Cmd/Ctrl+Enter to save, Esc to cancel)";
	if (existing) ta.value = existing.body;
	er.appendChild(ta);
	var grow = function () {
		ta.style.height = "auto";
		ta.style.height = ta.scrollHeight + "px";
	};
	ta.addEventListener("input", grow);
	var actions = el("div", "editor-actions");
	var cancelBtn = el("button", "btn", "Cancel");
	var saveBtn = el("button", "btn primary", existing ? "Save" : "Comment");
	actions.appendChild(cancelBtn);
	actions.appendChild(saveBtn);
	er.appendChild(actions);

	var anchorNode = row;
	while (anchorNode.nextSibling && anchorNode.nextSibling.classList && anchorNode.nextSibling.classList.contains("crow")) {
		anchorNode = anchorNode.nextSibling;
	}
	anchorNode.parentNode.insertBefore(er, anchorNode.nextSibling);
	openEditorEl = er;
	setTimeout(function () { ta.focus(); grow(); }, 0);

	function doSave() {
		var anchor;
		if (opts && opts.replyTo) {
			// Reply to an agent note: anchor to the note (or the reply's own
			// anchor when editing), preserving replyTo/kind.
			var n = existing || opts.note;
			anchor = {
				sha: n.sha,
				file: n.file,
				side: n.side,
				line: n.line,
				lineText: n.lineText,
				replyTo: opts.replyTo,
				kind: opts.kind,
			};
		} else {
			anchor = {
				sha: it.sha,
				file: l.file,
				side: l.kind === "del" ? "old" : "new",
				line: l.kind === "del" ? l.oldLine : l.newLine,
				lineText: l.text,
			};
		}
		saveBtn.disabled = true;
		postJSON("/api/comments", { anchor: anchor, body: ta.value }).then(function (d) {
			session.userComments = d.userComments;
			closeEditor();
			refresh();
		}).catch(function () { saveBtn.disabled = false; });
	}
	cancelBtn.addEventListener("click", closeEditor);
	saveBtn.addEventListener("click", doSave);
	ta.addEventListener("keydown", function (e) {
		if (e.key === "Escape") {
			e.preventDefault();
			closeEditor();
		} else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			doSave();
		}
	});
}

function refresh() {
	renderTop();
	renderSidebar();
	renderDiff(true);
}

function orderedEntries(list) {
	var out = [];
	session.items.forEach(function (it, i) {
		list
			.filter(function (c) { return shaEq(c.sha, it.sha); })
			.sort(function (a, b) {
				if (a.file !== b.file) return a.file < b.file ? -1 : 1;
				return a.line - b.line;
			})
			.forEach(function (c) { out.push({ i: i, c: c }); });
	});
	return out;
}

function scrollToCard(id) {
	var node = document.getElementById(id);
	if (!node) return;
	var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	node.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
	node.classList.add("flash");
	setTimeout(function () { node.classList.remove("flash"); }, 1500);
}

function nav(kind, dir) {
	if (!session) return;
	var list = kind === "agent"
		? session.agentComments.filter(function (c) { return sevRank(c) >= sevMinRank() && noteStates[c.id] !== "missing"; })
		: session.userComments;
	var ordered = orderedEntries(list);
	if (!ordered.length) return;
	navPtr[kind] = (navPtr[kind] + dir + ordered.length) % ordered.length;
	var t = ordered[navPtr[kind]];
	var go = t.i === cur ? Promise.resolve() : selectItem(t.i);
	go.then(function () { scrollToCard(kind + "-" + t.c.id); });
}

document.addEventListener("keydown", function (e) {
	var t = e.target;
	if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	if (e.key === "n") nav("agent", 1);
	else if (e.key === "p") nav("agent", -1);
	else if (e.key === "]") nav("user", 1);
	else if (e.key === "[") nav("user", -1);
});

function closeReview(title) {
	var submit = document.getElementById("submit");
	var close = document.getElementById("closebtn");
	if (submit) submit.disabled = true;
	if (close) close.disabled = true;
	postJSON("/api/close", {}).catch(function () {}).then(function () {
		document.body.textContent = "";
		var wrap = el("div", "done");
		wrap.appendChild(el("div", "done-title", title));
		wrap.appendChild(el("div", "done-sub", "You can close this tab."));
		document.body.appendChild(wrap);
	});
}

// Sticky offsets track the real topbar height (fonts/zoom change it).
(function () {
	var tb = document.querySelector(".topbar");
	if (tb) document.body.style.setProperty("--topbar-h", tb.offsetHeight + "px");
})();

document.getElementById("submit").addEventListener("click", function () {
	closeReview("Review submitted");
});
document.getElementById("collapseall").addEventListener("click", toggleAllFiles);
document.getElementById("sevfilter").addEventListener("change", function () {
	severityFilter = this.value;
	refresh();
});
document.getElementById("closebtn").addEventListener("click", function () {
	closeReview("Review closed");
});

api("/api/session").then(function (s) {
	session = s;
	renderTop();
	renderSidebar();
	// Deep-link: #i=N selects the Nth review item on load.
	var start = 0;
	var hm = (window.location.hash || "").match(/i=(\\d+)/);
	if (hm) start = Math.min(Math.max(0, Number(hm[1])), Math.max(0, session.items.length - 1));
	if (session.items.length) selectItem(start);
	else document.getElementById("main").appendChild(el("div", "placeholder", "Nothing to review."));
}).catch(function () {
	document.getElementById("main").appendChild(el("div", "placeholder", "Failed to load review session."));
});
})();
</script>
</body>
</html>
`;
