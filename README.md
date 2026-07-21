# code-eye

A [pi](https://pi.dev) extension that brings a GitHub-style code review experience into the terminal.

Review your changes commit by commit in a two-pane TUI overlay — commit list on the left, syntax-colored diff on the right — and let the agent walk you through the key changes with context, right where they happen. Prefer a browser? `/code-eye-web` opens the same review in a local web UI:

![Web review: agent walkthrough notes inline on the diff](docs/assets/web-review.png)

## Features

- **Per-commit review** — left pane lists your uncommitted changes plus every commit in `base..HEAD` (base defaults to `main`, falls back to `master` or the origin default branch); the right pane shows the selected commit's diff with GitHub-style red/green coloring and line numbers.
- **Agent walkthrough** — the agent inspects your changes and leaves read-only notes (◆) anchored to commit/file/line, alongside your own comments (●). Jump between notes with `n`/`p`.
- **Browser surface** — `/code-eye-web` (or the agent's `review` tool with `surface: "web"`) opens the same review in your browser via a throwaway `127.0.0.1` server: real scrolling, multi-line comment editing, GitHub-like chrome. It shuts down when you submit or close.
- **Two-way trigger** — open the panel yourself with `/code-eye`, ask the agent for a guided tour with `/code-eye-walkthrough`, or let the agent call its `review` tool after making changes ("walk me through what you changed").
- **Quiet closes** — only your comments reach the agent; closing the panel without commenting is a silent "LGTM" (agent notes are never fed back as work items).

## Installation

```bash
pi install npm:@toddzheng024/code-eye
```

Or from the git repo:

```bash
pi install git:github.com/qiz029/code-eye
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
	"packages": ["npm:@toddzheng024/code-eye"]
}
```

To try it without installing:

```bash
pi -e git:github.com/qiz029/code-eye
```

Reload a running pi session with `/reload`.

## Usage

| Command | Description |
|---|---|
| `/code-eye` | Open the review panel (TUI) |
| `/code-eye-web` | Open the review panel in the browser |
| `/code-eye-walkthrough` | Ask the agent to generate a walkthrough and open the panel with it |

Inside the panel:

| Key | Action |
|---|---|
| `↑`/`↓` | Select commit (left pane) / scroll diff (right pane) |
| `Tab` / `Enter` / `←` | Switch between panes |
| `PgUp`/`PgDn` | Page through the diff |
| `n` / `p` | Next / previous agent note (when a walkthrough is active) |
| `c` / `Enter` | Add or edit a comment on the current diff line (add/del/context only) |
| `d` | Delete your comment on the current line (agent notes are read-only) |
| `[` / `]` | Jump to previous / next comment |
| `w` | Ask the agent for a walkthrough (when none is active) |
| `Esc` | Close the panel (and submit any comments) |

**Line comments.** Move to a changed line, press `c` (or `Enter` on a commentable line), type your note, and press `Enter` to save. Lines with your comments are marked `●`, agent walkthrough notes are marked `◆` and peek under the cursor. Your comments stay in the session if you reopen the panel; agent notes are regenerated each time.

When you close the panel:
- If you left no comments, nothing is sent anywhere — a silent "LGTM".
- If the agent opened it via the `review` tool, your comments come back in the tool result for the agent to address.
- If you opened it with `/code-eye` or `/code-eye-web`, your comments are sent to the agent as a follow-up message.

The agent can also open the panel itself via the `review` tool, optionally passing a summary, walkthrough stops, and `surface: "web"` to use the browser. The tool blocks until you close the panel, so the conversation picks up right after your review.

## Web surface

`/code-eye-web` (or `review` with `surface: "web"`) serves the review from an ephemeral `127.0.0.1` server and opens your browser; the server shuts down when you submit or close the tab.

![Web review: per-commit view with file stats, status chips, and expandable gaps](docs/assets/web-review-commit.png)

- Click items in the sidebar to switch between uncommitted changes and commits; `#i=N` in the URL deep-links to an item.
- Hover a diff line and click the blue **+** to write a multi-line comment (`Cmd/Ctrl+Enter` saves, `Esc` cancels); your comments show up as editable "you" cards.
- Agent walkthrough notes render as read-only 🤖 cards with kind chips; `n`/`p` jumps between them, `]`/`[` between your own comments.
- Hidden context between hunks expands in place via **↑ Expand up / ↓ Expand down**.

## Development

```bash
git clone https://github.com/qiz029/code-eye.git
cd code-eye
npm install
npx tsc --noEmit   # type check
```

Run it from the working copy:

```bash
pi -e ./index.ts
```

Or symlink it for auto-discovery and hot reload:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/code-eye
# then /reload inside pi
```

## How it works

- `git.ts` — detects the base branch, lists `base..HEAD` commits plus uncommitted changes, and loads per-commit patches via `git show` / `git diff`.
- `parse-unidiff.ts` — parses unified diffs into structured lines (file, old/new line numbers) so walkthrough stops can anchor to exact lines.
- `comments.ts` — the shared `ReviewComment` model: user comments (editable, persisted, sent to the agent) and agent walkthrough notes (read-only, regenerated per session) share one anchor format.
- `walkthrough.ts` — converts agent walkthrough stops into agent comments (ADR-0001).
- `review-view.ts` — the two-pane TUI overlay component, built on pi's `ctx.ui.custom()` overlay API.
- `web-review.ts` — the optional browser surface: an ephemeral `127.0.0.1` server serving a GitHub-style review page (ADR-0003).
- `index.ts` — registers the `/code-eye`, `/code-eye-web` and `/code-eye-walkthrough` commands and the `review` tool the agent can call.
