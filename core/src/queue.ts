import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { configValue, git, gitTry, openRepo } from "./git"
import type { GitHubApi } from "./github"
import { latestRevision } from "./review"
import { ReviewStore } from "./store"
import { parseSpec, resolveSpec, worktreeTree } from "./target"
import type { Review } from "./types"

const DAY_MS = 86_400_000
const FAMILIAR_DAYS = 90
const MAX_PULL_REQUESTS = 300

export interface AgentSession {
  id: string
  title: string
  directory: string
  updatedAt: string
  running: boolean
}

export interface DiffSize {
  files: number
  additions: number
  deletions: number
}

export interface PullRequestItem {
  kind: "pull-request"
  /** Stable across refreshes; `version` changes when there is something new to look at. */
  id: string
  version: string
  repo: string
  dir: string
  number: number
  title: string
  url: string
  author: string
  authorIsBot: boolean
  createdAt: string
  updatedAt: string
  branch: string
  size: DiffSize
  state: "unreviewed" | "changed-since-review" | "reviewed"
  requested: "you" | "team" | null
  authorOnTeam: boolean
  /** Changed files you committed to recently. */
  familiarFiles: number
  /** Approvals from people other than you. */
  approvals: number
  review?: string
}

export interface AgentItem {
  kind: "agent"
  id: string
  version: string
  repo: string
  dir: string
  branch: string | null
  title: string
  updatedAt: string
  state: "unreviewed" | "changed-since-review" | "agent-replied"
  running: boolean
  sessions: AgentSession[]
  size: DiffSize
  /** `git diff` arguments to start a review with, run in `dir`. */
  spec: string[]
  review?: { id: string; title: string; unresolved: number; agentReplies: number }
}

export type QueueItem = AgentItem | PullRequestItem

export interface Queue {
  generatedAt: string
  items: QueueItem[]
  warnings: string[]
}

export interface QueueOptions {
  /** Local clones to look in. */
  repos: string[]
  /** Only agent sessions active within this many days count. */
  days?: number
}

export interface QueueDeps {
  github: (host: string) => GitHubApi
  sessions: () => Promise<AgentSession[]>
  now?: Date
}

interface RepoInfo {
  dir: string
  host: string
  repo: string
  baseRef: string
}

function repoInfo(dir: string): RepoInfo {
  const { toplevel } = openRepo(dir)
  const url = configValue(toplevel, "remote.origin.url")
  const match = url && /^(?:[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/]+@([^:]+):)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new Error(`${toplevel}: origin is not a GitHub remote`)
  const headRef = gitTry(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: toplevel })?.trim()
  return { dir: toplevel, host: (match[1] ?? match[2])!, repo: match[3]!, baseRef: headRef || "origin/main" }
}

function diffSize(cwd: string, args: string[]): DiffSize {
  const out = git(["diff", "--shortstat", ...args], { cwd })
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0)
  return { files: num(/(\d+) files? changed/), additions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) }
}

// ---------------------------------------------------------------------------
// Agent work

interface Worktree {
  path: string
  head: string
  branch: string | null
}

