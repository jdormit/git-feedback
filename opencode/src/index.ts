import { Plugin, Skill } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { formatReview, summarize } from "../../core/src/format"
import { openRepo } from "../../core/src/git"
import { addThread, refreshReview, reply, setResolved } from "../../core/src/review"
import { ReviewStore } from "../../core/src/store"
import type { Author } from "../../core/src/types"

const ADDRESS_REVIEW = `Address the open review comments on this change.

Use execute to call the git-feedback tools at their exact paths in the Code Mode catalog.

1. Use review_show to read the unresolved threads.
2. For each thread, decide whether the feedback is right. Make the code change when it is.
3. Call review_refresh after editing, so threads follow the code.
4. Reply to every thread with review_reply: say what you changed, or explain why you disagree.
   Resolve a thread only when you made the requested change. Leave questions and disagreements open for the reviewer.
5. Finish with a short summary of what you changed and which threads still need the reviewer.`

const reviewArg = {
  type: "string",
  description: "Review id or id prefix. Defaults to the only open review in this repository.",
} as const
const threadArg = { type: "string", description: "Thread id or prefix" } as const

function object(properties: Record<string, object>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false } as const
}

function withoutMention<T extends { mention?: unknown }>({ mention, ...attachment }: T) {
  return attachment
}

type ReviewArgs = { review?: string }

function loadSkill(path: string) {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
  const [, frontmatter = "", content = text] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? []
  const field = (key: string) => frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim()
  return Skill.Info.make({
    id: Skill.ID.make("fdbk"),
    name: Skill.Name.make(field("name") ?? "fdbk"),
    description: field("description"),
    path: Skill.Info.fields.path.make(path),
    content: content.trim(),
  })
}

const listOutput = {
  anyOf: [
    object({
      reviews: {
        type: "array",
        items: object({
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["open", "closed"] },
          spec: { type: "array", items: { type: "string" } },
          worktree: { type: "string" },
          revisions: { type: "integer" },
          threads: { type: "integer" },
          unresolved: { type: "integer" },
          updatedAt: { type: "string" },
          github: { type: "string" },
        }, ["id", "title", "status", "spec", "worktree", "revisions", "threads", "unresolved", "updatedAt"]),
      },
    }, ["reviews"]),
    object({ error: { type: "string" } }, ["error"]),
  ],
}

