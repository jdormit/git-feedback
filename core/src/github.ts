import { randomBytes } from "node:crypto"
import { changedPaths, hunksBetween, rangeInOneHunk, type Hunk } from "./diff"
import { git, gitTry, readLines } from "./git"
import { latestRevision, refPrefix, refreshReview, startReview } from "./review"
import type { ReviewStore } from "./store"
import type { Author, Comment, GitHubCommentLink, GitHubLink, Review, Side, Thread } from "./types"

export interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<any>
  /** GET every page of a list endpoint. */
  paginate(path: string): Promise<any[]>
  graphql(query: string, variables: Record<string, unknown>): Promise<any>
}

export interface PrRef {
  host?: string
  repo?: string
  number: number
}

export type FullPrRef = Required<PrRef>

export function parsePrRef(arg: string): PrRef {
  const url = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(arg)
  if (url) return { host: url[1]!, repo: url[2]!, number: Number(url[3]) }
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(arg)
  if (short) return { host: process.env["GH_HOST"] ?? "github.com", repo: short[1]!, number: Number(short[2]) }
  const bare = /^#?(\d+)$/.exec(arg)
  if (bare) return { number: Number(bare[1]) }
  throw new Error(`Not a pull request reference: ${arg}`)
}

async function spawnText(cmd: string[], input?: string, cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.slice(0, 4).join(" ")} failed: ${(err || out).trim()}`)
  return out
}

/** Fill in the repository of a bare PR number from `gh`'s default repo for CWD. */
export async function completePrRef(ref: PrRef, cwd: string): Promise<FullPrRef> {
  if (ref.repo && ref.host) return ref as FullPrRef
  const out = await spawnText(["gh", "repo", "view", "--json", "nameWithOwner,url"], undefined, cwd)
  const info = JSON.parse(out) as { nameWithOwner: string; url: string }
  return { host: new URL(info.url).host, repo: info.nameWithOwner, number: ref.number }
}

/** A GitHubApi backed by the `gh` CLI, which handles authentication. */
export function ghApi(host: string): GitHubApi {
  const run = async (args: string[], input?: string) => {
    const out = await spawnText(["gh", "api", "--hostname", host, ...args], input)
    return out.trim() ? JSON.parse(out) : null
  }
  return {
    request: (method, path, body) =>
      run(["-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body)),
    paginate: async (path) => ((await run(["--paginate", "--slurp", path])) as any[][]).flat(),
    graphql: async (query, variables) => {
      const res = await run(["graphql", "--input", "-"], JSON.stringify({ query, variables }))
      if (res?.errors?.length) throw new Error(`GitHub GraphQL error: ${res.errors.map((e: any) => e.message).join("; ")}`)
      return res.data
    },
  }
}

function linkOf(review: Review): GitHubLink {
  if (!review.github) throw new Error(`Review ${review.id} is not linked to a GitHub pull request`)
  return review.github
}

function sameRepo(a: { host: string; repo: string }, b: { host: string; repo: string }) {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
}

/** The remote whose URL points at HOST/REPO, falling back to origin, then to an HTTPS URL. */
export function findRemote(cwd: string, host: string, repo: string): string {
  const out = gitTry(["remote", "-v"], { cwd }) ?? ""
  const want = `${host}/${repo}`.toLowerCase()
  for (const line of out.split("\n")) {
    const [name, url] = line.split(/\s+/)
    if (!name || !url) continue
    const normalized = url
      .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, "")
      .replace(/^[^@/]+@([^:]+):/, "$1/")
      .replace(/\.git$/, "")
      .toLowerCase()
    if (normalized === want || normalized.replace(/:\d+\//, "/") === want) return name
  }
  if (out.split("\n").some((l) => l.startsWith("origin\t"))) return "origin"
  return `https://${host}/${repo}.git`
}

function githubRefs(id: string) {
  return { base: `${refPrefix(id)}/github/base`, head: `${refPrefix(id)}/github/head` }
}

