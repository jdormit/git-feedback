# git-universal-review v1

A file format and toolset for reviewing any git diff, with several frontends
that share one core. Supersedes `forge-review` (code may be borrowed from it,
but nothing calls into it).

## Architecture

- `core/` — TypeScript on Bun. Library plus the `git-universal-review` CLI
  (alias `gur`). The only code that reads or writes review files.
- `emacs/` — `gur.el`, the Magit frontend. Talks to the CLI with `--json`.
- `opencode/` — OpenCode plugin. Imports the core library directly.
- GitHub sync lives in core (`gur github ...`) and uses `gh`.

The frontend contract is the CLI's commands and JSON output plus the review
file schema.

## Target

A target is the argument list passed to `git diff` (`spec`), the worktree it
runs in, and the list of revisions it has resolved to. Each revision records
the `base` and `head` objects. Index and worktree sides become snapshot trees.
Every revision's objects are pinned under `refs/universal-review/<id>/<n>/`.

## Storage

`$(git rev-parse --git-common-dir)/universal-review/reviews/<id>.json`, local
only. Writes take a lock file and use an atomic rename.

## Re-anchoring

On refresh, if the spec resolves to new objects, a revision is added. Each
thread that is not outdated is mapped forward by diffing the old blob against
the new blob (following renames). If any anchored line changed, the thread is
marked outdated and keeps its last position and original text.

## GitHub sync (v1)

- `github start <pr>` fetches the PR's base and head into review refs and
  starts a review on `base...head`.
- `github link <pr>` attaches an existing review to a PR.
- `github pull` imports review threads, issue comments and review bodies,
  matched by GitHub IDs; resolved state syncs both ways using the last synced
  value.
- `github push` submits new threads as one review (approve, request changes
  or comment), posts replies, pushes edits and resolved state.

## Order of work

1. Core and CLI, with tests against temporary repos.
2. Magit frontend, with ERT tests.
3. OpenCode plugin and `/address-review` command.
4. GitHub sync, tested against a fake API client.