export default Plugin.define({
  id: "git-feedback",
  async setup(ctx) {
    const author: Author = {
      name: typeof ctx.options["author"] === "string" ? ctx.options["author"] : "opencode",
      kind: "agent",
    }
    const directory = ctx.location.directory

    const withStore = async (fn: (store: ReviewStore, toplevel: string) => string) => {
      try {
        const repo = openRepo(directory)
        return { content: fn(new ReviewStore(repo), repo.toplevel) }
      } catch (e) {
        return { content: `Error: ${(e as Error).message}` }
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "review_list",
        description: "List git-feedback code reviews in this repository, with their ids and open thread counts.",
        input: object({ all: { type: "boolean", description: "Include closed reviews" } }),
        output: listOutput,
        execute: async (input) => {
          const args = input as { all?: boolean }
          try {
            const reviews = new ReviewStore(openRepo(directory)).list().filter((r) => args.all || r.status === "open").map(summarize)
            const content = reviews.length
              ? reviews.map((r) => `${r.id}  ${r.status}  ${r.unresolved} open  ${r.title}  (git diff ${r.spec.join(" ")})`).join("\n")
              : "No reviews."
            return { content, output: { reviews } }
          } catch (e) {
            const content = `Error: ${(e as Error).message}`
            return { content, output: { error: content } }
          }
        },
      })
      editor.add({
        name: "review_show",
        description:
          "Show a code review's comment threads with the code they refer to. Re-anchors threads to the current code first. " +
          "Shows unresolved threads unless include_resolved is set.",
        input: object({ review: reviewArg, include_resolved: { type: "boolean" } }),
        execute: async (input) => {
          const args = input as ReviewArgs & { include_resolved?: boolean }
          return withStore((store, toplevel) => {
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
      })
      editor.add({
        name: "review_refresh",
        description: "Record the current code as a new review revision and move threads onto it. Call after editing code under review.",
        input: object({ review: reviewArg }),
        execute: async (input) => {
          const args = input as ReviewArgs
          return withStore((store, toplevel) => {
            const { review, changed } = refreshReview(store, store.select(args.review, toplevel).id)
            if (!changed) return "No changes since the last revision."
            const outdated = review.threads.filter((t) => t.outdated && !t.resolved).length
            return `Now at revision ${review.target.revisions.length}. ${outdated} unresolved thread(s) are outdated because their code changed.`
          })
        },
      })
      editor.add({
        name: "review_reply",
        description: "Reply to a review thread, optionally resolving it.",
        input: object(
          {
            review: reviewArg,
            thread: threadArg,
            body: { type: "string", description: "Reply text (Markdown)" },
            resolve: { type: "boolean", description: "Resolve the thread after replying" },
          },
          ["thread", "body"],
        ),
        execute: async (input) => {
          const args = input as ReviewArgs & { thread: string; body: string; resolve?: boolean }
          return withStore((store, toplevel) => {
            const id = store.select(args.review, toplevel).id
            const { thread } = reply(store, id, args.thread, args.body, author)
            if (args.resolve) setResolved(store, id, thread.id, true)
            return `Replied to thread ${thread.id}${args.resolve ? " and resolved it" : ""}.`
          })
        },
      })
      editor.add({
        name: "review_resolve",
        description: "Resolve or reopen a review thread.",
        input: object(
          {
            review: reviewArg,
            thread: threadArg,
            resolved: { type: "boolean", description: "false reopens the thread. Defaults to true." },
          },
          ["thread"],
        ),
        execute: async (input) => {
          const args = input as ReviewArgs & { thread: string; resolved?: boolean }
          return withStore((store, toplevel) => {
            const resolved = args.resolved ?? true
            const { thread } = setResolved(store, store.select(args.review, toplevel).id, args.thread, resolved)
            return `Thread ${thread.id} ${resolved ? "resolved" : "reopened"}.`
          })
        },
      })
      editor.add({
        name: "review_comment",
        description:
          "Start a new review thread. Give path and line for a line comment (side 'new' is the changed code, 'old' the original), " +
          "path alone for a file comment, or neither for a comment on the whole review.",
        input: object(
          {
            review: reviewArg,
            body: { type: "string", description: "Comment text (Markdown)" },
            path: { type: "string", description: "File path relative to the repository root" },
            line: { type: "integer", minimum: 1 },
            start_line: { type: "integer", minimum: 1, description: "First line of a multi-line comment" },
            side: { type: "string", enum: ["old", "new"] },
          },
          ["body"],
        ),
        execute: async (input) => {
          const args = input as ReviewArgs & { body: string; path?: string; line?: number; start_line?: number; side?: "old" | "new" }
          return withStore((store, toplevel) => {
            if ((args.line || args.start_line || args.side) && !args.path) throw new Error("line, start_line and side need path")
            const { thread } = addThread(store, store.select(args.review, toplevel).id, {
              location: args.path ? { path: args.path, line: args.line, startLine: args.start_line, side: args.side } : undefined,
              body: args.body,
              author,
            })
            return `Added thread ${thread.id}.`
          })
        },
      })
    })

    const skill = loadSkill(fileURLToPath(new URL("../../skills/fdbk/SKILL.md", import.meta.url)))
    await ctx.skill.transform((editor) => {
      if (!editor.get(skill.id)) editor.add(skill)
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "address-review",
        description: "Work through open git-feedback comments: fix code, reply and resolve.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = [ADDRESS_REVIEW, prompt.text.trim()].filter(Boolean).join("\n\n")
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text,
            delivery,
            files: prompt.files?.map(withoutMention),
            agents: prompt.agents?.map(withoutMention),
            skills: prompt.skills?.map(withoutMention),
          })
        },
      })
    })
  },
})
