import type { GitHubApi } from "../src/github"

interface FakeReviewComment {
  id: number
  review_id: number | null
  in_reply_to_id?: number
  path: string
  line: number | null
  start_line?: number | null
  side: "LEFT" | "RIGHT"
  start_side?: "LEFT" | "RIGHT" | null
  subject_type: "line" | "file"
  body: string
  user: { login: string; type: string }
  created_at: string
  html_url: string
  diff_hunk: string
  outdated?: boolean
}

interface FakeIssueComment {
  id: number
  body: string
  user: { login: string; type: string }
  created_at: string
  html_url: string
}

interface FakeReview {
  id: number
  body: string
  state: string
  user: { login: string; type: string }
  submitted_at: string
  html_url: string
}

export class FakeGitHub implements GitHubApi {
  calls: Array<{ method: string; path: string; body?: any }> = []
  reviewComments: FakeReviewComment[] = []
  issueComments: FakeIssueComment[] = []
  reviews: FakeReview[] = []
  resolved = new Set<number>()
  private nextId = 1000
  private clock = 0

  constructor(
    public pr: { number: number; title: string; headSha: string; baseRef: string; repo: string },
    public viewer = "jdormit",
  ) {}

  private stamp() {
    return new Date(Date.UTC(2026, 9, 1, 0, 0, this.clock++)).toISOString()
  }

  private user(login = this.viewer) {
    return { login, type: login.endsWith("[bot]") ? "Bot" : "User" }
  }

  addRemoteThread(c: Partial<FakeReviewComment> & { path: string; body: string; line: number | null }) {
    const comment: FakeReviewComment = {
      id: this.nextId++,
      review_id: this.nextId++,
      side: "RIGHT",
      subject_type: "line",
      user: this.user("alice"),
      created_at: this.stamp(),
      html_url: "https://github.com/x",
      diff_hunk: "@@ -1 +1 @@\n+x",
      ...c,
    }
    this.reviewComments.push(comment)
    return comment
  }

  addRemoteReply(rootId: number, body: string, login = "alice") {
    const root = this.reviewComments.find((c) => c.id === rootId)!
    const comment: FakeReviewComment = { ...root, id: this.nextId++, in_reply_to_id: rootId, body, user: this.user(login), created_at: this.stamp() }
    this.reviewComments.push(comment)
    return comment
  }

  addIssueComment(body: string, login = "alice") {
    const c = { id: this.nextId++, body, user: this.user(login), created_at: this.stamp(), html_url: "https://github.com/i" }
    this.issueComments.push(c)
    return c
  }

  async request(method: string, path: string, body?: any): Promise<any> {
    this.calls.push({ method, path, body })
    const base = `/repos/${this.pr.repo}`
    const n = this.pr.number
    if (method === "GET" && path === `${base}/pulls/${n}`) {
      return {
        number: n,
        title: this.pr.title,
        html_url: `https://github.com/${this.pr.repo}/pull/${n}`,
        head: { sha: this.pr.headSha },
        base: { ref: this.pr.baseRef },
      }
    }
    if (method === "POST" && path === `${base}/pulls/${n}/reviews`) {
      const review: FakeReview = {
        id: this.nextId++,
        body: body.body ?? "",
        state: body.event,
        user: this.user(),
        submitted_at: this.stamp(),
        html_url: "https://github.com/r",
      }
      this.reviews.push(review)
      for (const c of body.comments ?? []) {
        this.reviewComments.push({
          id: this.nextId++,
          review_id: review.id,
          path: c.path,
          line: c.line,
          start_line: c.start_line ?? null,
          side: c.side,
          start_side: c.start_side ?? null,
          subject_type: "line",
          body: c.body,
          user: this.user(),
          created_at: this.stamp(),
          html_url: "https://github.com/c",
          diff_hunk: "@@",
        })
      }
      return review
    }
    let m = new RegExp(`^${base}/pulls/${n}/comments/(\\d+)/replies$`).exec(path)
    if (method === "POST" && m) return this.addRemoteReply(Number(m[1]), body.body, this.viewer)
    if (method === "POST" && path === `${base}/pulls/${n}/comments`) {
      const c = this.addRemoteThread({ path: body.path, line: null, body: body.body, subject_type: "file", user: this.user() })
      return c
    }
    if (method === "POST" && path === `${base}/issues/${n}/comments`) return this.addIssueComment(body.body, this.viewer)
    m = new RegExp(`^${base}/pulls/comments/(\\d+)$`).exec(path)
    if (method === "PATCH" && m) {
      const c = this.reviewComments.find((x) => x.id === Number(m![1]))!
      c.body = body.body
      return c
    }
    m = new RegExp(`^${base}/issues/comments/(\\d+)$`).exec(path)
    if (method === "PATCH" && m) {
      const c = this.issueComments.find((x) => x.id === Number(m![1]))!
      c.body = body.body
      return c
    }
    throw new Error(`FakeGitHub: unhandled ${method} ${path}`)
  }

  async paginate(path: string): Promise<any[]> {
    this.calls.push({ method: "GET", path })
    const base = `/repos/${this.pr.repo}`
    const n = this.pr.number
    const p = path.split("?")[0]
    if (p === `${base}/issues/${n}/comments`) return this.issueComments
    if (p === `${base}/pulls/${n}/reviews`) return this.reviews
    const m = new RegExp(`^${base}/pulls/${n}/reviews/(\\d+)/comments$`).exec(p!)
    if (m) return this.reviewComments.filter((c) => c.review_id === Number(m[1]))
    throw new Error(`FakeGitHub: unhandled paginate ${path}`)
  }

  async graphql(query: string, variables: Record<string, any>): Promise<any> {
    this.calls.push({ method: "GRAPHQL", path: query.trim().split(/\s+/).slice(0, 2).join(" "), body: variables })
    if (query.includes("resolveReviewThread") || query.includes("unresolveReviewThread")) {
      const id = Number(String(variables["threadId"]).slice(2))
      if (query.includes("unresolveReviewThread")) this.resolved.delete(id)
      else this.resolved.add(id)
      return {}
    }
    const roots = this.reviewComments.filter((c) => !c.in_reply_to_id)
    const nodes = roots.map((root) => {
      const comments = [root, ...this.reviewComments.filter((c) => c.in_reply_to_id === root.id)]
      return {
        id: `T_${root.id}`,
        isResolved: this.resolved.has(root.id),
        isOutdated: !!root.outdated,
        path: root.path,
        line: root.outdated ? null : root.line,
        startLine: root.outdated ? null : (root.start_line ?? null),
        originalLine: root.line,
        originalStartLine: root.start_line ?? null,
        diffSide: root.side,
        startDiffSide: root.start_side ?? null,
        subjectType: root.subject_type === "file" ? "FILE" : "LINE",
        comments: {
          nodes: comments.map((c) => ({
            databaseId: c.id,
            url: c.html_url,
            body: c.body,
            createdAt: c.created_at,
            diffHunk: c.diff_hunk,
            author: { login: c.user.login, __typename: c.user.type === "Bot" ? "Bot" : "User" },
            pullRequestReview: { state: this.reviews.find((r) => r.id === c.review_id)?.state ?? "COMMENTED" },
          })),
        },
      }
    })
    return {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
      },
    }
  }
}