function fetchPr(cwd: string, id: string, link: GitHubLink, baseRef: string): void {
  const refs = githubRefs(id)
  const remote = findRemote(cwd, link.host, link.repo)
  git(
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+refs/pull/${link.number}/head:${refs.head}`, `+refs/heads/${baseRef}:${refs.base}`],
    { cwd },
  )
}

function fetchMergeBase(cwd: string, id: string, link: GitHubLink, baseRef: string): string {
  fetchPr(cwd, id, link, baseRef)
  const refs = githubRefs(id)
  return git(["merge-base", refs.base, refs.head], { cwd }).trim()
}

async function getPr(api: GitHubApi, link: Pick<GitHubLink, "repo" | "number">) {
  return (await api.request("GET", `/repos/${link.repo}/pulls/${link.number}`)) as {
    number: number
    title: string
    html_url: string
    head: { sha: string }
    base: { ref: string }
  }
}

/** Start (or resume) a review of a pull request, fetching its commits into review refs. */
export async function githubStart(store: ReviewStore, cwd: string, api: GitHubApi, ref: FullPrRef): Promise<Review> {
  const existing = store
    .list()
    .find((r) => r.status === "open" && r.github && sameRepo(r.github, ref) && r.github.number === ref.number)
  if (existing) {
    await githubPull(store, existing.id, api)
    return store.load(existing.id)
  }
  const pr = await getPr(api, ref)
  const link: GitHubLink = { host: ref.host, repo: ref.repo, number: ref.number, url: pr.html_url, title: pr.title }
  const id = randomBytes(4).toString("hex")
  const refs = githubRefs(id)
  fetchPr(cwd, id, link, pr.base.ref)
  const { review } = startReview(store, cwd, {
    id,
    spec: [`${refs.base}...${refs.head}`],
    title: `PR #${pr.number}: ${pr.title}`,
    reuse: false,
    github: link,
  })
  await githubPull(store, review.id, api, { fetch: false })
  return store.load(review.id)
}

export async function githubLink(store: ReviewStore, id: string, api: GitHubApi, ref: FullPrRef): Promise<Review> {
  const pr = await getPr(api, ref)
  return store.mutate(id, (review) => {
    review.github = { host: ref.host, repo: ref.repo, number: ref.number, url: pr.html_url, title: pr.title }
    return review
  })
}

