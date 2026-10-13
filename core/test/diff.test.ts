import { afterEach, describe, expect, test } from "bun:test"
import { changedPaths, hunksBetween, lineInHunks, mapLine, parseHunks } from "../src/diff"
import { lines, makeRepo, type TestRepo } from "./helpers"

describe("parseHunks", () => {
  test("reads counts, defaulting omitted counts to 1", () => {
    const text = ["@@ -3 +3,2 @@", "-a", "+b", "+c", "@@ -10,0 +12,4 @@ ctx"].join("\n")
    expect(parseHunks(text)).toEqual([
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
      { oldStart: 10, oldCount: 0, newStart: 12, newCount: 4 },
    ])
  })
})

describe("mapLine", () => {
  const hunks = [
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
    { oldStart: 10, oldCount: 0, newStart: 12, newCount: 4 },
  ]
  test("lines before any change keep their number", () => {
    expect(mapLine(hunks, 2)).toBe(2)
  })
  test("changed lines have no mapping", () => {
    expect(mapLine(hunks, 3)).toBeNull()
  })
  test("lines after a change shift by the size difference", () => {
    expect(mapLine(hunks, 4)).toBe(5)
    expect(mapLine(hunks, 10)).toBe(11)
  })
  test("pure insertions shift only the lines after them", () => {
    expect(mapLine(hunks, 11)).toBe(16)
  })
})

describe("with a repository", () => {
  let repo: TestRepo
  afterEach(() => repo.cleanup())

  test("hunksBetween and changedPaths follow renames", () => {
    repo = makeRepo()
    const a = repo.commit("one", { "a.txt": lines(20), "gone.txt": "x\n", "same.txt": "s\n" })
    repo.git("mv", "a.txt", "b.txt")
    repo.write("b.txt", lines(20).replace("line 5\n", "line 5\nnew\n"))
    repo.git("rm", "-q", "gone.txt")
    const b = repo.commit("two")
    const paths = changedPaths(repo.dir, a, b)
    expect(paths.get("a.txt")).toBe("b.txt")
    expect(paths.get("gone.txt")).toBeNull()
    expect(paths.has("same.txt")).toBe(false)
    const hunks = hunksBetween(repo.dir, `${a}:a.txt`, `${b}:b.txt`)
    expect(hunks).toEqual([{ oldStart: 5, oldCount: 0, newStart: 6, newCount: 1 }])
  })

  test("lineInHunks checks the visible PR diff on either side", () => {
    const hunks = [{ oldStart: 10, oldCount: 7, newStart: 10, newCount: 8 }]
    expect(lineInHunks(hunks, "new", 17)).toBe(true)
    expect(lineInHunks(hunks, "new", 18)).toBe(false)
    expect(lineInHunks(hunks, "old", 16)).toBe(true)
    expect(lineInHunks(hunks, "old", 9)).toBe(false)
  })
})