function worktrees(dir: string): Worktree[] {
  const out = git(["worktree", "list", "--porcelain"], { cwd: dir })
  return out
    .split("\n\n")
    .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)])))
    .filter((w) => w["worktree"] && w["HEAD"] && !("bare" in w) && !("prunable" in w) && existsSync(w["worktree"]))
    .map((w) => ({ path: realpathSync(w["worktree"]!), head: w["HEAD"]!, branch: w["branch"]?.replace(/^refs\/heads\//, "") ?? null }))
}

/** The worktree containing DIRECTORY, preferring the most deeply nested one. */
function worktreeFor(trees: Worktree[], directory: string): Worktree | undefined {
  return trees
    .filter((w) => directory === w.path || directory.startsWith(w.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

function sessionsByWorktree(trees: Worktree[], sessions: AgentSession[]): Map<string, AgentSession[]> {
  const result = new Map<string, AgentSession[]>()
  for (const s of sessions) {
    const tree = worktreeFor(trees, s.directory)
    if (tree) result.set(tree.path, [...(result.get(tree.path) ?? []), s])
  }
  return result
}

function sessionSummary(sessions: AgentSession[]) {
  const newest = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { latest: newest[0], title: newest.find((s) => s.title)?.title, running: sessions.some((s) => s.running) }
}

function unreviewedWorktree(info: RepoInfo, tree: Worktree, sessions: AgentSession[]): AgentItem | null {
  const base = gitTry(["merge-base", info.baseRef, "HEAD"], { cwd: tree.path })?.trim()
  if (!base) return null
  const ahead = Number(git(["rev-list", "--count", `${base}..HEAD`], { cwd: tree.path }).trim())
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: tree.path }).trim() !== ""
  if (!ahead && !dirty) return null
  const sizeArgs = dirty ? [base] : [base, "HEAD"]
  const size = diffSize(tree.path, sizeArgs)
  const { latest, title, running } = sessionSummary(sessions)
  return {
    kind: "agent",
    id: `worktree:${tree.path}`,
    version: dirty ? worktreeTree(tree.path) : tree.head,
    repo: info.repo,
    dir: tree.path,
    branch: tree.branch,
    title: title ?? tree.branch ?? tree.path,
    updatedAt: latest!.updatedAt,
    state: "unreviewed",
    running,
    sessions,
    size,
    spec: dirty ? [base] : [`${info.baseRef}...HEAD`],
  }
}

/** Whether SPEC depends on what is checked out in WORKTREE, rather than only on named commits. */
function specUsesWorktree(spec: string[], worktree: string): boolean {
  const { revs } = parseSpec(spec, worktree)
  if (revs.length !== 1) return revs.length === 0
  const range = /^(.*?)\.\.\.?(.*)$/.exec(revs[0]!)
  if (!range) return !revs[0]!.endsWith("^!")
  return [range[1], range[2]].some((side) => !side || side === "HEAD")
}

function reviewItem(info: RepoInfo, review: Review, trees: Worktree[], sessions: AgentSession[]): AgentItem | null {
  const unresolved = review.threads.filter((t) => !t.resolved)
  const agentReplies = unresolved.filter((t) => t.comments[t.comments.length - 1]?.author.kind === "agent").length
  const worktree = review.target.worktree
  if (!existsSync(worktree)) return null
  let current: { base: string; head: string }
  try {
    current = resolveSpec(review.target.spec, worktree)
  } catch {
    return null
  }
  const latest = latestRevision(review)
  const changed = current.base !== latest.base || current.head !== latest.head
  if (!agentReplies && !changed) return null
  const { latest: session, running } = sessionSummary(sessions)
  return {
    kind: "agent",
    id: `review:${review.id}`,
    version: `${current.head}:${review.updatedAt}`,
    repo: info.repo,
    dir: worktree,
    branch: specUsesWorktree(review.target.spec, worktree) ? (worktreeFor(trees, worktree)?.branch ?? null) : null,
    title: review.title,
    updatedAt: [review.updatedAt, session?.updatedAt ?? ""].sort().pop()!,
    state: agentReplies ? "agent-replied" : "changed-since-review",
    running,
    sessions,
    size: diffSize(worktree, [current.base, current.head]),
    spec: review.target.spec,
    review: { id: review.id, title: review.title, unresolved: unresolved.length, agentReplies },
  }
}

function agentItems(info: RepoInfo, reviews: Review[], sessions: AgentSession[]): AgentItem[] {
  const trees = worktrees(info.dir)
  const byTree = sessionsByWorktree(trees, sessions)
  const local = reviews.filter((r) => !r.github)
  const items: AgentItem[] = local.flatMap((r) => reviewItem(info, r, trees, byTree.get(worktreeFor(trees, r.target.worktree)?.path ?? "") ?? []) ?? [])
  const reviewed = new Set(
    local.filter((r) => existsSync(r.target.worktree) && specUsesWorktree(r.target.spec, r.target.worktree)).map((r) => worktreeFor(trees, r.target.worktree)?.path),
  )
  for (const tree of trees) {
    const treeSessions = byTree.get(tree.path)
    if (!treeSessions || reviewed.has(tree.path)) continue
    const item = unreviewedWorktree(info, tree, treeSessions)
    if (item) items.push(item)
  }
  return items
}

// ---------------------------------------------------------------------------
// Pull requests

const VIEWER_QUERY = `query { viewer { login } }`

const TEAMS_QUERY = `
query($org: String!, $login: String!) {
  organization(login: $org) {
    teams(first: 100, userLogins: [$login]) {
      nodes { slug members(first: 100) { nodes { login } } }
    }
  }
}`

const SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url createdAt updatedAt additions deletions changedFiles headRefName headRefOid
        author { login __typename }
        files(first: 100) { nodes { path } }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
        latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
      }
    }
  }
}`

interface Viewer {
  login: string
  teams: Set<string>
  teammates: Set<string>
}

async function viewer(api: GitHubApi, org: string): Promise<Viewer> {
  const login = (await api.graphql(VIEWER_QUERY, {})).viewer.login as string
  let teams: Array<{ slug: string; members: { nodes: Array<{ login: string }> } }> = []
  try {
    teams = (await api.graphql(TEAMS_QUERY, { org, login })).organization?.teams.nodes ?? []
  } catch {
    // Repositories owned by a user rather than an organization have no teams.
  }
  return {
    login,
    teams: new Set(teams.map((t) => t.slug)),
    teammates: new Set(teams.flatMap((t) => t.members.nodes.map((m) => m.login)).filter((l) => l !== login)),
  }
}

function familiarPaths(info: RepoInfo, now: Date): Set<string> {
  const email = configValue(info.dir, "user.email")
  if (!email) return new Set()
  const since = new Date(now.getTime() - FAMILIAR_DAYS * DAY_MS).toISOString()
  const out = gitTry(["log", "--fixed-strings", `--since=${since}`, `--author=${email}`, "--format=", "--name-only", info.baseRef], { cwd: info.dir }) ?? ""
  return new Set(out.split("\n").filter(Boolean))
}

async function searchPullRequests(api: GitHubApi, q: string): Promise<any[]> {
  const prs: any[] = []
  let cursor: string | null = null
  do {
    const { search } = await api.graphql(SEARCH_QUERY, { q, cursor })
    prs.push(...search.nodes.filter((n: any) => n?.number))
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
  } while (cursor && prs.length < MAX_PULL_REQUESTS)
  return prs
}

async function pullRequestItems(info: RepoInfo, api: GitHubApi, reviews: Review[], now: Date): Promise<PullRequestItem[]> {
  const me = await viewer(api, info.repo.split("/")[0]!)
  const prs = await searchPullRequests(api, `repo:${info.repo} is:pr is:open draft:false -author:${me.login}`)
  const familiar = familiarPaths(info, now)
  const items: PullRequestItem[] = []
  for (const pr of prs) {
    const reviewers = (pr.reviewRequests?.nodes ?? []).map((n: any) => n.requestedReviewer).filter(Boolean)
    const requested = reviewers.some((r: any) => r.login === me.login)
      ? "you"
      : reviewers.some((r: any) => me.teams.has(r.slug))
        ? "team"
        : null
    const latest = pr.latestReviews?.nodes ?? []
    const mine = latest.find((r: any) => r.author?.login === me.login && r.state !== "PENDING")
    const state = !mine ? "unreviewed" : mine.commit?.oid === pr.headRefOid ? "reviewed" : "changed-since-review"
    if (state === "reviewed" && !requested) continue
    const author = pr.author?.login ?? "ghost"
    const review = reviews.find((r) => r.github && r.github.repo.toLowerCase() === info.repo.toLowerCase() && r.github.number === pr.number)
    items.push({
      kind: "pull-request",
      id: `${info.host}/${info.repo}#${pr.number}`,
      version: pr.headRefOid,
      repo: info.repo,
      dir: info.dir,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author,
      authorIsBot: pr.author?.__typename === "Bot",
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      branch: pr.headRefName,
      size: { files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions },
      state,
      requested,
      authorOnTeam: me.teammates.has(author),
      familiarFiles: (pr.files?.nodes ?? []).filter((f: any) => familiar.has(f.path)).length,
      approvals: latest.filter((r: any) => r.state === "APPROVED" && r.author?.login !== me.login).length,
      ...(review ? { review: review.id } : {}),
    })
  }
  return items
}

