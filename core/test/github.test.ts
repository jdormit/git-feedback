import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync, rmSync } from "node:fs"
import { git, openRepo } from "../src/git"
import { githubLink, githubPull, githubPush, githubStart, parsePrRef } from "../src/github"
import { addThread, editComment, findThread, reply, setResolved, startReview } from "../src/review"
import { ReviewStore } from "../src/store"
import type { Author } from "../src/types"
import { FakeGitHub } from "./fake-github"
import { lines, makeRepo, type TestRepo } from "./helpers"

const me: Author = { name: "Jeremy", kind: "human" }
const REPO = "acme/widgets"

let remote: TestRepo
let local: string
let headSha: string
let gh: FakeGitHub
let store: ReviewStore

beforeEach(() => {
  remote = makeRepo()
  remote.commit("base", { "src/app.txt": lines(40), "README": "readme\n" })
  remote.git("checkout", "-q", "-b", "feature")
  headSha = remote.commit("feature", {
    "src/app.txt": lines(40).replace("line 20\n", "line 20 changed\n"),
    "src/new.txt": lines(3, "new"),
  })
  remote.git("update-ref", "refs/pull/7/head", "feature")
  remote.git("checkout", "-q", "main")
  remote.commit("main moves on", { "other.txt": "o\n" })
  local = realpathSync(remote.dir) + "-clone"
  git(["clone", "-q", remote.dir, local], { cwd: remote.dir })
  git(["config", "user.name", "Jeremy"], { cwd: local })
  gh = new FakeGitHub({ number: 7, title: "Add widgets", headSha, baseRef: "main", repo: REPO })
  store = new ReviewStore(openRepo(local))
})

afterEach(() => {
  remote.cleanup()
  rmSync(local, { recursive: true, force: true })
})

const pr = { host: "github.com", repo: REPO, number: 7 }

describe("parsePrRef", () => {
  test("accepts URLs and owner/repo#n", () => {
    expect(parsePrRef("https://ghe.example.com/acme/widgets/pull/12")).toEqual({ host: "ghe.example.com", repo: "acme/widgets", number: 12 })
    expect(parsePrRef("acme/widgets#3")).toEqual({ host: "github.com", repo: "acme/widgets", number: 3 })
    expect(parsePrRef("#3")).toEqual({ number: 3 })
    expect(parsePrRef("3")).toEqual({ number: 3 })
  })
})

describe("githubStart", () => {
  test("fetches the PR and imports existing threads and conversation", async () => {
    const remoteThread = gh.addRemoteThread({ path: "src/app.txt", line: 20, body: "nice" })
    gh.addRemoteReply(remoteThread.id, "thanks", "bob")
    gh.addRemoteThread({ path: "src/app.txt", line: 5, body: "old news", outdated: true })
    gh.addIssueComment("LGTM overall")

    const review = await githubStart(store, local, gh, pr)
    expect(review.github).toMatchObject({ repo: REPO, number: 7, title: "Add widgets" })
    expect(review.title).toBe("PR #7: Add widgets")
    const rev = review.target.revisions[0]!
    expect(rev.head).toBe(headSha)
    expect(rev.base).toBe(git(["merge-base", "origin/main", headSha], { cwd: local }).trim())

    const [line, outdated, convo] = review.threads
    expect(line).toMatchObject({
      outdated: false,
      position: { revision: 1, path: "src/app.txt", side: "new", line: 20 },
      anchor: { kind: "line", lines: ["line 20 changed"] },
      github: { kind: "review-thread", threadId: `T_${remoteThread.id}`, rootCommentId: remoteThread.id },
    })
    expect(line!.comments.map((c) => [c.author.name, c.body])).toEqual([
      ["alice", "nice"],
      ["bob", "thanks"],
    ])
    expect(outdated!.outdated).toBe(true)
    expect(convo).toMatchObject({ anchor: { kind: "review" }, github: { kind: "conversation" } })
    expect(convo!.comments.map((c) => c.body)).toEqual(["LGTM overall"])

    const again = await githubStart(store, local, gh, pr)
    expect(again.id).toBe(review.id)
    expect(again.threads).toHaveLength(3)
  })
})

