export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`)
  }
}

export interface GitOptions {
  cwd: string
  input?: string
  env?: Record<string, string>
}

export function git(args: string[], opts: GitOptions): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  })
  if (proc.exitCode !== 0) {
    throw new GitError(args, proc.exitCode ?? -1, proc.stderr.toString())
  }
  return proc.stdout.toString()
}

export function gitTry(args: string[], opts: GitOptions): string | null {
  try {
    return git(args, opts)
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
}

export interface Repo {
  /** Top level of the worktree the command runs in. */
  toplevel: string
  /** Shared git directory, the same for every worktree. */
  commonDir: string
}

export function openRepo(cwd: string): Repo {
  const out = git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd })
  const [toplevel, commonDir] = out.trim().split("\n")
  if (!toplevel || !commonDir) throw new Error(`Not inside a git worktree: ${cwd}`)
  return { toplevel, commonDir }
}

/** Return the full object name for REV, or null if it does not name an object. */
export function resolveObject(cwd: string, rev: string): string | null {
  return gitTry(["rev-parse", "--verify", "--quiet", `${rev}^{object}`], { cwd })?.trim() || null
}

/** Prefer the commit REV points at; fall back to whatever object it names. */
export function resolveCommitish(cwd: string, rev: string): string {
  const commit = gitTry(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd })?.trim()
  if (commit) return commit
  const obj = resolveObject(cwd, rev)
  if (!obj) throw new Error(`Unknown revision: ${rev}`)
  return obj
}

export function emptyTree(cwd: string): string {
  return git(["mktree"], { cwd, input: "" }).trim()
}

/** File content at TREEISH:PATH split into lines, or null if the path does not exist there. */
export function readLines(cwd: string, treeish: string, path: string): string[] | null {
  const out = gitTry(["cat-file", "blob", `${treeish}:${path}`], { cwd })
  if (out === null) return null
  const result = out.split("\n")
  if (result[result.length - 1] === "") result.pop()
  return result
}

export function configValue(cwd: string, key: string): string | null {
  return gitTry(["config", "--get", key], { cwd })?.trim() || null
}
