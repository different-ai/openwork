import { z } from "zod"
import { boundedJson } from "../utils/bounded-json.js"
import { senderDomainFromEmail, type ActionCategory } from "./classifier.js"

const ENDPOINT = "https://core-api.uk.plain.com/graphql/v1"
const RESPONSE_LIMIT = 256 * 1024
const PAGE_SIZE = 25
const TIMELINE_PAGE_LIMIT = 8
const identifier = z.string().max(128).regex(/^[A-Za-z0-9_-]+$/u)
const entity = z.object({ id: identifier })
const dateTime = z.object({ iso8601: z.string().datetime({ offset: true }).transform((text) => new Date(text)) })
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(4096).nullish() })
const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
const summary = entity.extend({ createdAt: dateTime, title: z.string(), previewText: z.string().nullish() })
const timelineEntry = z.object({
  timestamp: dateTime,
  actor: z.object({ __typename: z.string() }),
  llmText: z.string().nullish(),
  entry: z.object({ __typename: z.string(), textContent: z.string().nullish(), text: z.string().nullish(),
    components: z.array(z.object({ plainText: z.string().optional() })).optional() }),
})
const evidence = z.object({
  title: z.string(), channel: z.string(), customer: z.object({ email: z.object({ email: z.string() }) }),
  firstInboundMessageInfo: z.object({ timestamp: dateTime }).nullish(),
  timelineEntries: z.object({ pageInfo, edges: z.array(z.object({ node: timelineEntry })) }),
})
const state = z.object({ priority: z.number().int(), status: z.string(), labels: z.array(z.object({ labelType: entity })) })
const mutationError = z.object({ code: z.string() }).nullish()
const threadMutation = z.object({ thread: entity.nullish(), error: mutationError })
const labelMutation = z.object({ labelType: entity.nullish(), error: mutationError })
const labels: Record<ActionCategory, { name: string; externalId: string }> = {
  bug: { name: "Product bug", externalId: "openwork_triage_bug" },
  enterprise: { name: "Enterprise lead", externalId: "openwork_triage_enterprise" },
  job_ask: { name: "Job ask", externalId: "openwork_triage_job_ask" },
  pitch: { name: "Pitch", externalId: "openwork_triage_pitch" },
}

export type PlainThreadSummary = z.infer<typeof summary>
export type PlainClient = ReturnType<typeof createPlainClient>

