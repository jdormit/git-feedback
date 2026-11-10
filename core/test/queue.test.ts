import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/cli"
import type { GitHubApi } from "../src/github"
import { buildQueue, openCodeSessions, type AgentSession, type QueueDeps } from "../src/queue"
import { addThread, reply, startReview } from "../src/review"
import { ReviewStore } from "../src/store"
import { openRepo } from "../src/git"
import { lines, makeRepo, type TestRepo } from "./helpers"

const NOW = new Date("2026-11-05T12:00:00Z")
const HOUR = 3_600_000

let repo: TestRepo
let scratch: string

beforeEach(() => {
  repo = makeRepo()
  repo.commit("init", { "a.txt": lines(10), "lib/mine.rb": "mine\n" })
  repo.git("remote", "add", "origin", "https://github.com/acme/app.git")
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD")
  repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "fdbk-queue-")))
})

afterEach(() => {
  repo.cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

function worktree(name: string): string {
  const path = join(scratch, name)
  repo.git("worktree", "add", "-q", "-b", name, path, "origin/main")
  return path
}

function gitIn(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd }).stdout.toString()
}

function commitIn(cwd: string, file: string, content: string) {
  writeFileSync(join(cwd, file), content)
  gitIn(cwd, "add", "-A")
  gitIn(cwd, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-q", "-m", `edit ${file}`)
}

function session(directory: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `ses_${Math.random().toString(36).slice(2)}`,
    title: "Agent session",
    directory,
    updatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    running: false,
    edited: [join(directory, "a.txt")],
    ...overrides,
  }
}

class FakeSearch implements GitHubApi {
  calls: string[] = []
  fail = false
  constructor(
    public prs: any[] = [],
    public teams: Array<{ slug: string; members: string[] }> = [],
  ) {}
  async request(): Promise<any> {
    throw new Error("unexpected REST call")
  }
  async paginate(): Promise<any[]> {
    throw new Error("unexpected REST call")
  }
  async graphql(query: string, variables: Record<string, any>): Promise<any> {
    if (this.fail) throw new Error("gh: network down")
    if (query.includes("search(")) {
      this.calls.push(variables["q"])
      return { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.prs } }
    }
    if (query.includes("teams(")) {
      return {
        organization: {
          teams: { nodes: this.teams.map((t) => ({ slug: t.slug, members: { nodes: t.members.map((login) => ({ login })) } })) },
        },
      }
    }
    return { viewer: { login: "me" } }
  }
}

function pr(number: number, overrides: Record<string, any> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    headRefName: `branch-${number}`,
    headRefOid: `head${number}`,
    author: { login: "alice", __typename: "User" },
    files: { nodes: [{ path: "other.rb" }] },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    ...overrides,
  }
}

function deps(sessions: AgentSession[] = [], github = new FakeSearch()): QueueDeps {
  return { github: () => github, sessions: async () => sessions, now: NOW }
}

test("a worktree with commits from a recent session is unreviewed agent work", async () => {
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))
  const s = session(wt, { title: "Add two lines" })

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([s]))

  expect(items).toEqual([
    expect.objectContaining({
      kind: "agent",
      id: `worktree:${wt}`,
      repo: "acme/app",
      dir: wt,
      branch: "feature",
      title: "Add two lines",
      state: "unreviewed",
      running: false,
      spec: ["origin/main...HEAD"],
      size: { files: 1, additions: 2, deletions: 0 },
      sessions: [s],
    }),
  ])
})

test("a session belongs to the worktrees it edited, not the one it started in", async () => {
  repo.commit("my own work", { "a.txt": lines(11) })
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))
  const older = session(repo.dir, { title: "Older", updatedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), edited: [join(wt, "b.txt")] })
  const newer = session(repo.dir, { title: "Newer", edited: [join(wt, "a.txt")] })
  const question = session(repo.dir, { title: "Just a question", edited: [] })

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([older, question, newer]))

  expect(items).toEqual([expect.objectContaining({ id: `worktree:${wt}`, title: "Newer", sessions: [newer, older] })])
})

test("uncommitted changes are reviewed against the merge base", async () => {
  const wt = worktree("dirty")
  writeFileSync(join(wt, "a.txt"), lines(11))
  const base = repo.git("rev-parse", "origin/main").trim()

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([session(wt, { running: true })]))

  expect(items).toMatchObject([{ kind: "agent", state: "unreviewed", running: true, spec: [base] }])
})

test("worktrees without recent sessions or without changes are skipped", async () => {
  const stale = worktree("stale")
  commitIn(stale, "a.txt", lines(12))
  worktree("clean")

  const { items } = await buildQueue(
    { repos: [repo.dir], days: 7 },
    deps([session(stale, { updatedAt: new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString() }), session(join(scratch, "clean"))]),
  )

  expect(items).toEqual([])
})

