import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { openRepo } from "../../core/src/git"
import { addThread, startReview } from "../../core/src/review"
import { ReviewStore } from "../../core/src/store"
import { lines, makeRepo, type TestRepo } from "../../core/test/helpers"
import plugin from "../src/index"

type ToolDef = { name: string; description: string; input: any; output?: any; options?: { codemode?: boolean }; execute: (input: any, ctx: any) => Promise<{ content?: unknown; output?: any }> }
type CommandDef = { name: string; description?: string; execute: (input: any) => Promise<void> }
type SkillDef = { id: string; name: string; description?: string; path: string; content: string }

let repo: TestRepo
let store: ReviewStore
let tools: Map<string, ToolDef>
let commands: Map<string, CommandDef>
let skills: Map<string, SkillDef>
let prompts: any[]

async function setup(options: Record<string, unknown> = {}, directory = repo.dir, installedSkills: SkillDef[] = []) {
  tools = new Map()
  commands = new Map()
  skills = new Map(installedSkills.map((s) => [s.id, s]))
  prompts = []
  const ctx = {
    options,
    location: { directory, project: { id: "p", directory, canonical: directory } },
    tool: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (t: ToolDef) => tools.set(t.name, t) })
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (c: CommandDef) => commands.set(c.name, c) })
        return { dispose: async () => {} }
      },
    },
    skill: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (s: SkillDef) => skills.set(s.id, s), get: (id: string) => skills.get(id) })
        return { dispose: async () => {} }
      },
    },
    session: {
      prompt: async (input: any) => {
        prompts.push(input)
        return {}
      },
    },
  } as unknown as Plugin.Context
  await plugin.setup(ctx)
}

beforeEach(async () => {
  repo = makeRepo()
  repo.commit("init", { "a.txt": lines(10) })
  repo.write("a.txt", lines(12))
  store = new ReviewStore(openRepo(repo.dir))
  await setup()
})
afterEach(() => repo.cleanup())

async function call(name: string, input: Record<string, unknown>) {
  const result = await tools.get(name)!.execute(input, { sessionID: "s", agent: "build", messageID: "m", id: "c" })
  return result.content as string
}

test("exports a plugin definition with a stable id", () => {
  expect(plugin.id).toBe("git-feedback")
})

test("registers every review tool with a JSON Schema input", () => {
  expect([...tools.keys()].sort()).toEqual(
    ["review_comment", "review_list", "review_refresh", "review_reply", "review_resolve", "review_show"].sort(),
  )
  for (const t of tools.values()) {
    expect(t.input.type).toBe("object")
    expect(t.options?.codemode).not.toBe(false)
  }
  expect(tools.get("review_reply")!.input.required).toEqual(["thread", "body"])
})

test("bundles the fdbk skill from skills/fdbk/SKILL.md", async () => {
  const skill = skills.get("fdbk")!
  const path = fileURLToPath(new URL("../../skills/fdbk/SKILL.md", import.meta.url))
  const description = readFileSync(path, "utf8").match(/^description: (.*)$/m)![1]
  expect(skill.path).toBe(path)
  expect(skill.name).toBe("fdbk")
  expect(skill.description).toBe(description)
  expect(skill.content.startsWith("# git-feedback (fdbk)\n")).toBe(true)
})

test("an installed fdbk skill takes precedence over the bundled one", async () => {
  const installed = { id: "fdbk", name: "fdbk", path: "/home/me/.agents/skills/fdbk/SKILL.md", content: "mine" }
  await setup({}, repo.dir, [installed])
  expect(skills.get("fdbk")).toBe(installed)
})

test("review_show lists unresolved threads with code context", async () => {
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
  addThread(store, review.id, { location: { path: "a.txt", line: 11 }, body: "Is this needed?", author: { name: "Jeremy", kind: "human" } })
  const out = await call("review_show", {})
  expect(out).toContain("Is this needed?")
  expect(out).toContain("> 11 | line 11")
})

test("plugin instances use their own location for session tool calls", async () => {
  startReview(store, repo.dir, { spec: ["HEAD"], title: "First repository" })
  const first = tools.get("review_list")!
  const other = makeRepo()
  try {
    other.commit("init", { "b.txt": lines(2) })
    await setup({}, other.dir)
    expect(await call("review_list", {})).toBe("No reviews.")
    const result = await first.execute({}, { sessionID: "first-session" })
    expect(result.content).toContain("First repository")
  } finally {
    other.cleanup()
  }
})

