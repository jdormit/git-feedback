# git-feedback

Reviewing a change works the same way whether it's a coworker's pull request, a branch an agent just wrote, or uncommitted edits in a worktree. You read a diff, leave comments on lines, discuss them, and resolve them as the code changes. git-feedback (`fdbk`) stores that review in one format and lets several tools work on it. The Magit frontend is where you read and comment, an OpenCode plugin lets agents read and answer feedback, and GitHub sync moves the review to and from a pull request.

## How a review is stored

A review targets anything you can pass to `git diff`: `HEAD` for the worktree, `--cached` for the index, `origin/main...my-branch` for a branch, `abc123^!` for a commit, optionally followed by `-- paths`. The arguments are kept verbatim so the review can be reopened later, but they don't pin the code down on their own. Branches move, and the worktree changes as you edit. So each time a review is refreshed, `fdbk` resolves the spec to concrete objects and records them as a numbered revision. The index and worktree are snapshotted as tree objects without touching the real index. Every revision is pinned under `refs/git-feedback/<id>/` so `git gc` keeps the reviewed code around.

Comments live in threads anchored to a path, a side (`old` for the base, `new` for the head), and a line or line range in a specific revision. A thread can also be about a whole file or the whole review. When a refresh produces a new revision, `fdbk` diffs each thread's file between the two revisions and moves the thread to its new line number, following renames. If the commented lines themselves changed, the thread is marked outdated and keeps the original text, the same way GitHub handles outdated comments.

Reviews are JSON files in `$(git rev-parse --git-common-dir)/git-feedback/reviews/`, shared by all worktrees of a repository and never committed. Writes take a lock file and replace the file atomically, so Emacs and an agent can edit the same review concurrently. The schema is in [`core/src/types.ts`](core/src/types.ts).

## Installing

```sh
./install.sh                 # or PREFIX=/usr/local ./install.sh
./install.sh --uninstall
```

The script needs [Bun](https://bun.sh). It builds `dist/fdbk`, then symlinks it as `fdbk` and `git-feedback` in `$PREFIX/bin` and the man pages into `$PREFIX/share/man/man1`. `PREFIX` defaults to `~/.local`. Since these are links, rebuilding with `bun run build` updates the installed command. The `git-feedback` link makes `git feedback` work as a git subcommand, and the man pages make `git feedback --help` and `man fdbk` work. GitHub sync calls the `gh` CLI, which needs to be logged in to the host.

## Command line

```sh
fdbk start -- origin/main...HEAD      # start or resume a review of a diff
fdbk comment --path src/app.ts --line 42 --body "Why is this async?"
fdbk show                              # unresolved threads with code context
fdbk reply <thread> --body "Fixed in the latest revision"
fdbk resolve <thread>
fdbk refresh                           # record the current code and move threads
```

Every command accepts `--json`, which is the contract other frontends build on. When a repository has a single open review, commands use it; otherwise pass `--review <id>` or set `$FDBK_REVIEW`. Run `fdbk --help` for the rest.

## Emacs

[`emacs/fdbk.el`](emacs/fdbk.el) needs Magit and Transient:

```elisp
(use-package fdbk
  :load-path "~/git-feedback/emacs"
  :commands (fdbk-start fdbk-open fdbk-github-review fdbk-dispatch))
```

Run `M-x fdbk-start` in any Magit diff or revision buffer to review what it shows. Threads appear under the lines they belong to, and a summary at the top lists threads that can't be placed inline, such as outdated ones and comments on the whole review. `C-c C-r` opens the review menu: comment on the line or region at point, comment on a file or the whole review, reply, edit, resolve, refresh, and push or pull GitHub comments. When an agent changes the review, the buffer redraws on its own.

Staging and discarding still work while a review is shown, because the inline comment text is removed before Magit reads a hunk.

## OpenCode

Add the plugin to `opencode.jsonc`:

```jsonc
"plugin": ["/Users/you/git-feedback/opencode/src/index.ts"]
```

It gives agents `review_list`, `review_show`, `review_refresh`, `review_reply`, `review_resolve` and `review_comment`, and registers an `/address-review` command that asks the agent to work through the open threads: fix what it agrees with, reply to everything, and resolve only the threads it actually addressed. Agent comments are marked as written by an agent, so they're easy to tell apart from yours.

## GitHub

```sh
fdbk github start 1234                 # or owner/repo#1234, or the PR URL
fdbk github pull
fdbk github push --event request-changes --body "A few things to look at"
```

`github start` fetches the PR's base branch and head into the review's refs, starts a review of `base...head`, and imports existing review threads and conversation comments. `github pull` refetches and imports new comments, remote edits and resolution changes. `github push` submits new line comments as a single review, posts replies and top-level comments, and sends edits and resolution changes.

A few GitHub rules shape what push does. GitHub only accepts line comments on lines inside the PR diff, so a comment on another line is posted as a file comment that names the line. New comments are placed against the PR's current head, so push refuses to post them until a `github pull` has brought the review up to date. Outdated local threads are skipped rather than placed on code they no longer describe. Resolved state syncs both ways. When a comment was edited both locally and on GitHub, the local edit wins on the next push.

## Development

```sh
bun test                     # core, CLI, GitHub sync and plugin
bunx tsc --noEmit
emacs/run-tests.sh           # Emacs tests in a separate batch Emacs with a throwaway HOME
```

GitHub sync is tested against an in-memory fake of the API, not a real pull request.
