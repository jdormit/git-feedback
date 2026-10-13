import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { formatReview, summarize } from "../../core/src/format"
import { openRepo } from "../../core/src/git"
import { addThread, refreshReview, reply, setResolved } from "../../core/src/review"
import { ReviewStore } from "../../core/src/store"
import type { Author } from "../../core/src/types"

const ADDRESS_REVIEW = `Address the open review comments on this change.

1. Call review_show to read the unresolved threads.
2. For each thread, decide whether the feedback is right. Make the code change when it is.
3. Call review_refresh after editing, so threads follow the code.
4. Reply to every thread with review_reply: say what you changed, or explain why you disagree.
   Resolve a thread only when you made the requested change. Leave questions and disagreements open for the reviewer.
5. Finish with a short summary of what you changed and which threads still need the reviewer.

$ARGUMENTS`

const reviewArg = tool.schema.string().optional().describe("Review id or id prefix. Defaults to the only open review in this repository.")

export const ReviewPlugin: Plugin = async (_input, options) => {
  const author: Author = {
    name: typeof options?.["author"] === "string" ? options["author"] : "opencode",
    kind: "agent",
  }

  const withStore = async (directory: string, fn: (store: ReviewStore, toplevel: string) => string): Promise<string> => {
    try {
      const repo = openRepo(directory)
      return fn(new ReviewStore(repo), repo.toplevel)
    } catch (e) {
      return `Error: ${(e as Error).message}`
    }
  }

  return {
    async config(config) {
      config.command ??= {}
      config.command["address-review"] ??= {
        description: "Work through open git-universal-review comments: fix code, reply and resolve.",
        template: ADDRESS_REVIEW,
      }
    },
    tool: {
      review_list: tool({
        description: "List git-universal-review code reviews in this repository, with their ids and open thread counts.",
        args: { all: tool.schema.boolean().optional().describe("Include closed reviews") },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store) => {
            const rows = store.list().filter((r) => args.all || r.status === "open").map(summarize)
            if (!rows.length) return "No reviews."
            return rows.map((r) => `${r.id}  ${r.status}  ${r.unresolved} open  ${r.title}  (git diff ${r.spec.join(" ")})`).join("\n")
          })
        },
      }),
      review_show: tool({
        description:
          "Show a code review's comment threads with the code they refer to. Re-anchors threads to the current code first. " +
          "Shows unresolved threads unless include_resolved is set.",
        args: {
          review: reviewArg,
          include_resolved: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store, toplevel) => {
            let review = store.select(args.review, toplevel)
            let warning = ""
            try {
              review = refreshReview(store, review.id).review
            } catch (e) {
              warning = `Warning: could not re-anchor to the current code (${(e as Error).message}).\n\n`
            }
            return warning + formatReview(review, { includeResolved: args.include_resolved })
          })
        },
      }),
      review_refresh: tool({
        description: "Record the current code as a new review revision and move threads onto it. Call after editing code under review.",
        args: { review: reviewArg },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store, toplevel) => {
            const { review, changed } = refreshReview(store, store.select(args.review, toplevel).id)
            if (!changed) return "No changes since the last revision."
            const outdated = review.threads.filter((t) => t.outdated && !t.resolved).length
            return `Now at revision ${review.target.revisions.length}. ${outdated} unresolved thread(s) are outdated because their code changed.`
          })
        },
      }),
      review_reply: tool({
        description: "Reply to a review thread, optionally resolving it.",
        args: {
          review: reviewArg,
          thread: tool.schema.string().describe("Thread id or prefix"),
          body: tool.schema.string().describe("Reply text (Markdown)"),
          resolve: tool.schema.boolean().optional().describe("Resolve the thread after replying"),
        },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store, toplevel) => {
            const id = store.select(args.review, toplevel).id
            const { thread } = reply(store, id, args.thread, args.body, author)
            if (args.resolve) setResolved(store, id, thread.id, true)
            return `Replied to thread ${thread.id}${args.resolve ? " and resolved it" : ""}.`
          })
        },
      }),
      review_resolve: tool({
        description: "Resolve or reopen a review thread.",
        args: {
          review: reviewArg,
          thread: tool.schema.string().describe("Thread id or prefix"),
          resolved: tool.schema.boolean().optional().describe("false reopens the thread. Defaults to true."),
        },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store, toplevel) => {
            const resolved = args.resolved ?? true
            const { thread } = setResolved(store, store.select(args.review, toplevel).id, args.thread, resolved)
            return `Thread ${thread.id} ${resolved ? "resolved" : "reopened"}.`
          })
        },
      }),
      review_comment: tool({
        description:
          "Start a new review thread. Give path and line for a line comment (side 'new' is the changed code, 'old' the original), " +
          "path alone for a file comment, or neither for a comment on the whole review.",
        args: {
          review: reviewArg,
          body: tool.schema.string().describe("Comment text (Markdown)"),
          path: tool.schema.string().optional().describe("File path relative to the repository root"),
          line: tool.schema.number().int().positive().optional(),
          start_line: tool.schema.number().int().positive().optional().describe("First line of a multi-line comment"),
          side: tool.schema.enum(["old", "new"]).optional(),
        },
        async execute(args, ctx) {
          return withStore(ctx.directory, (store, toplevel) => {
            if ((args.line || args.start_line || args.side) && !args.path) throw new Error("line, start_line and side need path")
            const { thread } = addThread(store, store.select(args.review, toplevel).id, {
              location: args.path ? { path: args.path, line: args.line, startLine: args.start_line, side: args.side } : undefined,
              body: args.body,
              author,
            })
            return `Added thread ${thread.id}.`
          })
        },
      }),
    },
  }
}

export default ReviewPlugin
