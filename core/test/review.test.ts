import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { openRepo } from "../src/git"
import {
  addThread,
  deleteComment,
  deleteReview,
  editComment,
  refreshReview,
  reply,
  setResolved,
  startReview,
} from "../src/review"
import { ReviewStore } from "../src/store"
import type { Author } from "../src/types"
import { lines, makeRepo, type TestRepo } from "./helpers"

const me: Author = { name: "Jeremy", kind: "human" }
const bot: Author = { name: "opencode", kind: "agent" }

let repo: TestRepo
let store: ReviewStore

beforeEach(() => {
  repo = makeRepo()
  repo.commit("init", { "src/a.txt": lines(30), "b.txt": lines(5, "b") })
  store = new ReviewStore(openRepo(repo.dir))
})
afterEach(() => repo.cleanup())

describe("startReview", () => {
  test("creates a review stored in the git dir with pinned revision refs", () => {
    repo.write("src/a.txt", lines(31))
    const { review, created } = startReview(store, repo.dir, { spec: ["HEAD"] })
    expect(created).toBe(true)
    expect(review.target.worktree).toBe(repo.dir)
    expect(review.target.revisions).toHaveLength(1)
    expect(existsSync(join(repo.dir, ".git", "universal-review", "reviews", `${review.id}.json`))).toBe(true)
    const rev = review.target.revisions[0]!
    expect(repo.git("rev-parse", `refs/universal-review/${review.id}/1/head`).trim()).toBe(rev.head)
    expect(repo.git("status", "--porcelain")).toBe(" M src/a.txt\n")
  })

  test("reuses an open review for the same spec and worktree", () => {
    const first = startReview(store, repo.dir, { spec: ["HEAD"] }).review
    const again = startReview(store, repo.dir, { spec: ["HEAD"] })
    expect(again.created).toBe(false)
    expect(again.review.id).toBe(first.id)
    expect(startReview(store, repo.dir, { spec: ["HEAD"], reuse: false }).review.id).not.toBe(first.id)
  })
})

describe("threads", () => {
  test("line comments capture the anchored text and validate the range", () => {
    repo.write("src/a.txt", lines(31))
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    const { thread } = addThread(store, review.id, {
      location: { path: "src/a.txt", side: "new", line: 12, startLine: 10 },
      body: "rename these",
      author: me,
    })
    expect(thread.anchor).toEqual({
      kind: "line",
      revision: 1,
      path: "src/a.txt",
      side: "new",
      line: 12,
      startLine: 10,
      lines: ["line 10", "line 11", "line 12"],
    })
    expect(thread.position).toEqual({ revision: 1, path: "src/a.txt", side: "new", line: 12, startLine: 10 })
    expect(() =>
      addThread(store, review.id, { location: { path: "src/a.txt", side: "new", line: 99 }, body: "x", author: me }),
    ).toThrow(/line/)
    expect(() =>
      addThread(store, review.id, { location: { path: "nope.txt", side: "new", line: 1 }, body: "x", author: me }),
    ).toThrow(/nope.txt/)
  })

  test("file and review-level threads", () => {
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    const file = addThread(store, review.id, { location: { path: "b.txt" }, body: "whole file", author: me }).thread
    expect(file.anchor).toEqual({ kind: "file", revision: 1, path: "b.txt" })
    const general = addThread(store, review.id, { body: "overall", author: me }).thread
    expect(general.anchor).toEqual({ kind: "review" })
    expect(general.position).toBeUndefined()
  })

  test("reply, edit, resolve and delete", () => {
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    const { thread, comment } = addThread(store, review.id, { location: { path: "b.txt", line: 2 }, body: "why?", author: me })
    expect(thread.anchor.kind === "line" && thread.anchor.side).toBe("new")

    const answer = reply(store, review.id, thread.id.slice(0, 4), "because", bot).comment
    editComment(store, review.id, comment.id, "why though?")
    setResolved(store, review.id, thread.id, true)

    let saved = store.load(review.id).threads[0]!
    expect(saved.resolved).toBe(true)
    expect(saved.comments.map((c) => [c.author.kind, c.body])).toEqual([
      ["human", "why though?"],
      ["agent", "because"],
    ])
    expect(saved.comments[0]!.updatedAt).toBeDefined()

    deleteComment(store, review.id, answer.id)
    expect(store.load(review.id).threads[0]!.comments).toHaveLength(1)
    deleteComment(store, review.id, comment.id)
    expect(store.load(review.id).threads).toHaveLength(0)
  })
})