test("agents reply and resolve as agents", async () => {
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
  const { thread } = addThread(store, review.id, { location: { path: "a.txt", line: 11 }, body: "fix", author: { name: "Jeremy", kind: "human" } })
  await call("review_reply", { thread: thread.id, body: "Fixed.", resolve: true })
  const saved = store.load(review.id).threads[0]!
  expect(saved.resolved).toBe(true)
  expect(saved.comments[1]!.author).toEqual({ name: "opencode", kind: "agent" })
})

test("the author option names the agent", async () => {
  await setup({ author: "claude" })
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"] })
  await call("review_comment", { body: "Note" })
  expect(store.load(review.id).threads[0]!.comments[0]!.author).toEqual({ name: "claude", kind: "agent" })
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

test("review_list returns structured summaries with the same filtering as its text", async () => {
  const list = tools.get("review_list")!
  expect(list.output).toBeDefined()
  expect((await list.execute({}, {})).output).toEqual({ reviews: [] })
  const { review } = startReview(store, repo.dir, { spec: ["HEAD"], title: "Check this" })
  const result = await list.execute({}, {})
  expect(result.output.reviews[0]).toMatchObject({ id: review.id, title: "Check this", status: "open", unresolved: 0 })
  expect(result.content).toBe(`${review.id}  open  0 open  Check this  (git diff HEAD)`)
  store.mutate(review.id, (r) => { r.status = "closed" })
  expect(await list.execute({}, {})).toMatchObject({ content: "No reviews.", output: { reviews: [] } })
  expect((await list.execute({ all: true }, {})).output.reviews[0].status).toBe("closed")
})

test("review_list returns structured errors alongside display text", async () => {
  await setup({}, "/dev/null")
  const result = await tools.get("review_list")!.execute({}, {})
  expect(result.content).toMatch(/^Error:/)
  expect(result.output).toEqual({ error: result.content })
})

test("/address-review prompts the session with the user's arguments", async () => {
  const command = commands.get("address-review")!
  expect(command.description).toBeTruthy()
  await command.execute({ sessionID: "s", prompt: { text: "  focus on a.txt ", files: [] }, delivery: "queue" })
  expect(prompts).toHaveLength(1)
  const [sent] = prompts
  expect(sent.sessionID).toBe("s")
  expect(sent.delivery).toBe("queue")
  expect(sent.files).toEqual([])
  expect(sent.text).toContain("review_show")
  expect(sent.text).toContain("Use execute")
  expect(sent.text).not.toContain("$ARGUMENTS")
  expect(sent.text.endsWith("\n\nfocus on a.txt")).toBe(true)
})

test("/address-review without arguments sends just the instructions", async () => {
  await commands.get("address-review")!.execute({ sessionID: "s", prompt: { text: "" }, delivery: "steer" })
  expect(prompts[0].text).toEndWith("still need the reviewer.")
})

test("/address-review keeps attachments without stale text offsets", async () => {
  const mention = { start: 2, end: 8, text: "@a.txt" }
  await commands.get("address-review")!.execute({
    sessionID: "s",
    prompt: {
      text: "  @a.txt @build @skill",
      files: [{ uri: "file:///a.txt", mention }],
      agents: [{ name: "build", mention }],
      skills: [{ id: "skill", mention }],
    },
    delivery: "queue",
  })
  expect(prompts[0].files).toEqual([{ uri: "file:///a.txt" }])
  expect(prompts[0].agents).toEqual([{ name: "build" }])
  expect(prompts[0].skills).toEqual([{ id: "skill" }])
})

test("package.json exposes the plugin to the V2 loader", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  expect(pkg.exports["./server"]).toBe("./opencode/src/index.ts")
  const local = await import(new URL("../../server.ts", import.meta.url).href)
  expect(local.default).toBe(plugin)
})

test("package.json has no scripts that make npm prepare a git install", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  expect(pkg).not.toHaveProperty("workspaces")
  for (const name of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) expect(pkg.scripts).not.toHaveProperty(name)
})
