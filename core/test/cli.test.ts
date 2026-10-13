import { afterEach, beforeEach, expect, test } from "bun:test"
import { run } from "../src/cli"
import { lines, makeRepo, type TestRepo } from "./helpers"

let repo: TestRepo

beforeEach(() => {
  repo = makeRepo()
  repo.commit("init", { "a.txt": lines(10) })
  repo.write("a.txt", lines(11))
})
afterEach(() => repo.cleanup())

async function gur(args: string[], stdin = "") {
  let stdout = ""
  let stderr = ""
  const code = await run(args, {
    cwd: repo.dir,
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => stdin,
  })
  return { code, stdout, stderr, json: () => JSON.parse(stdout) }
}

test("start, comment from stdin, reply, resolve and show", async () => {
  const started = (await gur(["start", "--json", "--title", "WIP", "--", "HEAD", "--", "a.txt"])).json()
  expect(started.target.spec).toEqual(["HEAD", "--", "a.txt"])
  expect(started.title).toBe("WIP")

  const added = (await gur(["comment", "--json", "--path", "a.txt", "--line", "11", "--body-file", "-"], "new line?\n")).json()
  expect(added.comment.body).toBe("new line?")
  expect(added.thread.position.line).toBe(11)

  await gur(["reply", added.thread.id, "--agent", "--author", "bot", "--body", "yes"])
  await gur(["resolve", added.thread.id])

  const shown = await gur(["show"])
  expect(shown.stdout).toContain("0 thread(s) shown, 1 resolved hidden")
  const all = await gur(["show", "--all"])
  expect(all.stdout).toContain("> 11 | line 11")
  expect(all.stdout).toContain("bot (agent)")

  const list = (await gur(["list", "--json"])).json()
  expect(list).toMatchObject([{ id: started.id, unresolved: 0, threads: 1 }])
})

test("argument errors are reported", async () => {
  await gur(["start"])
  await expect(gur(["comment", "--line", "3", "--body", "x"])).rejects.toThrow(/--path/)
  await expect(gur(["comment", "--path", "a.txt"])).rejects.toThrow(/--body/)
  await expect(gur(["frobnicate"])).rejects.toThrow(/Unknown command/)
})

test("start keeps revisions before a -- path separator", async () => {
  const a = (await gur(["start", "--json", "HEAD", "--", "a.txt"])).json()
  expect(a.target.spec).toEqual(["HEAD", "--", "a.txt"])
  const b = (await gur(["start", "--json", "--new", "--", "HEAD", "--", "a.txt"])).json()
  expect(b.target.spec).toEqual(["HEAD", "--", "a.txt"])
})