describe("refreshReview", () => {
  function setup() {
    repo.write("src/a.txt", lines(30).replace("line 20\n", "line 20 changed\n"))
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    const below = addThread(store, review.id, {
      location: { path: "src/a.txt", side: "new", line: 20 },
      body: "below",
      author: me,
    }).thread
    const anchored = addThread(store, review.id, {
      location: { path: "src/a.txt", side: "new", line: 6, startLine: 5 },
      body: "anchored",
      author: me,
    }).thread
    const old = addThread(store, review.id, {
      location: { path: "src/a.txt", side: "old", line: 20 },
      body: "old side",
      author: me,
    }).thread
    return { review, below, anchored, old }
  }

  test("does nothing when the spec resolves to the same objects", () => {
    const { review } = setup()
    expect(refreshReview(store, review.id).changed).toBe(false)
    expect(store.load(review.id).target.revisions).toHaveLength(1)
  })

  test("moves threads past edits and marks edited anchors outdated", () => {
    const { review, below, anchored, old } = setup()
    repo.write(
      "src/a.txt",
      lines(30)
        .replace("line 2\n", "line 2\nextra a\nextra b\n")
        .replace("line 6\n", "line six\n")
        .replace("line 20\n", "line 20 changed\n"),
    )
    const result = refreshReview(store, review.id)
    expect(result.changed).toBe(true)
    const byId = new Map(result.review.threads.map((t) => [t.id, t]))
    expect(byId.get(below.id)).toMatchObject({ outdated: false, position: { revision: 2, line: 22 } })
    expect(byId.get(anchored.id)).toMatchObject({ outdated: true, position: { revision: 1, line: 6, startLine: 5 } })
    expect(byId.get(old.id)).toMatchObject({ outdated: false, position: { revision: 2, side: "old", line: 20 } })
    expect(repo.git("rev-parse", `refs/universal-review/${review.id}/2/head`).trim()).toBe(
      result.review.target.revisions[1]!.head,
    )
  })

  test("follows renames and outdates threads on deleted files", () => {
    repo.commit("wip", { "src/a.txt": lines(31) })
    const { review } = startReview(store, repo.dir, { spec: ["HEAD~1..HEAD"] })
    const t = addThread(store, review.id, { location: { path: "src/a.txt", line: 20 }, body: "x", author: me }).thread
    const f = addThread(store, review.id, { location: { path: "b.txt" }, body: "x", author: me }).thread
    store.mutate(review.id, (r) => {
      r.target.spec = ["HEAD~2..HEAD"]
    })
    repo.git("mv", "src/a.txt", "src/renamed.txt")
    repo.git("rm", "-q", "b.txt")
    repo.git("commit", "-qm", "rename")
    const threads = refreshReview(store, review.id).review.threads
    expect(threads.find((x) => x.id === t.id)).toMatchObject({ outdated: false, position: { path: "src/renamed.txt", line: 20 } })
    expect(threads.find((x) => x.id === f.id)!.outdated).toBe(true)
  })
})

describe("ReviewStore", () => {
  test("select by id prefix, the only open review, or fail when ambiguous", () => {
    const a = startReview(store, repo.dir, { spec: ["HEAD"] }).review
    expect(store.select().id).toBe(a.id)
    const b = startReview(store, repo.dir, { spec: ["--cached"] }).review
    expect(() => store.select()).toThrow(/--review/)
    expect(store.select(b.id.slice(0, 5)).id).toBe(b.id)
  })

  test("deleteReview removes the file and its refs", () => {
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    deleteReview(store, review.id)
    expect(store.list()).toHaveLength(0)
    expect(repo.git("for-each-ref", "refs/universal-review/")).toBe("")
  })

  test("worktrees share the store", () => {
    const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
    const wt = `${repo.dir}-wt`
    repo.git("worktree", "add", "-q", wt)
    try {
      expect(new ReviewStore(openRepo(wt)).load(review.id).id).toBe(review.id)
    } finally {
      repo.git("worktree", "remove", "--force", wt)
    }
  })
})