// ---------------------------------------------------------------------------
// Pull

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide subjectType
          comments(first: 100) {
            totalCount
            nodes {
              databaseId url body createdAt diffHunk
              author { login __typename }
              pullRequestReview { state }
            }
          }
        }
      }
    }
  }
}`

interface RemoteComment {
  databaseId: number
  url: string
  body: string
  createdAt: string
  diffHunk?: string
  author: { login: string; __typename: string } | null
  pullRequestReview: { state: string } | null
}

export interface RemoteThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  startLine: number | null
  originalLine: number | null
  originalStartLine: number | null
  diffSide: "LEFT" | "RIGHT"
  startDiffSide: "LEFT" | "RIGHT" | null
  subjectType: "LINE" | "FILE"
  comments: { totalCount?: number; nodes: RemoteComment[] }
}

export interface ConversationItem {
  id: number
  kind: "issue-comment" | "review"
  body: string
  createdAt: string
  url?: string
  author: Author
}

export interface PullData {
  headSha: string
  threads: RemoteThread[]
  conversation: ConversationItem[]
}

async function fetchThreads(api: GitHubApi, link: GitHubLink): Promise<RemoteThread[]> {
  const [owner, name] = link.repo.split("/")
  const threads: RemoteThread[] = []
  let cursor: string | null = null
  do {
    const data: any = await api.graphql(THREADS_QUERY, { owner, name, number: link.number, cursor })
    const page = data.repository.pullRequest.reviewThreads
    threads.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return threads
}

function authorOf(user: { login?: string; type?: string; __typename?: string } | null | undefined): Author {
  const login = user?.login ?? "ghost"
  const bot = user?.type === "Bot" || user?.__typename === "Bot" || login.endsWith("[bot]")
  return { name: login, kind: bot ? "agent" : "human" }
}

async function fetchPullData(api: GitHubApi, link: GitHubLink): Promise<PullData> {
  const base = `/repos/${link.repo}`
  const [pr, threads, issueComments, reviews] = await Promise.all([
    getPr(api, link),
    fetchThreads(api, link),
    api.paginate(`${base}/issues/${link.number}/comments?per_page=100`),
    api.paginate(`${base}/pulls/${link.number}/reviews?per_page=100`),
  ])
  const conversation: ConversationItem[] = [
    ...issueComments.map((c: any) => ({
      id: c.id,
      kind: "issue-comment" as const,
      body: c.body ?? "",
      createdAt: c.created_at,
      url: c.html_url,
      author: authorOf(c.user),
    })),
    ...reviews
      .filter((r: any) => r.body && r.state !== "PENDING")
      .map((r: any) => ({
        id: r.id,
        kind: "review" as const,
        body: r.body,
        createdAt: r.submitted_at,
        url: r.html_url,
        author: authorOf(r.user),
      })),
  ]
  return { headSha: pr.head.sha, threads, conversation }
}

const linkKey = (g: Pick<GitHubCommentLink, "kind" | "id">) => `${g.kind === "issue-comment" ? "issue" : g.kind}:${g.id}`

function newLocalId(review: Review): string {
  const taken = new Set(review.threads.flatMap((t) => [t.id, ...t.comments.map((c) => c.id)]))
  for (;;) {
    const id = randomBytes(3).toString("hex")
    if (!taken.has(id)) return id
  }
}

/** Merge remote comments into THREAD; drop local copies of comments deleted remotely. */
function mergeComments(review: Review, thread: Thread, remote: Array<{ link: GitHubCommentLink; author: Author; createdAt: string }>, prune: (c: Comment) => boolean) {
  const byKey = new Map(thread.comments.filter((c) => c.github).map((c) => [linkKey(c.github!), c]))
  const seen = new Set<string>()
  for (const r of remote) {
    const key = linkKey(r.link)
    seen.add(key)
    const local = byKey.get(key)
    if (local) {
      // Take a remote edit unless the comment was also edited locally; push sends local edits.
      if (r.link.body !== local.github!.body) {
        if (local.body === local.github!.body) local.body = r.link.body
        local.github = { ...r.link }
      }
      continue
    }
    thread.comments.push({ id: newLocalId(review), author: r.author, body: r.link.body, createdAt: r.createdAt, github: r.link })
  }
  thread.comments = thread.comments.filter((c) => !c.github || !prune(c) || seen.has(linkKey(c.github)))
  thread.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Apply fetched GitHub state to REVIEW. Pure except for reading anchored text from git. */
export function applyPull(review: Review, data: PullData): { added: number; placed: boolean } {
  const latest = latestRevision(review)
  const placeable = latest.head === data.headSha
  const cwd = review.target.worktree
  let added = 0

  const threadByComment = new Map<string, Thread>()
  for (const t of review.threads) for (const c of t.comments) if (c.github) threadByComment.set(linkKey(c.github), t)

  const remoteThreadIds = new Set<string>()
  for (const remote of data.threads) {
    const comments = remote.comments.nodes.filter((c) => c.pullRequestReview?.state !== "PENDING")
    if (comments.length === 0) continue
    remoteThreadIds.add(remote.id)
    const links = comments.map((c) => ({
      link: { id: c.databaseId, kind: "review-comment" as const, url: c.url, body: c.body },
      author: authorOf(c.author),
      createdAt: c.createdAt,
    }))
    let thread =
      review.threads.find((t) => t.github?.threadId === remote.id) ??
      links.map((l) => threadByComment.get(linkKey(l.link))).find((t) => t !== undefined)

    if (!thread) {
      thread = remoteThreadToLocal(review, remote, cwd, latest.n, latest, placeable)
      thread.github = { kind: "review-thread", resolved: remote.isResolved }
      thread.resolved = remote.isResolved
      review.threads.push(thread)
      added++
    }
    const gh = (thread.github ??= { kind: "review-thread" })
    gh.threadId = remote.id
    gh.rootCommentId ??= comments[0]!.databaseId
    if (comments[0]!.diffHunk) gh.diffHunk ??= comments[0]!.diffHunk
    if (gh.resolved === undefined) gh.resolved = remote.isResolved
    else if (gh.resolved !== remote.isResolved) {
      thread.resolved = remote.isResolved
      gh.resolved = remote.isResolved
    }
    const complete = (remote.comments.totalCount ?? 0) <= remote.comments.nodes.length
    mergeComments(review, thread, links, (c) => complete && c.github!.kind === "review-comment")
  }

  for (const thread of review.threads) {
    if (thread.github?.kind !== "review-thread" || !thread.github.threadId || remoteThreadIds.has(thread.github.threadId)) continue
    thread.comments = thread.comments.filter((c) => !c.github)
    delete thread.github
  }
  review.threads = review.threads.filter((t) => t.comments.length > 0)

  let convo = review.threads.find((t) => t.github?.kind === "conversation")
  const items = data.conversation.filter((item) => {
    const owner = threadByComment.get(`${item.kind === "issue-comment" ? "issue" : "review"}:${item.id}`)
    return !owner || owner === convo
  })
  if (!convo && items.length > 0) {
    convo = { id: newLocalId(review), anchor: { kind: "review" }, outdated: false, resolved: false, comments: [], github: { kind: "conversation" } }
    review.threads.push(convo)
    added++
  }
  if (convo) {
    mergeComments(
      review,
      convo,
      items.map((item) => ({ link: { id: item.id, kind: item.kind, url: item.url, body: item.body }, author: item.author, createdAt: item.createdAt })),
      () => true,
    )
  }
  return { added, placed: placeable }
}

function remoteThreadToLocal(review: Review, remote: RemoteThread, cwd: string, n: number, latest: { base: string; head: string }, placeable: boolean): Thread {
  const id = newLocalId(review)
  const base: Thread = { id, anchor: { kind: "review" }, outdated: false, resolved: false, comments: [] }
  if (remote.subjectType === "FILE") {
    base.anchor = { kind: "file", revision: n, path: remote.path }
    base.position = { revision: n, path: remote.path }
    return base
  }
  const side: Side = remote.diffSide === "LEFT" ? "old" : "new"
  const current = remote.isOutdated || !placeable ? null : remote.line
  const line = current ?? remote.originalLine ?? 1
  const startLine = (current ? remote.startLine : remote.originalStartLine) ?? undefined
  const range = startLine !== undefined && startLine !== line ? { startLine } : {}
  const text = current ? readLines(cwd, side === "old" ? latest.base : latest.head, remote.path) : null
  base.anchor = { kind: "line", revision: n, path: remote.path, side, line, ...range, lines: text ? text.slice((startLine ?? line) - 1, line) : [] }
  base.position = { revision: n, path: remote.path, side, line, ...range }
  base.outdated = current === null
  return base
}

export interface PullOptions {
  /** Re-fetch the PR refs and refresh the review first. Defaults to true. */
  fetch?: boolean
}

export async function githubPull(store: ReviewStore, id: string, api: GitHubApi, opts: PullOptions = {}) {
  const review = store.load(id)
  const link = linkOf(review)
  if (opts.fetch !== false) {
    const refs = githubRefs(id)
    if (review.target.spec.some((arg) => arg.includes(refs.head))) {
      const pr = await getPr(api, link)
      fetchPr(review.target.worktree, id, link, pr.base.ref)
    }
    refreshReview(store, id)
  }
  const data = await fetchPullData(api, link)
  return store.mutate(id, (r) => applyPull(r, data))
}

// ---------------------------------------------------------------------------
// Push

export type ReviewEvent = "approve" | "request-changes" | "comment"

export interface PushOptions {
  event?: ReviewEvent
  body?: string
}

export interface PushResult {
  reviewComments: number
  fileComments: number
  replies: number
  issueComments: number
  edits: number
  resolved: number
  skipped: string[]
}

const EVENTS: Record<ReviewEvent, string> = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" }

/** Hunks of the PR diff (three lines of context) for the file at PATH on SIDE. */
function prHunks(cwd: string, base: string, head: string, side: Side, path: string, paths: Map<string, string | null>): Hunk[] {
  let oldPath = path
  let newPath: string | null = path
  if (side === "new") oldPath = [...paths].find(([, to]) => to === path)?.[0] ?? path
  else newPath = paths.has(path) ? paths.get(path)! : path
  const ALL = 1e9
  const inBase = readLines(cwd, base, oldPath) !== null
  if (!inBase) return [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: ALL }]
  if (!paths.has(oldPath)) return []
  if (newPath === null || readLines(cwd, head, newPath) === null) return [{ oldStart: 1, oldCount: ALL, newStart: 0, newCount: 0 }]
  return hunksBetween(cwd, `${base}:${oldPath}`, `${head}:${newPath}`, 3) ?? []
}

function lineLabel(start: number | undefined, line: number) {
  return start !== undefined && start !== line ? `Lines ${start}–${line}` : `Line ${line}`
}

interface PlannedComment {
  threadId: string
  commentId: string
  path: string
  body: string
  payload?: Record<string, unknown>
}

export async function githubPush(store: ReviewStore, id: string, api: GitHubApi, opts: PushOptions): Promise<PushResult> {
  const review = store.load(id)
  const link = linkOf(review)
  const cwd = review.target.worktree
  const base = `/repos/${link.repo}`
  const pr = await getPr(api, link)
  const latest = latestRevision(review)
  const result: PushResult = { reviewComments: 0, fileComments: 0, replies: 0, issueComments: 0, edits: 0, resolved: 0, skipped: [] }

  let prMergeBase: string | undefined
  const fresh = review.threads.filter((t) => !t.github && t.anchor.kind !== "review" && t.comments[0] && !t.comments[0].github)
  const inline: PlannedComment[] = []
  const fileLevel: PlannedComment[] = []
  const paths = changedPaths(cwd, latest.base, latest.head)
  for (const t of fresh) {
    const pos = t.position
    if (t.outdated || !pos || pos.revision !== latest.n) {
      result.skipped.push(`${t.id}: outdated; reply or re-comment on the current code`)
      continue
    }
    if (latest.head !== pr.head.sha) {
      throw new Error(`Review is at ${latest.head.slice(0, 10)} but the PR head is ${pr.head.sha.slice(0, 10)}; run \`fdbk github pull\` first`)
    }
    prMergeBase ??= fetchMergeBase(cwd, id, link, pr.base.ref)
    if (latest.base !== prMergeBase) {
      throw new Error(
        `Review base ${latest.base.slice(0, 10)} is not the PR's merge base ${prMergeBase.slice(0, 10)}, so line numbers would not match GitHub's diff`,
      )
    }
    const first = t.comments[0]!
    const planned = { threadId: t.id, commentId: first.id, path: pos.path, body: first.body }
    if (pos.line === undefined) {
      fileLevel.push(planned)
      continue
    }
    const side = pos.side ?? "new"
    const hunks = prHunks(cwd, latest.base, latest.head, side, pos.path, paths)
    const visible = rangeInOneHunk(hunks, side, pos.startLine ?? pos.line, pos.line)
    if (!visible) {
      fileLevel.push({ ...planned, body: `**${lineLabel(pos.startLine, pos.line)}** (outside the diff):\n\n${first.body}` })
      continue
    }
    const ghSide = side === "old" ? "LEFT" : "RIGHT"
    inline.push({
      ...planned,
      payload: {
        path: pos.path,
        line: pos.line,
        side: ghSide,
        ...(pos.startLine !== undefined ? { start_line: pos.startLine, start_side: ghSide } : {}),
        body: first.body,
      },
    })
  }

  const linkComment = (threadId: string, commentId: string, github: GitHubCommentLink, threadLink?: Thread["github"]) =>
    store.mutate(id, (r) => {
      const thread = r.threads.find((t) => t.id === threadId)
      const comment = thread?.comments.find((c) => c.id === commentId)
      if (!thread || !comment) return
      comment.body = github.body
      comment.github = github
      if (threadLink) thread.github = threadLink
    })

  const event = opts.event ? EVENTS[opts.event] : "COMMENT"
  const body = opts.body?.trim() ?? ""
  if (inline.length > 0 || event !== "COMMENT" || body) {
    const created = await api.request("POST", `${base}/pulls/${link.number}/reviews`, {
      commit_id: pr.head.sha,
      event,
      ...(body ? { body } : {}),
      comments: inline.map((c) => c.payload),
    })
    const remote = (await api.paginate(`${base}/pulls/${link.number}/reviews/${created.id}/comments?per_page=100`)) as any[]
    const used = new Set<number>()
    for (const c of inline) {
      const match = remote.find((rc) => !used.has(rc.id) && rc.path === c.path && rc.body.trim() === c.body.trim())
      if (!match) continue
      used.add(match.id)
      linkComment(c.threadId, c.commentId, { id: match.id, kind: "review-comment", url: match.html_url, body: match.body }, {
        kind: "review-thread",
        rootCommentId: match.id,
        resolved: false,
      })
      result.reviewComments++
    }
  }

  for (const c of fileLevel) {
    const created = await api.request("POST", `${base}/pulls/${link.number}/comments`, {
      body: c.body,
      commit_id: pr.head.sha,
      path: c.path,
      subject_type: "file",
    })
    linkComment(c.threadId, c.commentId, { id: created.id, kind: "review-comment", url: created.html_url, body: created.body }, {
      kind: "review-thread",
      rootCommentId: created.id,
      resolved: false,
    })
    result.fileComments++
  }

  for (const thread of store.load(id).threads) {
    for (const comment of thread.comments) {
      if (comment.github) continue
      if (thread.anchor.kind === "review") {
        const created = await api.request("POST", `${base}/issues/${link.number}/comments`, { body: comment.body })
        linkComment(thread.id, comment.id, { id: created.id, kind: "issue-comment", url: created.html_url, body: created.body })
        result.issueComments++
      } else if (thread.github?.rootCommentId) {
        const created = await api.request("POST", `${base}/pulls/${link.number}/comments/${thread.github.rootCommentId}/replies`, {
          body: comment.body,
        })
        linkComment(thread.id, comment.id, { id: created.id, kind: "review-comment", url: created.html_url, body: created.body })
        result.replies++
      }
    }
  }

  for (const thread of store.load(id).threads) {
    for (const comment of thread.comments) {
      const gh = comment.github
      if (!gh || comment.body === gh.body) continue
      const path =
        gh.kind === "issue-comment"
          ? `${base}/issues/comments/${gh.id}`
          : gh.kind === "review"
            ? `${base}/pulls/${link.number}/reviews/${gh.id}`
            : `${base}/pulls/comments/${gh.id}`
      const updated = await api.request(gh.kind === "review" ? "PUT" : "PATCH", path, { body: comment.body })
      linkComment(thread.id, comment.id, { ...gh, body: updated?.body ?? comment.body })
      result.edits++
    }
  }

  await githubPull(store, id, api, { fetch: false })

  for (const thread of store.load(id).threads) {
    const gh = thread.github
    if (!gh?.threadId || gh.resolved === undefined || gh.resolved === thread.resolved) continue
    const mutation = thread.resolved ? "resolveReviewThread" : "unresolveReviewThread"
    await api.graphql(`mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { isResolved } } }`, {
      threadId: gh.threadId,
    })
    store.mutate(id, (r) => {
      const t = r.threads.find((x) => x.id === thread.id)
      if (t?.github) t.github.resolved = thread.resolved
    })
    result.resolved++
  }
  return result
}
