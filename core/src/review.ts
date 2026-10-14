import { randomBytes } from "node:crypto"
import { changedPaths, hunksBetween, mapLine } from "./diff"
import { configValue, git, gitTry, openRepo, readLines } from "./git"
import type { ReviewStore } from "./store"
import { resolveSpec } from "./target"
import { SCHEMA_VERSION, type Author, type Comment, type Position, type Review, type Revision, type Side, type Thread } from "./types"

const now = () => new Date().toISOString()

function newId(bytes: number, taken: Set<string> = new Set()): string {
  for (;;) {
    const id = randomBytes(bytes).toString("hex")
    if (!taken.has(id)) return id
  }
}

function takenIds(review: Review): Set<string> {
  return new Set(review.threads.flatMap((t) => [t.id, ...t.comments.map((c) => c.id)]))
}

export function latestRevision(review: Review): Revision {
  const rev = review.target.revisions[review.target.revisions.length - 1]
  if (!rev) throw new Error(`Review ${review.id} has no revisions`)
  return rev
}

export function revisionByNumber(review: Review, n: number): Revision {
  const rev = review.target.revisions.find((r) => r.n === n)
  if (!rev) throw new Error(`Review ${review.id} has no revision ${n}`)
  return rev
}

export function defaultAuthor(cwd: string): Author {
  return { name: configValue(cwd, "user.name") ?? process.env["USER"] ?? "unknown", kind: "human" }
}

export function detectAgent(env: Record<string, string | undefined>): string | undefined {
  const name = env["AI_AGENT"]?.trim()
  if (name) return name
  if (env["CLAUDECODE"] || env["CLAUDE_CODE"]) return "claude"
  if (env["CODEX_SANDBOX"] || env["CODEX_CI"] || env["CODEX_THREAD_ID"]) return "codex"
  if (env["OPENCODE"] || env["OPENCODE_CLIENT"]) return "opencode"
  return undefined
}

export function refPrefix(id: string): string {
  return `refs/git-feedback/${id}`
}

function pinRevision(cwd: string, id: string, rev: Revision): void {
  const input = [
    `update ${refPrefix(id)}/${rev.n}/base ${rev.base}`,
    `update ${refPrefix(id)}/${rev.n}/head ${rev.head}`,
    "",
  ].join("\n")
  git(["update-ref", "--stdin"], { cwd, input })
}

export function findThread(review: Review, idOrPrefix: string): Thread {
  const matches = review.threads.filter((t) => t.id.startsWith(idOrPrefix))
  if (matches.length !== 1) {
    throw new Error(matches.length ? `Thread id ${idOrPrefix} is ambiguous` : `No thread with id ${idOrPrefix}`)
  }
  return matches[0]!
}

export function findComment(review: Review, idOrPrefix: string): { thread: Thread; comment: Comment } {
  const matches = review.threads.flatMap((thread) =>
    thread.comments.filter((c) => c.id.startsWith(idOrPrefix)).map((comment) => ({ thread, comment })),
  )
  if (matches.length !== 1) {
    throw new Error(matches.length ? `Comment id ${idOrPrefix} is ambiguous` : `No comment with id ${idOrPrefix}`)
  }
  return matches[0]!
}

export interface StartOptions {
  spec: string[]
  title?: string
  /** Return an existing open review with the same spec and worktree instead of creating one. */
  reuse?: boolean
  /** Set the review id up front, for targets whose spec mentions the review's own refs. */
  id?: string
  github?: Review["github"]
}

