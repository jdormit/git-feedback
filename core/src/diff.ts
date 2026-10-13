import { git } from "./git"
import type { Side } from "./types"

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of diff.split("\n")) {
    const m = HUNK_HEADER.exec(line)
    if (!m) continue
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    })
  }
  return hunks
}

/** Map an old-side line through zero-context HUNKS; null if the line itself changed. */
export function mapLine(hunks: Hunk[], line: number): number | null {
  let delta = 0
  for (const h of hunks) {
    if (h.oldCount === 0) {
      // A pure insertion sits after line oldStart.
      if (line > h.oldStart) delta += h.newCount
      continue
    }
    const end = h.oldStart + h.oldCount - 1
    if (line >= h.oldStart && line <= end) return null
    if (line > end) delta += h.newCount - h.oldCount
  }
  return line + delta
}

/** Zero-context hunks between two blobs given as `<treeish>:<path>`, or null for binary content. */
export function hunksBetween(cwd: string, from: string, to: string, context = 0): Hunk[] | null {
  const out = git(["diff", `-U${context}`, "--no-color", "--no-ext-diff", "--no-textconv", from, to], { cwd })
  if (/^Binary files .* differ$/m.test(out)) return null
  return parseHunks(out)
}

/**
 * Paths that differ between two tree-ishes, keyed by their old path.
 * The value is the new path, or null when the file was deleted.
 */
export function changedPaths(cwd: string, from: string, to: string): Map<string, string | null> {
  const out = git(["diff", "--name-status", "-z", "-M", "--no-ext-diff", from, to], { cwd })
  const fields = out.split("\0")
  const result = new Map<string, string | null>()
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]
    if (!status) continue
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[i++]!
      const newPath = fields[i++]!
      if (status.startsWith("R")) result.set(oldPath, newPath)
    } else {
      const path = fields[i++]!
      if (status === "D") result.set(path, null)
      else if (status !== "A") result.set(path, path)
    }
  }
  return result
}

/** Whether LINE on SIDE falls inside one of the (context-including) HUNKS. */
export function lineInHunks(hunks: Hunk[], side: Side, line: number): boolean {
  return hunks.some((h) => {
    const start = side === "old" ? h.oldStart : h.newStart
    const count = side === "old" ? h.oldCount : h.newCount
    return line >= start && line < start + count
  })
}
