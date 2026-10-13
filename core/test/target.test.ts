import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { emptyTree, readLines } from "../src/git"
import { parseSpec, resolveSpec } from "../src/target"
import { lines, makeRepo, type TestRepo } from "./helpers"

let repo: TestRepo
let c1: string
let c2: string

beforeEach(() => {
  repo = makeRepo()
  c1 = repo.commit("one", { "a.txt": lines(5), "dir/b.txt": "b\n" })
  c2 = repo.commit("two", { "a.txt": lines(6) })
})
afterEach(() => repo.cleanup())

describe("parseSpec", () => {
  test("separates options, revisions and paths", () => {
    expect(parseSpec(["--cached", "-w", "HEAD", "dir"], repo.dir)).toEqual({
      revs: ["HEAD"],
      paths: ["dir"],
      cached: true,
      mergeBase: false,
    })
    expect(parseSpec(["main...HEAD", "--", "a.txt"], repo.dir).paths).toEqual(["a.txt"])
  })

  test("rejects unsupported forms", () => {
    expect(() => parseSpec(["--no-index", "x", "y"], repo.dir)).toThrow()
    expect(() => parseSpec(["a", "b", "c"].map(() => "HEAD"), repo.dir)).toThrow()
  })
})

describe("resolveSpec", () => {
  test("two-dot, three-dot and ^! ranges resolve to commits", () => {
    repo.git("checkout", "-q", "-b", "feature")
    const c3 = repo.commit("three", { "a.txt": lines(7) })
    repo.git("checkout", "-q", "main")
    const c4 = repo.commit("four", { "other.txt": "o\n" })
    expect(resolveSpec(["main..feature"], repo.dir)).toEqual({ base: c4, head: c3 })
    expect(resolveSpec(["main...feature"], repo.dir)).toEqual({ base: c2, head: c3 })
    expect(resolveSpec([`${c2}^!`], repo.dir)).toEqual({ base: c1, head: c2 })
    expect(resolveSpec([c1, c2], repo.dir)).toEqual({ base: c1, head: c2 })
    expect(resolveSpec(["--merge-base", "feature", "main"], repo.dir)).toEqual({ base: c2, head: c4 })
  })

  test("a root commit diffs against the empty tree", () => {
    expect(resolveSpec([`${c1}^!`], repo.dir)).toEqual({ base: emptyTree(repo.dir), head: c1 })
  })

  test("the worktree and index become snapshot trees", () => {
    repo.write("a.txt", "staged\n")
    repo.git("add", "a.txt")
    repo.write("a.txt", "unstaged\n")

    const unstaged = resolveSpec([], repo.dir)
    expect(readLines(repo.dir, unstaged.base, "a.txt")).toEqual(["staged"])
    expect(readLines(repo.dir, unstaged.head, "a.txt")).toEqual(["unstaged"])

    const staged = resolveSpec(["--cached"], repo.dir)
    expect(staged.base).toBe(c2)
    expect(readLines(repo.dir, staged.head, "a.txt")).toEqual(["staged"])

    const vsHead = resolveSpec(["HEAD"], repo.dir)
    expect(vsHead.base).toBe(c2)
    expect(readLines(repo.dir, vsHead.head, "a.txt")).toEqual(["unstaged"])

    expect(repo.git("status", "--porcelain")).toBe("MM a.txt\n")
  })

  test("snapshots are stable when nothing changes", () => {
    repo.write("a.txt", "edited\n")
    expect(resolveSpec(["HEAD"], repo.dir)).toEqual(resolveSpec(["HEAD"], repo.dir))
  })
})