// ---------------------------------------------------------------------------

/** Collect agent work and pull requests waiting for your review across REPOS. */
export async function buildQueue(opts: QueueOptions, deps: QueueDeps): Promise<Queue> {
  const now = deps.now ?? new Date()
  const cutoff = new Date(now.getTime() - (opts.days ?? 7) * DAY_MS).toISOString()
  const warnings: string[] = []
  const sessions = (
    await deps.sessions().catch((e: Error) => {
      warnings.push(`Could not list agent sessions: ${e.message}`)
      return []
    })
  )
    .filter((s) => s.updatedAt >= cutoff)
    .map((s) => ({ ...s, directory: existsSync(s.directory) ? realpathSync(s.directory) : s.directory }))

  const repos = opts.repos.flatMap((dir) => {
    try {
      const info = repoInfo(dir)
      const reviews = new ReviewStore(openRepo(info.dir)).list().filter((r) => r.status === "open")
      return [{ info, reviews }]
    } catch (e) {
      warnings.push(`${dir}: ${(e as Error).message}`)
      return []
    }
  })
  const pulls = repos.map(({ info, reviews }) =>
    pullRequestItems(info, deps.github(info.host), reviews, now).catch((e: Error) => {
      warnings.push(`${info.repo}: could not search pull requests: ${e.message}`)
      return []
    }),
  )
  const items: QueueItem[] = repos.flatMap(({ info, reviews }) => {
    try {
      return agentItems(info, reviews, sessions)
    } catch (e) {
      warnings.push(`${info.dir}: could not list agent work: ${(e as Error).message}`)
      return []
    }
  })
  for (const p of pulls) items.push(...(await p))
  return { generatedAt: now.toISOString(), items, warnings }
}

/** Root sessions from the shared OpenCode service, or none when it is not running. */
export async function openCodeSessions(env: Record<string, string | undefined> = process.env): Promise<AgentSession[]> {
  const stateHome = env["XDG_STATE_HOME"] || join(homedir(), ".local", "state")
  const file = join(stateHome, "opencode", "service.json")
  if (!existsSync(file)) return []
  const service = JSON.parse(readFileSync(file, "utf8")) as { url: string; password?: string }
  const headers: Record<string, string> = service.password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` }
    : {}
  const get = async (path: string) => {
    const res = await fetch(new URL(path, service.url), { headers, signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new Error(`OpenCode ${path} returned ${res.status}`)
    return ((await res.json()) as { data: any }).data
  }
  const [sessions, active] = await Promise.all([get("/api/session?parentID=null&limit=100000"), get("/api/session/active")])
  return (sessions as any[])
    .filter((s) => s.location?.directory)
    .map((s) => ({
      id: s.id,
      title: s.title ?? "",
      directory: s.location.directory,
      updatedAt: new Date(s.time.updated).toISOString(),
      running: s.id in (active ?? {}),
    }))
}
