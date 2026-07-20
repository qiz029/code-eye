# code-eye

A [pi](https://pi.dev) extension that brings a GitHub-style code review experience into the terminal.

Review your changes commit by commit in a two-pane TUI overlay — commit list on the left, syntax-colored diff on the right — and let the agent walk you through the key changes with context, right where they happen.

## Features

- **Per-commit review** — left pane lists your uncommitted changes plus every commit in `base..HEAD` (base defaults to `main`, falls back to `master` or the origin default branch); the right pane shows the selected commit's diff with GitHub-style red/green coloring and line numbers.
- **Agent walkthrough** — the agent inspects your changes and opens the panel with an ordered list of stops: the key changes, design decisions, and risky spots, each anchored to a commit/file/line with the context you need to evaluate it. Jump between stops with `n`/`p`.
- **Two-way trigger** — open the panel yourself with `/code-eye`, ask the agent for a guided tour with `/code-eye-walkthrough`, or let the agent call its `review` tool after making changes ("walk me through what you changed").

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
| `/code-eye` | Open the review panel |
| `/code-eye-walkthrough` | Ask the agent to generate a walkthrough and open the panel with it |

Inside the panel:

| Key | Action |
|---|---|
| `↑`/`↓` | Select commit (left pane) / scroll diff (right pane) |
| `Tab` / `Enter` / `←` | Switch between panes |
| `PgUp`/`PgDn` | Page through the diff |
| `n` / `p` | Next / previous walkthrough stop (when a walkthrough is active) |
| `w` | Ask the agent for a walkthrough (when none is active) |
| `Esc` | Close the panel |

The agent can also open the panel itself via the `review` tool, optionally passing a summary and walkthrough stops. The tool blocks until you close the panel, so the conversation picks up right after your review.

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
- `review-view.ts` — the two-pane overlay component, built on pi's `ctx.ui.custom()` overlay API.
- `index.ts` — registers the `/code-eye` and `/code-eye-walkthrough` commands and the `review` tool the agent can call.
