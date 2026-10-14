#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { formatReview, summarize } from "./format"
import { openRepo } from "./git"
import { completePrRef, ghApi, githubLink, githubPull, githubPush, githubStart, parsePrRef, type GitHubApi, type ReviewEvent } from "./github"
import {
  addThread,
  defaultAuthor,
  deleteComment,
  deleteReview,
  detectAgent,
  editComment,
  refreshReview,
  reply,
  setResolved,
  setStatus,
  startReview,
  type Location,
} from "./review"
import { ReviewStore } from "./store"
import type { Author, Side } from "./types"

const USAGE = `usage: fdbk [-C <dir>] <command> [options]
       git feedback [-C <dir>] <command> [options]

Reviews
  start [--title T] [--new] [--] [<git diff args>...]   start or resume a review of a diff
                                                         (git diff options such as --cached go after --)
  list [--all]                                           list reviews (open only unless --all)
  show [--all] [--no-refresh]                            show threads (refreshes first)
  refresh                                                re-resolve the diff and move threads
  close | reopen | rm                                    change status or delete a review

Comments
  comment [--path P [--line N [--start-line M]] [--side old|new]] [--revision N] BODY
  reply <thread> BODY
  edit <comment> BODY
  delete <comment>
  resolve <thread> | unresolve <thread>

  BODY is --body TEXT or --body-file FILE ("-" for stdin).
  Authors default to git's user.name; --author NAME and --agent override
  (or $FDBK_AUTHOR and $FDBK_AUTHOR_KIND=agent). Inside Claude Code, Codex,
  OpenCode or a harness that sets $AI_AGENT, authors default to that agent;
  set $FDBK_AUTHOR_KIND=human to turn this off.

GitHub
  github start <pr>                    review a pull request (number, owner/repo#n or URL)
  github link <pr>                     link the current review to a pull request
  github pull                          import threads and comments
  github push [--event approve|request-changes|comment] [--body TEXT]

Common options
  --review <id>   choose a review (default: $FDBK_REVIEW, or the only open one)
  --json          print JSON instead of text
`

export interface RunContext {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  readStdin: () => Promise<string>
  /** Overrides the gh-backed client, for tests. */
  github?: GitHubApi
  env?: Record<string, string | undefined>
}