describe("githubPush", () => {
  test("submits new threads as one review, then replies, edits and resolution", async () => {
    const remoteThread = gh.addRemoteThread({ path: "src/app.txt", line: 20, body: "nice" })
    const review = await githubStart(store, local, gh, pr)
    const imported = review.threads[0]!

    addThread(store, review.id, { location: { path: "src/app.txt", line: 22, startLine: 21 }, body: "in diff", author: me })
    addThread(store, review.id, { location: { path: "src/app.txt", line: 2 }, body: "far away", author: me })
    addThread(store, review.id, { location: { path: "src/new.txt" }, body: "whole file", author: me })
    addThread(store, review.id, { body: "general note", author: me })
    reply(store, review.id, imported.id, "my reply", me)
    setResolved(store, review.id, imported.id, true)

    const result = await githubPush(store, review.id, gh, { event: "request-changes", body: "Please fix" })
    expect(result).toMatchObject({ reviewComments: 1, fileComments: 2, replies: 1, issueComments: 1, resolved: 1 })

    const posted = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls/7/reviews"))!
    expect(posted.body).toMatchObject({
      commit_id: headSha,
      event: "REQUEST_CHANGES",
      body: "Please fix",
      comments: [{ path: "src/app.txt", line: 22, side: "RIGHT", start_line: 21, start_side: "RIGHT", body: "in diff" }],
    })
    const fileBodies = gh.calls.filter((c) => c.path.endsWith("/pulls/7/comments")).map((c) => c.body)
    expect(fileBodies).toEqual([
      expect.objectContaining({ path: "src/app.txt", subject_type: "file", body: expect.stringContaining("far away") }),
      expect.objectContaining({ path: "src/new.txt", subject_type: "file", body: "whole file" }),
    ])
    expect(fileBodies[0].body).toContain("Line 2")
    expect(gh.resolved.has(remoteThread.id)).toBe(true)

    const saved = store.load(review.id)
    expect(saved.threads.every((t) => t.comments.every((c) => c.github))).toBe(true)
    expect(saved.threads.filter((t) => t.github?.kind === "conversation")).toHaveLength(1)

    editComment(store, review.id, saved.threads[0]!.comments[1]!.id, "my edited reply")
    gh.calls = []
    const second = await githubPush(store, review.id, gh, {})
    expect(second).toMatchObject({ reviewComments: 0, fileComments: 0, replies: 0, issueComments: 0, edits: 1, resolved: 0 })
    expect(gh.calls.filter((c) => c.method !== "GET" && c.method !== "GRAPHQL").map((c) => c.method)).toEqual(["PATCH"])
    expect(store.load(review.id).threads.flatMap((t) => t.comments)).toHaveLength(
      gh.reviewComments.length + gh.issueComments.length + gh.reviews.filter((r) => r.body).length,
    )
  })

  test("refuses to place new comments when the review is behind the PR head", async () => {
    const { review } = startReview(store, local, { spec: ["origin/main...origin/feature"] })
    await githubLink(store, review.id, gh, pr)
    addThread(store, review.id, { location: { path: "src/app.txt", line: 20 }, body: "x", author: me })
    gh.pr.headSha = "0".repeat(40)
    await expect(githubPush(store, review.id, gh, {})).rejects.toThrow(/github pull/)
  })
})

describe("githubPull", () => {
  test("takes remote resolution changes and edits, keeping local edits", async () => {
    const remoteThread = gh.addRemoteThread({ path: "src/app.txt", line: 20, body: "nice" })
    const issue = gh.addIssueComment("hello")
    const review = await githubStart(store, local, gh, pr)
    const thread = findThread(store.load(review.id), review.threads[0]!.id)
    const convo = store.load(review.id).threads[1]!

    gh.resolved.add(remoteThread.id)
    gh.reviewComments[0]!.body = "nice (edited)"
    issue.body = "hello (edited remotely)"
    editComment(store, review.id, convo.comments[0]!.id, "hello (edited locally)")
    await githubPull(store, review.id, gh)

    const after = store.load(review.id)
    expect(findThread(after, thread.id)).toMatchObject({ resolved: true, comments: [{ body: "nice (edited)" }] })
    expect(after.threads[1]!.comments[0]!.body).toBe("hello (edited locally)")

    gh.reviewComments = []
    await githubPull(store, review.id, gh)
    expect(store.load(review.id).threads.map((t) => t.github?.kind)).toEqual(["conversation"])
  })
})