export function startReview(store: ReviewStore, cwd: string, opts: StartOptions): { review: Review; created: boolean } {
  const { toplevel } = openRepo(cwd)
  if (opts.reuse !== false) {
    const existing = store
      .list()
      .find((r) => r.status === "open" && r.target.worktree === toplevel && JSON.stringify(r.target.spec) === JSON.stringify(opts.spec))
    if (existing) return { review: refreshReview(store, existing.id).review, created: false }
  }
  const { base, head } = resolveSpec(opts.spec, toplevel)
  const id = opts.id ?? newId(4, new Set(store.list().map((r) => r.id)))
  const createdAt = now()
  const revision: Revision = { n: 1, base, head, createdAt }
  pinRevision(toplevel, id, revision)
  const review: Review = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: opts.title ?? (opts.spec.length ? `git diff ${opts.spec.join(" ")}` : "git diff"),
    status: "open",
    createdAt,
    updatedAt: createdAt,
    target: { spec: opts.spec, worktree: toplevel, revisions: [revision] },
    threads: [],
    ...(opts.github ? { github: opts.github } : {}),
  }
  store.create(review)
  return { review, created: true }
}

type PathMaps = Map<string, Map<string, string | null>>

function sideObject(rev: Revision, side: Side): string {
  return side === "old" ? rev.base : rev.head
}

/** Move POSITION from its revision to TO; null when the anchored code changed or vanished. */
function mapPosition(cwd: string, review: Review, pos: Position, to: Revision, pathMaps: PathMaps): Position | null {
  const from = revisionByNumber(review, pos.revision)
  const side = pos.side ?? "new"
  const fromObj = sideObject(from, side)
  const toObj = sideObject(to, side)
  if (fromObj === toObj) return { ...pos, revision: to.n }

  const key = `${fromObj} ${toObj}`
  let paths = pathMaps.get(key)
  if (!paths) {
    paths = changedPaths(cwd, fromObj, toObj)
    pathMaps.set(key, paths)
  }
  const newPath = paths.has(pos.path) ? paths.get(pos.path)! : pos.path
  if (newPath === null) return null
  if (pos.line === undefined) return { ...pos, revision: to.n, path: newPath }

  const moved: Position = { ...pos, revision: to.n, path: newPath }
  if (!paths.has(pos.path)) return moved
  const hunks = hunksBetween(cwd, `${fromObj}:${pos.path}`, `${toObj}:${newPath}`)
  if (hunks === null) return null

  const start = pos.startLine ?? pos.line
  const mapped: number[] = []
  for (let l = start; l <= pos.line; l++) {
    const m = mapLine(hunks, l)
    if (m === null) return null
    mapped.push(m)
  }
  const first = mapped[0]!
  const last = mapped[mapped.length - 1]!
  if (last - first !== pos.line - start) return null
  moved.line = last
  if (pos.startLine !== undefined) moved.startLine = first
  return moved
}

/** Re-resolve the target; when it changed, record a revision and move threads onto it. */
export function refreshReview(store: ReviewStore, id: string): { review: Review; changed: boolean } {
  return store.mutate(id, (review) => {
    const cwd = review.target.worktree
    const { base, head } = resolveSpec(review.target.spec, cwd)
    const latest = latestRevision(review)
    if (latest.base === base && latest.head === head) return { review, changed: false }

    const revision: Revision = { n: latest.n + 1, base, head, createdAt: now() }
    pinRevision(cwd, review.id, revision)
    review.target.revisions.push(revision)

    const pathMaps: PathMaps = new Map()
    for (const thread of review.threads) {
      if (thread.outdated || !thread.position) continue
      const moved = mapPosition(cwd, review, thread.position, revision, pathMaps)
      if (moved) thread.position = moved
      else thread.outdated = true
    }
    return { review, changed: true }
  })
}

export interface Location {
  path: string
  side?: Side
  line?: number
  startLine?: number
}

export interface AddThreadOptions {
  location?: Location
  revision?: number
  body: string
  author: Author
}

function nonEmpty(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw new Error("Comment body is empty")
  return trimmed
}

