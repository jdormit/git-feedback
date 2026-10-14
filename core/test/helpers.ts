import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { realpathSync } from "node:fs"
import { git } from "../src/git"

export interface TestRepo {
  dir: string
  git(...args: string[]): string
  write(path: string, content: string): void
  commit(message: string, files?: Record<string, string>): string
  cleanup(): void
}

export function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n"
}

export function makeRepo(): TestRepo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fdbk-test-")))
  const run = (...args: string[]) => git(args, { cwd: dir })
  run("init", "-q", "-b", "main")
  run("config", "user.name", "Test User")
  run("config", "user.email", "test@example.com")
  run("config", "commit.gpgsign", "false")
  const write = (path: string, content: string) => {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return {
    dir,
    git: run,
    write,
    commit(message, files = {}) {
      for (const [path, content] of Object.entries(files)) write(path, content)
      run("add", "-A")
      run("commit", "-q", "--allow-empty", "-m", message)
      return run("rev-parse", "HEAD").trim()
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