export function createPlainClient({ apiKey, fetch: send = globalThis.fetch }: { apiKey: string; fetch?: typeof fetch }) {
  const labelIds = new Map<ActionCategory, Promise<string>>()
  async function query<T>(document: string, variables: Record<string, unknown>, schema: z.ZodType<T>) {
    try {
      const response = await send(ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: document, variables }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error("Plain request failed")
      }
      const body = envelope.parse(await boundedJson(response, RESPONSE_LIMIT))
      if (body.errors?.length) throw new Error("Plain GraphQL request failed")
      return schema.parse(body.data)
    } catch {
      throw new Error("Plain request failed")
    }
  }

  function lookupLabel(externalId: string) {
    return query(`query SupportTriageLabel($externalId: ID!) {
      labelTypeByExternalId(externalId: $externalId) { id }
    }`, { externalId }, z.object({ labelTypeByExternalId: entity.nullable() }))
  }

  async function ensureLabel(category: ActionCategory) {
    const input = labels[category]
    const existing = await lookupLabel(input.externalId)
    if (existing.labelTypeByExternalId) return existing.labelTypeByExternalId.id
    try {
      const { createLabelType } = await query(`mutation SupportTriageCreateLabel($input: CreateLabelTypeInput!) {
        createLabelType(input: $input) { labelType { id } error { code } }
      }`, { input }, z.object({ createLabelType: labelMutation }))
      if (!createLabelType.error && createLabelType.labelType) return createLabelType.labelType.id
    } catch {
      const concurrent = await lookupLabel(input.externalId)
      if (concurrent.labelTypeByExternalId) return concurrent.labelTypeByExternalId.id
      throw new Error("Plain label creation failed")
    }
    const concurrent = await lookupLabel(input.externalId)
    if (concurrent.labelTypeByExternalId) return concurrent.labelTypeByExternalId.id
    throw new Error("Plain label creation failed")
  }

  return {
    async workspaceId() {
      const { myWorkspace } = await query(`query SupportTriageWorkspace { myWorkspace { id } }`, {}, z.object({ myWorkspace: entity }))
      return myWorkspace.id
    },
    async threads(afterTime: Date, beforeTime: Date, after: string | null) {
      const { threads } = await query(`query SupportTriageThreads($filters: ThreadsFilter!, $first: Int!, $after: String) {
        threads(filters: $filters, sortBy: {field: CREATED_AT, direction: ASC}, first: $first, after: $after) {
          edges { node { id createdAt { iso8601 } title previewText } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { filters: { createdAt: { after: afterTime.toISOString(), before: beforeTime.toISOString() } }, first: PAGE_SIZE, after },
      z.object({ threads: z.object({ edges: z.array(z.object({ node: summary })), pageInfo }) }))
      return threads
    },
    async evidence(threadId: string) {
      let after: string | null = null
      let form: { time: number; text: string } | undefined
      for (let page = 0; page < TIMELINE_PAGE_LIMIT; page++) {
        const result: { thread: z.infer<typeof evidence> } = await query(`query SupportTriageEvidence($threadId: ID!, $first: Int!, $after: String) {
          thread(threadId: $threadId) {
            title channel customer { email { email } }
            firstInboundMessageInfo { timestamp { iso8601 } }
            timelineEntries(first: $first, after: $after, filters: {entryTypes: [EMAIL, CHAT, SLACK_MESSAGE, SLACK_REPLY, DISCORD_MESSAGE, MS_TEAMS_MESSAGE, HELP_CENTER_AI_CONVERSATION_MESSAGE, CUSTOM]}) {
              pageInfo { hasNextPage endCursor }
              edges { node { actor { __typename } timestamp { iso8601 } llmText entry {
                __typename
                ... on EmailEntry { textContent }
                ... on CustomEntry { components { ... on ComponentPlainText { plainText } } }
              } } }
            }
          }
        }`, { threadId, first: 10, after }, z.object({ thread: evidence }))
        const { title, channel, customer, firstInboundMessageInfo, timelineEntries } = result.thread
        const senderDomain = senderDomainFromEmail(customer.email.email)
        for (const { node } of timelineEntries.edges) {
          const time = node.timestamp.iso8601.getTime()
          if (node.actor.__typename === "CustomerActor" && time === firstInboundMessageInfo?.timestamp.iso8601.getTime()) {
            return { title, senderDomain, firstMessage: node.entry.textContent ?? node.llmText ?? "" }
          }
          if (channel === "API" && node.entry.__typename === "CustomEntry" && (!form || time < form.time)) {
            const text = node.entry.components?.flatMap(({ plainText }) => plainText ? [plainText] : []).join("\n")
            if (text) form = { time, text }
          }
        }
        const next: string | null | undefined = timelineEntries.pageInfo.endCursor
        if (!timelineEntries.pageInfo.hasNextPage) {
          if (firstInboundMessageInfo && !form) break
          return { title, senderDomain, firstMessage: form?.text ?? "" }
        }
        if (!next || next === after) break
        after = next
      }
      throw new Error("Plain first message unavailable")
    },
    async senderDomain(threadId: string) {
      const { thread } = await query(`query SupportTriageSenderDomain($threadId: ID!) {
        thread(threadId: $threadId) { customer { email { email } } }
      }`, { threadId }, z.object({ thread: evidence.pick({ customer: true }) }))
      return senderDomainFromEmail(thread.customer.email.email)
    },
    async threadState(threadId: string) {
      const { thread } = await query(`query SupportTriageThreadState($threadId: ID!) {
        thread(threadId: $threadId) { priority status labels { labelType { id } } }
      }`, { threadId }, z.object({ thread: state }))
      return thread
    },
    labelId(category: ActionCategory) {
      const existing = labelIds.get(category)
      if (existing) return existing
      const pending = ensureLabel(category).catch((error: unknown) => { labelIds.delete(category); throw error })
      labelIds.set(category, pending)
      return pending
    },
    async addLabel(threadId: string, labelTypeId: string) {
      const { addLabels } = await query(`mutation SupportTriageAddLabel($input: AddLabelsInput!) {
        addLabels(input: $input) { thread { id } error { code } }
      }`, { input: { threadId, labelTypeIds: [labelTypeId] } }, z.object({ addLabels: threadMutation }))
      if (addLabels.error || addLabels.thread?.id !== threadId) throw new Error("Plain label application failed")
    },
    async setPriority(threadId: string, priority: number) {
      const { changeThreadPriority } = await query(`mutation SupportTriageChangePriority($input: ChangeThreadPriorityInput!) {
        changeThreadPriority(input: $input) { thread { id } error { code } }
      }`, { input: { threadId, priority } }, z.object({ changeThreadPriority: threadMutation }))
      if (changeThreadPriority.error || changeThreadPriority.thread?.id !== threadId) throw new Error("Plain priority change failed")
    },
    async markDone(threadId: string) {
      const { markThreadAsDone } = await query(`mutation SupportTriageMarkDone($input: MarkThreadAsDoneInput!) {
        markThreadAsDone(input: $input) { thread { id } error { code } }
      }`, { input: { threadId } }, z.object({ markThreadAsDone: threadMutation }))
      if (markThreadAsDone.error || markThreadAsDone.thread?.id !== threadId) throw new Error("Plain status change failed")
    },
  }
}