export function addThread(store: ReviewStore, id: string, opts: AddThreadOptions): { review: Review; thread: Thread; comment: Comment } {
  const body = nonEmpty(opts.body)
  return store.mutate(id, (review) => {
    const rev = opts.revision === undefined ? latestRevision(review) : revisionByNumber(review, opts.revision)
    const cwd = review.target.worktree
    const taken = takenIds(review)
    const thread: Thread = {
      id: newId(3, taken),
      anchor: { kind: "review" },
      outdated: false,
      resolved: false,
      comments: [],
    }
    const loc = opts.location
    if (loc) {
      const side = loc.side ?? "new"
      const fileLines = readLines(cwd, sideObject(rev, side), loc.path)
      if (fileLines === null) throw new Error(`${loc.path} does not exist on the ${side} side of revision ${rev.n}`)
      if (loc.line === undefined) {
        thread.anchor = { kind: "file", revision: rev.n, path: loc.path }
        thread.position = { revision: rev.n, path: loc.path }
      } else {
        const start = loc.startLine ?? loc.line
        if (start < 1 || loc.line < start || loc.line > fileLines.length) {
          throw new Error(`Invalid line range ${start}-${loc.line} for ${loc.path} (${fileLines.length} lines)`)
        }
        const range = loc.startLine !== undefined && loc.startLine !== loc.line ? { startLine: loc.startLine } : {}
        thread.anchor = {
          kind: "line",
          revision: rev.n,
          path: loc.path,
          side,
          line: loc.line,
          ...range,
          lines: fileLines.slice(start - 1, loc.line),
        }
        thread.position = { revision: rev.n, path: loc.path, side, line: loc.line, ...range }
      }
      const latest = latestRevision(review)
      if (thread.position && rev.n !== latest.n) {
        const moved = mapPosition(cwd, review, thread.position, latest, new Map())
        if (moved) thread.position = moved
        else thread.outdated = true
      }
    }
    taken.add(thread.id)
    const comment: Comment = { id: newId(3, taken), author: opts.author, body, createdAt: now() }
    thread.comments.push(comment)
    review.threads.push(thread)
    return { review, thread, comment }
  })
}

export function reply(store: ReviewStore, id: string, threadId: string, body: string, author: Author) {
  const text = nonEmpty(body)
  return store.mutate(id, (review) => {
    const thread = findThread(review, threadId)
    const comment: Comment = { id: newId(3, takenIds(review)), author, body: text, createdAt: now() }
    thread.comments.push(comment)
    return { review, thread, comment }
  })
}

export function editComment(store: ReviewStore, id: string, commentId: string, body: string) {
  const text = nonEmpty(body)
  return store.mutate(id, (review) => {
    const { thread, comment } = findComment(review, commentId)
    comment.body = text
    comment.updatedAt = now()
    return { review, thread, comment }
  })
}

export function deleteComment(store: ReviewStore, id: string, commentId: string) {
  return store.mutate(id, (review) => {
    const { thread, comment } = findComment(review, commentId)
    if (comment.github) throw new Error("This comment is published on GitHub; delete it there instead")
    thread.comments = thread.comments.filter((c) => c !== comment)
    if (thread.comments.length === 0) review.threads = review.threads.filter((t) => t !== thread)
    return { review, thread, comment }
  })
}

export function setResolved(store: ReviewStore, id: string, threadId: string, resolved: boolean) {
  return store.mutate(id, (review) => {
    const thread = findThread(review, threadId)
    thread.resolved = resolved
    return { review, thread }
  })
}

export function setStatus(store: ReviewStore, id: string, status: Review["status"]) {
  return store.mutate(id, (review) => {
    review.status = status
    return { review }
  })
}

/** Delete review ID and its refs. Works on files this version cannot read. */
export function deleteReview(store: ReviewStore, id: string): void {
  if (!/^[0-9a-zA-Z_-]+$/.test(id)) throw new Error(`Invalid review id: ${id}`)
  const cwd = store.repo.toplevel
  const refs = gitTry(["for-each-ref", "--format=%(refname)", `${refPrefix(id)}/`], { cwd }) ?? ""
  const input = refs
    .split("\n")
    .filter(Boolean)
    .map((ref) => `delete ${ref}\n`)
    .join("")
  if (input) git(["update-ref", "--stdin"], { cwd, input })
  store.remove(id)
}