test("a review leaves the queue until the code changes or an agent replies", async () => {
  const wt = worktree("reviewed")
  commitIn(wt, "a.txt", lines(12))
  const store = new ReviewStore(openRepo(wt))
  const { review } = startReview(store, wt, { spec: ["origin/main...HEAD"] })
  const sessions = [session(wt)]

  expect((await buildQueue({ repos: [repo.dir] }, deps(sessions))).items).toEqual([])

  const { thread } = addThread(store, review.id, { location: { path: "a.txt", line: 12 }, body: "why?", author: { name: "me", kind: "human" } })
  expect((await buildQueue({ repos: [repo.dir] }, deps(sessions))).items).toEqual([])

  reply(store, review.id, thread.id, "because", { name: "opencode", kind: "agent" })
  expect((await buildQueue({ repos: [repo.dir] }, deps(sessions))).items).toMatchObject([
    { kind: "agent", id: `review:${review.id}`, state: "agent-replied", review: { id: review.id, unresolved: 1, agentReplies: 1 } },
  ])

  commitIn(wt, "a.txt", lines(13))
  expect((await buildQueue({ repos: [repo.dir] }, deps(sessions))).items).toMatchObject([
    { kind: "agent", state: "agent-replied", size: { additions: 3 } },
  ])
  addThread(store, review.id, { body: "ok", author: { name: "me", kind: "human" } })
  reply(store, review.id, thread.id, "thanks", { name: "me", kind: "human" })
  expect((await buildQueue({ repos: [repo.dir] }, deps(sessions))).items).toMatchObject([
    { kind: "agent", state: "changed-since-review", branch: "reviewed" },
  ])
})

test("pull requests carry the signals used to prioritize them", async () => {
  repo.git("config", "user.email", "me@example.com")
  repo.commit("touch lib", { "lib/mine.rb": "mine 2\n" })
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD")

  const github = new FakeSearch(
    [
      pr(1, { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "me" } }] } }),
      pr(2, {
        author: { login: "bob" },
        files: { nodes: [{ path: "lib/mine.rb" }, { path: "x.rb" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", slug: "core" } }] },
        latestReviews: { nodes: [{ author: { login: "carol" }, state: "APPROVED", commit: { oid: "head2" } }] },
      }),
      pr(3, { latestReviews: { nodes: [{ author: { login: "me" }, state: "COMMENTED", commit: { oid: "old" } }] } }),
      pr(5, { author: { login: "dependabot", __typename: "Bot" } }),
      pr(4, { latestReviews: { nodes: [{ author: { login: "me" }, state: "APPROVED", commit: { oid: "head4" } }] } }),
    ],
    [{ slug: "core", members: ["me", "bob"] }],
  )

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([], github))

  expect(github.calls).toEqual(["repo:acme/app is:pr is:open draft:false -author:me"])
  expect(items.map((i) => i.id)).toEqual(["github.com/acme/app#1", "github.com/acme/app#2", "github.com/acme/app#3", "github.com/acme/app#5"])
  expect(items).toMatchObject([
    { kind: "pull-request", number: 1, dir: repo.dir, requested: "you", authorOnTeam: false, state: "unreviewed", familiarFiles: 0 },
    { number: 2, author: "bob", requested: "team", authorOnTeam: true, approvals: 1, familiarFiles: 1, version: "head2" },
    { number: 3, requested: null, state: "changed-since-review", authorIsBot: false },
    { number: 5, authorIsBot: true },
  ])
})

test("a pull request links to its open fdbk review", async () => {
  const store = new ReviewStore(openRepo(repo.dir))
  const { review } = startReview(store, repo.dir, {
    spec: ["HEAD"],
    github: { host: "github.com", repo: "acme/app", number: 7, url: "u" },
  })

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([], new FakeSearch([pr(7)])))

  expect(items).toMatchObject([{ kind: "pull-request", number: 7, review: review.id }])
})

test("a GitHub failure is a warning, not an error", async () => {
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))
  const github = new FakeSearch()
  github.fail = true

  const queue = await buildQueue({ repos: [repo.dir] }, deps([session(wt)], github))

  expect(queue.items).toHaveLength(1)
  expect(queue.warnings).toEqual([expect.stringContaining("network down")])
})

test("fdbk queue runs outside a repository and prints JSON", async () => {
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))
  let stdout = ""
  const code = await run(["queue", "--json", repo.dir], {
    cwd: scratch,
    stdout: (t) => (stdout += t),
    stderr: () => {},
    readStdin: async () => "",
    github: new FakeSearch(),
    sessions: async () => [session(wt, { updatedAt: new Date().toISOString() })],
  })
  expect(code).toBe(0)
  expect(JSON.parse(stdout).items).toMatchObject([{ kind: "agent", branch: "feature" }])
})

