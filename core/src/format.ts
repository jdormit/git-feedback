import { readLines } from "./git"
import { latestRevision, revisionByNumber } from "./review"
import type { Review, Thread } from "./types"

export interface ReviewSummary {
  id: string
  title: string
  status: Review["status"]
  spec: string[]
  worktree: string
  revisions: number
  threads: number
  unresolved: number
  updatedAt: string
  github?: string
}

export function summarize(review: Review): ReviewSummary {
  return {
    id: review.id,
    title: review.title,
    status: review.status,
    spec: review.target.spec,
    worktree: review.target.worktree,
    revisions: review.target.revisions.length,
    threads: review.threads.length,
    unresolved: review.threads.filter((t) => !t.resolved).length,
    updatedAt: review.updatedAt,
    ...(review.github ? { github: review.github.url } : {}),
  }
}

export function locationLabel(thread: Thread): string {
  const a = thread.anchor
  if (a.kind === "review") return "whole review"
  const pos = thread.outdated ? undefined : thread.position
  const path = pos?.path ?? a.path
  if (a.kind === "file") return `${path} (whole file)`
  const line = pos?.line ?? a.line
  const start = pos ? pos.startLine : a.startLine
  const range = start !== undefined && start !== line ? `${start}-${line}` : `${line}`
  return `${path}:${range} (${a.side} side)`
}

function codeSnippet(review: Review, thread: Thread, context: number): string[] {
  const a = thread.anchor
  if (a.kind !== "line") return []
  if (thread.outdated || !thread.position) {
    const original = a.lines.length ? a.lines : (thread.github?.diffHunk?.split("\n").slice(-4) ?? [])
    return original.length ? ["Originally commented code (it has changed since):", ...original.map((l) => `    | ${l}`)] : []
  }
  const pos = thread.position
  const rev = revisionByNumber(review, pos.revision)
  const text = readLines(review.target.worktree, pos.side === "old" ? rev.base : rev.head, pos.path)
  if (!text || pos.line === undefined) return []
  const start = pos.startLine ?? pos.line
  const from = Math.max(1, start - context)
  const to = Math.min(text.length, pos.line + context)
  const width = String(to).length
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const marker = n >= start && n <= pos.line ? ">" : " "
    out.push(`${marker} ${String(n).padStart(width)} | ${text[n - 1]}`)
  }
  return out
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n")
}

export function formatThread(review: Review, thread: Thread, context = 3): string {
  const flags = [thread.resolved ? "resolved" : "unresolved", ...(thread.outdated ? ["outdated"] : [])]
  const lines = [`### Thread ${thread.id} [${flags.join(", ")}] ${locationLabel(thread)}`]
  const code = codeSnippet(review, thread, context)
  if (code.length) lines.push("", ...code)
  for (const c of thread.comments) {
    const tag = c.author.kind === "agent" ? " (agent)" : ""
    const pending = review.github && !c.github ? " [not yet on GitHub]" : ""
    lines.push("", `- ${c.author.name}${tag}, ${c.createdAt.slice(0, 16).replace("T", " ")}, comment ${c.id}${pending}:`, indent(c.body, "  "))
  }
  return lines.join("\n")
}

export interface FormatOptions {
  includeResolved?: boolean
  context?: number
}

export function formatReview(review: Review, opts: FormatOptions = {}): string {
  const latest = latestRevision(review)
  const shown = review.threads.filter((t) => opts.includeResolved || !t.resolved)
  const hidden = review.threads.length - shown.length
  const header = [
    `# Review ${review.id}: ${review.title} [${review.status}]`,
    `Diff: git diff ${review.target.spec.join(" ")}  (in ${review.target.worktree})`,
    `Revision ${latest.n}: ${latest.base.slice(0, 10)}..${latest.head.slice(0, 10)}`,
    ...(review.github ? [`GitHub: ${review.github.url}`] : []),
    `${shown.length} thread(s) shown${hidden ? `, ${hidden} resolved hidden` : ""}.`,
  ]
  return [header.join("\n"), ...shown.map((t) => formatThread(review, t, opts.context))].join("\n\n") + "\n"
}