const OPTIONS = {
  directory: { type: "string", short: "C" },
  review: { type: "string" },
  json: { type: "boolean" },
  title: { type: "string" },
  new: { type: "boolean" },
  all: { type: "boolean" },
  "no-refresh": { type: "boolean" },
  path: { type: "string" },
  side: { type: "string" },
  line: { type: "string" },
  "start-line": { type: "string" },
  revision: { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
  author: { type: "string" },
  agent: { type: "boolean" },
  event: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
  return n
}

export async function run(argv: string[], ctx: RunContext): Promise<number> {
  const dashDash = argv.indexOf("--")
  // Everything after `start ... --` is the git diff spec, which may contain its own `--`.
  const specSplit = dashDash >= 0 && argv.slice(0, dashDash).includes("start")
  const optionArgs = specSplit ? argv.slice(0, dashDash) : argv
  const { values, positionals } = parseArgs({ args: optionArgs, options: OPTIONS, allowPositionals: true, strict: true })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    ctx.stdout(USAGE)
    return command || values.help ? 0 : 1
  }

  const cwd = resolve(ctx.cwd, values.directory ?? ".")
  const repo = openRepo(cwd)
  const store = new ReviewStore(repo)
  const out = (json: unknown, text: string) => ctx.stdout(values.json ? JSON.stringify(json, null, 2) + "\n" : text.endsWith("\n") ? text : text + "\n")
  const selected = () => store.select(values.review, repo.toplevel)
  const env = ctx.env ?? process.env
  const author = (): Author => {
    const harness = env["FDBK_AUTHOR_KIND"] === "human" ? undefined : detectAgent(env)
    const kind = values.agent || env["FDBK_AUTHOR_KIND"] === "agent" || harness ? "agent" : "human"
    return { name: values.author ?? env["FDBK_AUTHOR"] ?? harness ?? defaultAuthor(cwd).name, kind }
  }
  const body = async (): Promise<string> => {
    if (values.body !== undefined) return values.body
    const file = values["body-file"]
    if (file === "-") return ctx.readStdin()
    if (file) return readFileSync(resolve(cwd, file), "utf8")
    throw new Error("Pass the comment text with --body or --body-file")
  }
  const arg = (name: string) => {
    const value = rest[0]
    if (!value) throw new Error(`Missing <${name}> argument`)
    return value
  }
  const api = (host: string) => ctx.github ?? ghApi(host)

  switch (command) {
    case "start": {
      const afterDashDash = specSplit ? argv.slice(dashDash + 1) : []
      const spec = rest.length && specSplit ? [...rest, "--", ...afterDashDash] : [...rest, ...afterDashDash]
      const { review, created } = startReview(store, cwd, { spec, title: values.title, reuse: !values.new })
      out(review, `${created ? "Started" : "Resumed"} review ${review.id}: ${review.title}`)
      return 0
    }
    case "list": {
      const reviews = store.list().filter((r) => values.all || r.status === "open")
      const rows = reviews.map(summarize)
      out(
        rows,
        rows.length
          ? rows.map((r) => `${r.id}  ${r.status.padEnd(6)}  ${String(r.unresolved).padStart(3)} open  ${r.title}`).join("\n")
          : "No reviews.",
      )
      return 0
    }
    case "show": {
      let review = selected()
      if (!values["no-refresh"]) {
        try {
          review = refreshReview(store, review.id).review
        } catch (e) {
          ctx.stderr(`warning: could not refresh review ${review.id}: ${(e as Error).message}\n`)
        }
      }
      out(review, formatReview(review, { includeResolved: values.all }))
      return 0
    }
    case "refresh": {
      const { review, changed } = refreshReview(store, selected().id)
      const outdated = review.threads.filter((t) => t.outdated).length
      out({ changed, review }, changed ? `Now at revision ${review.target.revisions.length}; ${outdated} outdated thread(s).` : "No changes.")
      return 0
    }
    case "close":
    case "reopen": {
      const { review } = setStatus(store, selected().id, command === "close" ? "closed" : "open")
      out(review, `Review ${review.id} is ${review.status}.`)
      return 0
    }
    case "rm": {
      const id = values.review && existsSync(store.path(values.review)) ? values.review : selected().id
      deleteReview(store, id)
      out({ deleted: id }, `Deleted review ${id}.`)
      return 0
    }
    case "comment": {
      const review = selected()
      const line = int(values.line, "line")
      const startLine = int(values["start-line"], "start-line")
      if (values.side && values.side !== "old" && values.side !== "new") throw new Error("--side must be old or new")
      if ((line || startLine || values.side) && !values.path) throw new Error("--line, --start-line and --side need --path")
      if (startLine && !line) throw new Error("--start-line needs --line")
      const location: Location | undefined = values.path
        ? { path: values.path, side: values.side as Side | undefined, line, startLine }
        : undefined
      const { thread, comment } = addThread(store, review.id, {
        location,
        revision: int(values.revision, "revision"),
        body: await body(),
        author: author(),
      })
      out({ review: review.id, thread, comment }, `Added thread ${thread.id}.`)
      return 0
    }
    case "reply": {
      const review = selected()
      const { thread, comment } = reply(store, review.id, arg("thread"), await body(), author())
      out({ review: review.id, thread, comment }, `Replied to thread ${thread.id} (comment ${comment.id}).`)
      return 0
    }
    case "edit": {
      const review = selected()
      const { thread, comment } = editComment(store, review.id, arg("comment"), await body())
      out({ review: review.id, thread, comment }, `Edited comment ${comment.id}.`)
      return 0
    }
    case "delete": {
      const review = selected()
      const { thread, comment } = deleteComment(store, review.id, arg("comment"))
      out({ review: review.id, thread, comment }, `Deleted comment ${comment.id}.`)
      return 0
    }
    case "resolve":
    case "unresolve": {
      const review = selected()
      const { thread } = setResolved(store, review.id, arg("thread"), command === "resolve")
      out({ review: review.id, thread }, `Thread ${thread.id} ${command}d.`)
      return 0
    }
    case "github":
      return runGithub(rest, { store, cwd, out, selected, api, values })
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

interface GithubContext {
  store: ReviewStore
  cwd: string
  out: (json: unknown, text: string) => void
  selected: () => ReturnType<ReviewStore["select"]>
  api: (host: string) => GitHubApi
  values: { event?: string; body?: string }
}

async function runGithub([sub, prArg]: string[], { store, cwd, out, selected, api, values }: GithubContext): Promise<number> {
  const prRef = async () => {
    if (!prArg) throw new Error("Missing <pr> argument")
    return completePrRef(parsePrRef(prArg), cwd)
  }
  switch (sub) {
    case "start": {
      const ref = await prRef()
      const review = await githubStart(store, cwd, api(ref.host), ref)
      out(review, `Reviewing ${review.github!.url} as review ${review.id} (${review.threads.length} thread(s)).`)
      return 0
    }
    case "link": {
      const ref = await prRef()
      const review = await githubLink(store, selected().id, api(ref.host), ref)
      out(review, `Linked review ${review.id} to ${review.github!.url}.`)
      return 0
    }
    case "pull": {
      const review = selected()
      const result = await githubPull(store, review.id, api(review.github?.host ?? "github.com"))
      const warn = result.placed ? "" : " Warning: the review is not at the PR head, so new threads are marked outdated."
      out(result, `Imported ${result.added} new thread(s).${warn}`)
      return 0
    }
    case "push": {
      const review = selected()
      const event = values.event as ReviewEvent | undefined
      if (event && !["approve", "request-changes", "comment"].includes(event)) {
        throw new Error("--event must be approve, request-changes or comment")
      }
      const result = await githubPush(store, review.id, api(review.github?.host ?? "github.com"), { event, body: values.body })
      const parts = [
        `${result.reviewComments} inline`,
        `${result.fileComments} file-level`,
        `${result.replies} replies`,
        `${result.issueComments} conversation`,
        `${result.edits} edits`,
        `${result.resolved} resolution changes`,
      ]
      const skipped = result.skipped.length ? `\nSkipped:\n${result.skipped.map((s) => `  ${s}`).join("\n")}` : ""
      out(result, `Pushed ${parts.join(", ")}.${skipped}`)
      return 0
    }
    default:
      throw new Error("Usage: fdbk github start|link|pull|push")
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    readStdin: () => Bun.stdin.text(),
  }).catch((e: Error) => {
    process.stderr.write(`fdbk: ${e.message}\n`)
    return 1
  })
  process.exit(code)
}
