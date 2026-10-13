import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyTree, git, gitTry, resolveCommitish, resolveObject } from "./git"

export interface ParsedSpec {
  revs: string[]
  paths: string[]
  cached: boolean
  mergeBase: boolean
}

export interface Resolved {
  base: string
  head: string
}

function isRevArg(cwd: string, arg: string): boolean {
  const range = /^(.*?)(\.\.\.?)(.*)$/.exec(arg)
  if (range) {
    const sides = [range[1], range[3]].filter((s): s is string => !!s)
    return sides.length > 0 && sides.every((s) => resolveObject(cwd, s) !== null)
  }
  if (arg.endsWith("^!")) return resolveObject(cwd, arg.slice(0, -2)) !== null
  return resolveObject(cwd, arg) !== null
}

/** Split `git diff` arguments into the parts that decide what is compared. */
export function parseSpec(spec: string[], cwd: string): ParsedSpec {
  const parsed: ParsedSpec = { revs: [], paths: [], cached: false, mergeBase: false }
  let afterDashDash = false
  for (const arg of spec) {
    if (afterDashDash) parsed.paths.push(arg)
    else if (arg === "--") afterDashDash = true
    else if (arg === "--cached" || arg === "--staged") parsed.cached = true
    else if (arg === "--merge-base") parsed.mergeBase = true
    else if (arg === "--no-index") throw new Error("--no-index diffs are not supported")
    else if (arg.startsWith("-")) continue
    else if (parsed.paths.length === 0 && isRevArg(cwd, arg)) parsed.revs.push(arg)
    else parsed.paths.push(arg)
  }
  if (parsed.revs.length > 2) throw new Error("Combined diffs of more than two revisions are not supported")
  return parsed
}

function mergeBase(cwd: string, a: string, b: string): string {
  return git(["merge-base", a, b], { cwd }).trim()
}

function indexFile(cwd: string): string {
  return git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd }).trim()
}

export function indexTree(cwd: string): string {
  const out = gitTry(["write-tree"], { cwd })
  if (out === null) throw new Error("Cannot snapshot the index while it has unresolved conflicts")
  return out.trim()
}

/** Tree of the tracked files in the worktree, built in a scratch index so the real one is untouched. */
export function worktreeTree(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gur-index-"))
  try {
    const scratch = join(dir, "index")
    const real = indexFile(cwd)
    if (existsSync(real)) copyFileSync(real, scratch)
    const env = { GIT_INDEX_FILE: scratch }
    const toplevel = git(["rev-parse", "--show-toplevel"], { cwd }).trim()
    git(["add", "-u", "--", "."], { cwd: toplevel, env })
    return git(["write-tree"], { cwd: toplevel, env }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function rangeSides(cwd: string, rev: string): Resolved | null {
  const triple = /^(.*?)\.\.\.(.*)$/.exec(rev)
  if (triple) {
    const a = resolveCommitish(cwd, triple[1] || "HEAD")
    const b = resolveCommitish(cwd, triple[2] || "HEAD")
    return { base: mergeBase(cwd, a, b), head: b }
  }
  const double = /^(.*?)\.\.(.*)$/.exec(rev)
  if (double) {
    return { base: resolveCommitish(cwd, double[1] || "HEAD"), head: resolveCommitish(cwd, double[2] || "HEAD") }
  }
  if (rev.endsWith("^!")) {
    const head = resolveCommitish(cwd, rev.slice(0, -2))
    const parent = gitTry(["rev-parse", "--verify", "--quiet", `${head}^`], { cwd })?.trim()
    return { base: parent || emptyTree(cwd), head }
  }
  return null
}

/** Resolve SPEC in worktree CWD to the two objects `git diff SPEC` would compare. */
export function resolveSpec(spec: string[], cwd: string): Resolved {
  const { revs, cached, mergeBase: useMergeBase } = parseSpec(spec, cwd)
  const workingSide = () => (cached ? indexTree(cwd) : worktreeTree(cwd))

  if (revs.length === 0) {
    return cached ? { base: resolveCommitish(cwd, "HEAD"), head: indexTree(cwd) } : { base: indexTree(cwd), head: worktreeTree(cwd) }
  }
  if (revs.length === 1) {
    const rev = revs[0]!
    const range = rangeSides(cwd, rev)
    if (range) return range
    const commit = resolveCommitish(cwd, rev)
    const base = useMergeBase ? mergeBase(cwd, commit, resolveCommitish(cwd, "HEAD")) : commit
    return { base, head: workingSide() }
  }
  const a = resolveCommitish(cwd, revs[0]!)
  const b = resolveCommitish(cwd, revs[1]!)
  return { base: useMergeBase ? mergeBase(cwd, a, b) : a, head: b }
}
