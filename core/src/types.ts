export const SCHEMA_VERSION = 1

/** Which side of the diff a line belongs to: `old` is the base, `new` is the head. */
export type Side = "old" | "new"

export interface Author {
  name: string
  kind: "human" | "agent"
}

/** What the target's spec resolved to at one point in time. */
export interface Revision {
  n: number
  base: string
  head: string
  createdAt: string
}

export interface Target {
  /** Arguments passed verbatim to `git diff`. */
  spec: string[]
  /** Worktree the spec is resolved in; matters for HEAD, the index and the worktree. */
  worktree: string
  revisions: Revision[]
}

export type Anchor =
  | {
      kind: "line"
      revision: number
      path: string
      side: Side
      line: number
      startLine?: number
      /** Text of the anchored lines when the thread was created. */
      lines: string[]
    }
  | { kind: "file"; revision: number; path: string }
  | { kind: "review" }

/** Where a thread currently sits. Absent for review-level threads. */
export interface Position {
  revision: number
  path: string
  side?: Side
  line?: number
  startLine?: number
}

export interface GitHubCommentLink {
  id: number
  kind: "review-comment" | "issue-comment" | "review"
  url?: string
  /** Body as last synced, used to detect local edits. */
  body: string
}

export interface Comment {
  id: string
  author: Author
  body: string
  createdAt: string
  updatedAt?: string
  github?: GitHubCommentLink
}

export interface Thread {
  id: string
  anchor: Anchor
  position?: Position
  /** The anchored code changed after the thread was created. */
  outdated: boolean
  resolved: boolean
  comments: Comment[]
  github?: {
    kind: "review-thread" | "conversation"
    threadId?: string
    rootCommentId?: number
    /** Resolved state as last synced. */
    resolved?: boolean
    diffHunk?: string
  }
}

export interface GitHubLink {
  host: string
  repo: string
  number: number
  url: string
  title?: string
}

export interface Review {
  schemaVersion: typeof SCHEMA_VERSION
  id: string
  title: string
  status: "open" | "closed"
  createdAt: string
  updatedAt: string
  target: Target
  threads: Thread[]
  github?: GitHubLink
}
