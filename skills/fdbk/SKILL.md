---
name: fdbk
description: Read, reply to, resolve, and leave code review comments with git-feedback (fdbk). Use when the user asks you to address review feedback, look at review comments or threads, review a diff or branch, or mentions fdbk, git feedback, or a review on their change.
---

# git-feedback (fdbk)

git-feedback stores code reviews of any `git diff` locally in the repository. A review has threads; each thread is a list of comments anchored to a line or line range, a whole file, or the whole review. The user usually writes comments in Emacs and expects you to read and answer them.

## Which interface to use

If the `review_list`, `review_show`, `review_refresh`, `review_reply`, `review_resolve` and `review_comment` tools are available (the OpenCode plugin), use them. In OpenCode they are Code Mode tools: call them through `execute` at their exact catalog paths. Their arguments mirror the CLI below.

Otherwise, run the `fdbk` command (also available as `git feedback`). Add `--json` to any command when you need structured output.

The tools only see reviews in the repository the session was started in. To work with reviews in any other repository, such as when you coordinate changes across several, use the CLI even if the tools are available, and point it at that repository with `-C`: `fdbk -C ../other-repo show`.

| Task | CLI | Tool |
| --- | --- | --- |
| List open reviews | `fdbk list` | `review_list` |
| Read unresolved threads with code context | `fdbk show` | `review_show` |
| Record code changes and move threads | `fdbk refresh` | `review_refresh` |
| Reply | `fdbk reply <thread> --body TEXT` | `review_reply` |
| Resolve or reopen | `fdbk resolve <thread>`, `fdbk unresolve <thread>` | `review_resolve` |
| Start a thread | `fdbk comment [--path P [--line N [--start-line M]] [--side old\|new]] --body TEXT` | `review_comment` |
| Start or resume a review | `fdbk start [--title T] -- <git diff args>` | none |

Commands use the only open review in the repository. When there are several, pass `--review <id>` (or the `review` argument), using an id from the list. Thread ids may be shortened to any unique prefix. For bodies with several lines or shell metacharacters, use `--body-file -` and pipe the text on stdin.

Comments must be marked as written by an agent so the user can tell them apart from their own. The review tools do this, and so does `fdbk` inside Claude Code, Codex, OpenCode, or a harness that sets `$AI_AGENT`. Anywhere else, pass `--agent --author <your harness name>` (for example `--agent --author cursor`) to `comment` and `reply`.

## Addressing review feedback

These steps name CLI commands; use the matching tool from the table when the tools are available.

1. Read the unresolved threads with `fdbk show`. It re-anchors threads to the current code first. Threads marked outdated quote the code as it was when the comment was written.
2. For each thread, decide whether the feedback is right. Make the code change when it is.
3. After editing, run `fdbk refresh` so threads follow the code to their new lines.
4. Reply to every thread: say what you changed, or explain why you disagree.
5. Resolve a thread only when you made the requested change. Leave questions and disagreements unresolved for the reviewer.
6. Finish with a short summary of what you changed and which threads still need the reviewer.

## Reviewing a change

Start a review with the same arguments you would pass to `git diff`, then comment on it:

```sh
fdbk start -- origin/main...HEAD       # a branch; HEAD for the worktree, --cached for the index
fdbk comment --path src/app.ts --line 42 --body "This can throw when the list is empty."
fdbk comment --path src/app.ts --body "Comment on the whole file"
fdbk comment --body "Comment on the whole review"
```

Line numbers refer to the new side of the diff unless you pass `--side old`. Use `--start-line` with `--line` to comment on a range.

## GitHub

`fdbk github start|pull|push` syncs a review with a pull request. Pulling is safe. Pushing posts comments publicly as the user, so run `fdbk github push` only when the user explicitly asks you to.