test("a review of named branches does not cover the worktree it was started in", async () => {
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))
  repo.git("branch", "other", "origin/main")
  const store = new ReviewStore(openRepo(wt))
  startReview(store, wt, { spec: ["origin/main...other"] })

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([session(wt)]))

  expect(items).toMatchObject([{ kind: "agent", id: `worktree:${wt}`, state: "unreviewed" }])
})

test("a repository that cannot be read is a warning, not an error", async () => {
  const wt = worktree("feature")
  commitIn(wt, "a.txt", lines(12))

  const queue = await buildQueue({ repos: [scratch + "/missing", repo.dir] }, deps([session(wt)]))

  expect(queue.items).toMatchObject([{ kind: "agent", branch: "feature" }])
  expect(queue.warnings).toEqual([expect.stringContaining("missing")])
})

test("editing a dirty worktree changes its version even when the line counts stay the same", async () => {
  const wt = worktree("dirty")
  writeFileSync(join(wt, "a.txt"), lines(9) + "changed\n")
  const before = (await buildQueue({ repos: [repo.dir] }, deps([session(wt)]))).items[0]!
  writeFileSync(join(wt, "a.txt"), lines(9) + "changed again\n")
  const after = (await buildQueue({ repos: [repo.dir] }, deps([session(wt)]))).items[0]!

  expect(after.version).not.toBe(before.version)
})

test("OpenCode sessions carry the files they and their subagents edited", async () => {
  const recent = new Date(NOW.getTime() - HOUR).getTime()
  const old = recent - 30 * 24 * HOUR
  const tool = (name: string, input: Record<string, unknown>, status = "completed") => ({ type: "tool", name, state: { status, input } })
  const assistant = (...content: unknown[]) => ({ type: "assistant", content })
  const sessions = [
    { id: "root", title: "Root", location: { directory: "/repo" }, time: { updated: recent } },
    { id: "child", parentID: "root", title: "Sub", location: { directory: "/repo" }, time: { updated: recent } },
    { id: "grandchild", parentID: "child", title: "Old sub", location: { directory: "/repo" }, time: { updated: old } },
    { id: "broken", title: "Broken", location: { directory: "/repo" }, time: { updated: recent } },
    { id: "old", title: "Old", location: { directory: "/repo" }, time: { updated: old } },
  ]
  const messages: Record<string, unknown[]> = {
    root: [
      assistant(tool("edit", { path: "/wt/a.rb", oldString: "x", newString: "y" }), tool("read", { path: "/repo/b.rb" })),
      assistant(tool("shell", { command: "touch c.rb", workdir: "/wt2" }), tool("edit", { path: "/wt3/failed.rb" }, "error")),
      ...Array.from({ length: 200 }, () => ({ type: "user", content: [] })),
      assistant(tool("write", { path: "relative.rb", content: "" })),
    ],
    child: [assistant(tool("edit", { path: "/wt/a.rb" }), tool("write", { path: "/wt/d.rb" }))],
    grandchild: [assistant(tool("edit", { path: "/wt/e.rb" }))],
  }
  const requested: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requested.push(url.pathname)
      if (url.pathname === "/api/session") return Response.json({ data: sessions })
      if (url.pathname === "/api/session/active") return Response.json({ data: { root: {} } })
      const id = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)![1]!
      if (id === "broken") return new Response("gone", { status: 404 })
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit"))
      const all = messages[id] ?? []
      const next = offset + limit < all.length ? String(offset + limit) : undefined
      return Response.json({ data: all.slice(offset, offset + limit), cursor: { next } })
    },
  })
  mkdirSync(join(scratch, "opencode"))
  writeFileSync(join(scratch, "opencode", "service.json"), JSON.stringify({ url: server.url.href }))

  try {
    const result = await openCodeSessions(new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString(), { XDG_STATE_HOME: scratch })
    expect(result).toEqual([
      {
        id: "root",
        title: "Root",
        directory: "/repo",
        updatedAt: new Date(recent).toISOString(),
        running: true,
        edited: ["/wt/a.rb", "/repo/relative.rb", "/wt/d.rb", "/wt/e.rb"],
      },
      expect.objectContaining({ id: "broken", edited: [] }),
    ])
    expect(requested).not.toContain("/api/session/old/message")
  } finally {
    server.stop(true)
  }
})

test("your pending review does not count as a review", async () => {
  const github = new FakeSearch([pr(1, { latestReviews: { nodes: [{ author: { login: "me" }, state: "PENDING", commit: { oid: "head1" } }] } })])

  const { items } = await buildQueue({ repos: [repo.dir] }, deps([], github))

  expect(items).toMatchObject([{ number: 1, state: "unreviewed" }])
})
