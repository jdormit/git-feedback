import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Repo } from "./git"
import { SCHEMA_VERSION, type Review } from "./types"

const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class ReviewStore {
  readonly dir: string

  constructor(readonly repo: Repo) {
    this.dir = join(repo.commonDir, "universal-review", "reviews")
  }

  path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  list(): Review[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [this.load(f.slice(0, -5))]
        } catch (e) {
          process.stderr.write(`gur: skipping ${f}: ${(e as Error).message}\n`)
          return []
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  load(id: string): Review {
    const file = this.path(id)
    if (!existsSync(file)) throw new Error(`No review with id ${id}`)
    const review = JSON.parse(readFileSync(file, "utf8")) as Review
    if (review.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Review ${id} has schema version ${review.schemaVersion}; this tool reads ${SCHEMA_VERSION}`)
    }
    return review
  }

  create(review: Review): void {
    mkdirSync(this.dir, { recursive: true })
    this.withLock(review.id, () => this.write(review))
  }

  /** Apply FN to the stored review under the lock, saving it if FN changed anything. */
  mutate<T>(id: string, fn: (review: Review) => T): T {
    return this.withLock(id, () => {
      const review = this.load(id)
      const before = JSON.stringify(review)
      const result = fn(review)
      if (JSON.stringify(review) !== before) {
        review.updatedAt = new Date().toISOString()
        this.write(review)
      }
      return result
    })
  }

  remove(id: string): void {
    this.withLock(id, () => rmSync(this.path(id), { force: true }))
  }

  /**
   * Pick a review: by id or unique id prefix, then $GUR_REVIEW, then the only open
   * review (preferring ones whose worktree is TOPLEVEL).
   */
  select(idOrPrefix?: string, toplevel: string = this.repo.toplevel): Review {
    const wanted = idOrPrefix || process.env["GUR_REVIEW"]
    const all = this.list()
    if (wanted) {
      if (existsSync(this.path(wanted))) return this.load(wanted)
      const matches = all.filter((r) => r.id.startsWith(wanted))
      if (matches.length === 1) return matches[0]!
      throw new Error(matches.length ? `Review id ${wanted} is ambiguous` : `No review with id ${wanted}`)
    }
    const open = all.filter((r) => r.status === "open")
    const here = open.filter((r) => r.target.worktree === toplevel)
    const candidates = here.length ? here : open
    if (candidates.length === 1) return candidates[0]!
    if (candidates.length === 0) throw new Error("No open reviews. Start one with `gur start`.")
    const listing = candidates.map((r) => `  ${r.id}  ${r.title}`).join("\n")
    throw new Error(`Several open reviews; pass --review <id>:\n${listing}`)
  }

  private write(review: Review): void {
    const file = this.path(review.id)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(review, null, 2) + "\n")
    renameSync(tmp, file)
  }

  private withLock<T>(id: string, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true })
    const lock = join(this.dir, `${id}.lock`)
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let fd: number | undefined
    while (fd === undefined) {
      try {
        fd = openSync(lock, "wx")
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
        if (age > STALE_LOCK_MS) rmSync(lock, { force: true })
        else if (Date.now() > deadline) throw new Error(`Timed out waiting for lock on review ${id}`)
        else sleep(25)
      }
    }
    try {
      return fn()
    } finally {
      closeSync(fd)
      rmSync(lock, { force: true })
    }
  }
}
