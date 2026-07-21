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
	removeCommentAt,
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
				sendJSON(res, 200, { lines });
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
				const body = parsed as { anchor?: unknown; body?: unknown };
				const anchor = parseAnchor(body?.anchor);
				if (!anchor || typeof body?.body !== "string") {
					sendJSON(res, 400, { error: "expected { anchor, body }" });
					return;
				}
				userComments = upsertComment(userComments, anchor, body.body);
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
			console.log(`code-eye web review: ${url}`);
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
body { background: #0d1117; color: #c9d1d9; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; --topbar-h: 50px; }
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
.brand { display: flex; gap: 8px; align-items: baseline; font-weight: 600; color: #f0f6fc; }
.brand .sep { color: #8b949e; font-weight: 400; }
.stats { display: flex; gap: 12px; color: #8b949e; font-size: 13px; }
.actions { margin-left: auto; display: flex; gap: 8px; }
.btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.btn:hover { background: #30363d; }
.btn.primary { background: #1f6feb; border-color: #1f6feb; color: #ffffff; }
.btn.primary:hover { background: #388bfd; }
.btn.small { padding: 2px 8px; font-size: 12px; }
.btn.danger { color: #f85149; }
.btn:disabled { opacity: .5; cursor: default; }
.layout { display: flex; align-items: flex-start; }
aside { width: 280px; flex: none; position: sticky; top: var(--topbar-h); max-height: calc(100vh - var(--topbar-h)); overflow-y: auto; border-right: 1px solid #30363d; padding: 8px; }
main { flex: 1; min-width: 0; padding: 16px; }
.item { padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; margin-bottom: 4px; }
.item:hover { background: #161b22; }
.item.active { background: #161b22; border-color: #30363d; }
.item-top { display: flex; align-items: center; gap: 8px; }
.sha { font-size: 12px; color: #58a6ff; }
.sha.amber { color: #d29922; }
.badge-count { margin-left: auto; background: #30363d; color: #c9d1d9; border-radius: 10px; padding: 0 8px; font-size: 12px; line-height: 18px; }
.subject { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.item.uncommitted .subject { color: #d29922; }
.summaries { margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; }
.summary { background: #161b22; border: 1px solid #30363d; border-left: 3px solid #58a6ff; border-radius: 6px; padding: 10px 12px; }
.summary-title { font-weight: 600; color: #f0f6fc; margin-bottom: 4px; }
.summary-detail { color: #8b949e; white-space: pre-wrap; }
.file { border: 1px solid #30363d; border-radius: 6px; margin-bottom: 16px; background: #0d1117; }
.fhead { position: sticky; top: var(--topbar-h); z-index: 10; display: flex; align-items: center; gap: 8px; background: #161b22; padding: 10px 12px; border-bottom: 1px solid #30363d; border-radius: 6px 6px 0 0; }
.ficon { font-size: 13px; }
.fpath { color: #f0f6fc; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fstats { margin-left: auto; display: flex; gap: 8px; font-size: 12px; flex: none; }
.fadd { color: #3fb950; }
.fdel { color: #f85149; }
.fchip { font-size: 11px; border-radius: 10px; padding: 1px 8px; border: 1px solid; flex: none; }
.fchip.added { color: #3fb950; border-color: rgba(63,185,80,.4); background: rgba(63,185,80,.1); }
.fchip.deleted { color: #f85149; border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.1); }
.fchip.renamed { color: #58a6ff; border-color: rgba(56,139,253,.4); background: rgba(56,139,253,.1); }
.fbody { overflow-x: auto; border-radius: 0 0 6px 6px; }
.drow { display: grid; grid-template-columns: 24px 48px 48px 20px 1fr; width: max-content; min-width: 100%; }
.gutter { position: relative; }
.gbtn { display: none; position: absolute; left: 2px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; line-height: 1; padding: 0; background: #1f6feb; color: #ffffff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
.drow:hover .gbtn { display: block; }
.ln { text-align: right; padding: 0 8px; color: #6e7681; font-size: 12px; line-height: 20px; user-select: none; }
.sign { text-align: center; color: #8b949e; line-height: 20px; user-select: none; }
.code { white-space: pre; padding-right: 16px; font-size: 12.5px; line-height: 20px; }
.drow.add { background: rgba(63,185,80,.12); }
.drow.add .sign { color: #3fb950; }
.drow.del { background: rgba(248,81,73,.12); }
.drow.del .sign { color: #f85149; }
.hunk { color: #58a6ff; background: rgba(56,139,253,.1); padding: 4px 12px; font-size: 12px; width: max-content; min-width: 100%; }
.expander { display: flex; align-items: center; gap: 10px; padding: 4px 12px; background: #161b22; border-top: 1px solid #21262d; border-bottom: 1px solid #21262d; width: max-content; min-width: 100%; }
.exp-btn { background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 4px; }
.exp-btn:hover { background: rgba(56,139,253,.12); }
.exp-label { color: #6e7681; font-size: 12px; }
.crow { padding: 8px 12px 8px 92px; display: flex; flex-direction: column; gap: 8px; width: max-content; min-width: 100%; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; max-width: 760px; }
.card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.badge { font-size: 12px; border-radius: 10px; padding: 1px 8px; }
.b-user { background: rgba(56,139,253,.15); color: #58a6ff; border: 1px solid rgba(56,139,253,.4); }
.b-agent { background: rgba(210,153,34,.15); color: #d29922; border: 1px solid rgba(210,153,34,.4); }
.chip { font-size: 11px; color: #8b949e; border: 1px solid #30363d; border-radius: 10px; padding: 1px 8px; }
.card-title { font-weight: 600; color: #f0f6fc; margin-bottom: 4px; }
.card-body { white-space: pre-wrap; }
.card-actions { display: flex; gap: 8px; margin-top: 8px; }
.card.flash { border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88,166,255,.4); }
.editor-row { padding: 8px 12px 8px 92px; width: max-content; min-width: 100%; }
.editor-row textarea { width: 100%; max-width: 760px; min-width: min(760px, 60vw); min-height: 80px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px; font: inherit; resize: vertical; }
.editor-row textarea:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88,166,255,.3); }
.editor-actions { display: flex; gap: 8px; justify-content: flex-end; max-width: 760px; margin-top: 8px; }
.placeholder { color: #8b949e; padding: 48px; text-align: center; }
.done { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.done-title { font-size: 20px; font-weight: 600; color: #f0f6fc; }
.done-sub { color: #8b949e; }
</style>
</head>
<body>
<header class="topbar">
	<div class="brand"><span id="repo" class="mono"></span><span class="sep">/</span><span>Code Review</span></div>
	<div class="stats"><span id="icount"></span><span id="ucount"></span></div>
	<div class="actions"><button id="closebtn" class="btn">Close</button><button id="submit" class="btn primary">Submit review</button></div>
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
// New-side file content per item|file -> array of lines (null = unavailable).
var fileCache = {};
var filePending = {};

var HUNK_RE = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/;

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
	session.userComments.forEach(function (c) { if (commentMatches(c, line, sha)) out.push(c); });
	session.agentComments.forEach(function (c) { if (commentMatches(c, line, sha)) out.push(c); });
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

function fileHeader(name, fl) {
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
	h.appendChild(el("span", "ficon", "📄"));
	h.appendChild(el("span", "fpath mono", name));
	if (status) h.appendChild(el("span", "fchip " + status, status));
	var stats = el("span", "fstats mono");
	if (adds) stats.appendChild(el("span", "fadd", "+" + adds));
	if (dels) stats.appendChild(el("span", "fdel", "−" + dels));
	h.appendChild(stats);
	return h;
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
	var sec = el("div", "file");
	sec.appendChild(fileHeader(name, fl));
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
		fbody.appendChild(diffRow(l, it));
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

function diffRow(l, it) {
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
	row.appendChild(el("div", "code mono", l.text));
	return row;
}

function commentCard(c) {
	var isAgent = c.author === "agent";
	var card = el("div", "card " + (isAgent ? "agent" : "user"));
	card.id = (isAgent ? "agent-" : "user-") + c.id;
	var head = el("div", "card-head");
	head.appendChild(el("span", "badge " + (isAgent ? "b-agent" : "b-user"), isAgent ? "🤖 agent" : "you"));
	if (c.kind) head.appendChild(el("span", "chip", c.kind));
	card.appendChild(head);
	if (c.title) card.appendChild(el("div", "card-title", c.title));
	card.appendChild(el("div", "card-body", c.body));
	if (!isAgent) {
		var acts = el("div", "card-actions");
		var editBtn = el("button", "btn small", "Edit");
		editBtn.addEventListener("click", function () {
			var crow = card.parentNode;
			var rowEl = crow && crow.previousElementSibling;
			if (rowEl && rowEl._line) openEditor(rowEl, c);
		});
		var delBtn = el("button", "btn small danger", "Delete");
		delBtn.addEventListener("click", function () {
			delBtn.disabled = true;
			postJSON("/api/comments/delete", {
				anchor: { sha: c.sha, file: c.file, side: c.side, line: c.line },
			}).then(function (d) {
				session.userComments = d.userComments;
				refresh();
			}).catch(function () { delBtn.disabled = false; });
		});
		acts.appendChild(editBtn);
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

function openEditor(row, existing) {
	closeEditor();
	var l = row._line;
	var it = row._item;
	var er = el("div", "editor-row");
	var ta = el("textarea");
	ta.placeholder = "Leave a comment (Cmd/Ctrl+Enter to save, Esc to cancel)";
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
		var anchor = {
			sha: it.sha,
			file: l.file,
			side: l.kind === "del" ? "old" : "new",
			line: l.kind === "del" ? l.oldLine : l.newLine,
			lineText: l.text,
		};
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
	node.scrollIntoView({ block: "center", behavior: "smooth" });
	node.classList.add("flash");
	setTimeout(function () { node.classList.remove("flash"); }, 1500);
}

function nav(kind, dir) {
	if (!session) return;
	var list = kind === "agent" ? session.agentComments : session.userComments;
	var ordered = orderedEntries(list);
	if (!ordered.length) return;
	navPtr[kind] = (navPtr[kind] + dir + ordered.length) % ordered.length;
	var t = ordered[navPtr[kind]];
	var go = t.i === cur ? Promise.resolve() : selectItem(t.i);
	go.then(function () { scrollToCard(kind + "-" + t.c.id); });
}

document.addEventListener("keydown", function (e) {
	var t = e.target;
	if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
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
