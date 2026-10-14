import { afterEach, beforeEach, expect, test } from "bun:test"
import { openRepo } from "../../core/src/git"
import { addThread, startReview } from "../../core/src/review"
import { ReviewStore } from "../../core/src/store"
import { lines, makeRepo, type TestRepo } from "../../core/test/helpers"
import { ReviewPlugin } from "../src/index"

let repo: TestRepo
let store: ReviewStore
let hooks: Awaited<ReturnType<typeof ReviewPlugin>>

beforeEach(async () => {
  repo = makeRepo()
  repo.commit("init", { "a.txt": lines(10) })
  repo.write("a.txt", lines(12))
  store = new ReviewStore(openRepo(repo.dir))
  hooks = await ReviewPlugin({ directory: repo.dir } as any)
})
afterEach(() => repo.cleanup())

function call(name: string, args: Record<string, unknown>) {
  const t = hooks.tool![name]!
  return t.execute(args as any, { directory: repo.dir, worktree: repo.dir, sessionID: "s", agent: "build" } as any) as Promise<string>
}

test("review_show lists unresolved threads with code context", async () => {
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
  addThread(store, review.id, { location: { path: "a.txt", line: 11 }, body: "Is this needed?", author: { name: "Jeremy", kind: "human" } })
  const out = await call("review_show", {})
  expect(out).toContain("Is this needed?")
  expect(out).toContain("> 11 | line 11")
})

test("agents reply and resolve as agents", async () => {
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
  const { thread } = addThread(store, review.id, { location: { path: "a.txt", line: 11 }, body: "fix", author: { name: "Jeremy", kind: "human" } })
  await call("review_reply", { thread: thread.id, body: "Fixed.", resolve: true })
  const saved = store.load(review.id).threads[0]!
  expect(saved.resolved).toBe(true)
  expect(saved.comments[1]!.author).toEqual({ name: "opencode", kind: "agent" })
})

test("review_comment adds an agent thread and review_list summarizes", async () => {
  startReview(store, repo.dir, { spec: ["HEAD"] })
  const out = await call("review_comment", { path: "a.txt", line: 12, body: "Note" })
  expect(out).toMatch(/Added thread/)
  expect(await call("review_list", {})).toContain("1 open")
})

test("tool errors are returned as text", async () => {
  expect(await call("review_show", {})).toMatch(/No open reviews/)
})

test("registers the /address-review command", async () => {
  const config: any = {}
  await hooks.config!(config)
  expect(config.command["address-review"].template).toContain("review_show")
})

test("package.json has no scripts that make npm prepare a git install", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  expect(pkg).not.toHaveProperty("workspaces")
  for (const name of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) expect(pkg.scripts).not.toHaveProperty(name)
})
