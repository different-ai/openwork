import { describe, expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"

import { accessFromGrants } from "../src/components/chat/created-skill-access"
import {
  collectCreatedSkills,
  createdSkillAccessLabel,
  createdSkillLibraryDetailId,
  savedSkillSentence,
  skillShareSentence,
  type CreatedSkillCard,
} from "../src/lib/created-skill"

const saved = { schemaVersion: "1", name: "Update CRM", pluginId: "plg_crm", skillId: "cob_crm", description: "Add clients and deals.", libraryUrl: null }

function createSkill(id: string, payload: Record<string, unknown> = saved, state: "output-available" | "input-available" = "output-available"): DynamicToolUIPart {
  const input = { pluginName: "Update CRM", skillMarkdown: "---\nname: update-crm\ndescription: x\n---\nSteps" }
  if (state === "input-available") return { type: "dynamic-tool", toolName: "openwork-cloud_create_skill", toolCallId: id, state, input }
  return {
    type: "dynamic-tool", toolName: "openwork-cloud_create_skill", toolCallId: id, state, input,
    output: "# Skill created: Update CRM",
    callProviderMetadata: { openwork: { mcpResult: { content: [{ type: "text", text: "# Skill created: Update CRM" }], structuredContent: payload } } },
  }
}

function share(id: string, state: "done" | "running" | "forbidden" | "other-member" | "unauthorized", member = "om_sam"): DynamicToolUIPart {
  const input = { name: "postPluginsAccess", path: { pluginId: "plg_crm" }, body: { orgMembershipId: member, role: "viewer" } }
  const base = { type: "dynamic-tool" as const, toolName: "openwork-cloud_execute_capability", toolCallId: id, input }
  if (state === "running") return { ...base, state: "input-available" }
  if (state === "forbidden") return { ...base, state: "output-error", errorText: JSON.stringify({ error: "forbidden", message: "Not allowed." }) }
  if (state === "unauthorized") return { ...base, state: "output-error", errorText: JSON.stringify({ error: "unauthorized" }) }
  const granted = state === "other-member" ? "om_other" : member
  return { ...base, state: "output-available", output: { ok: true, item: { id: "pag_1", orgMembershipId: granted, teamId: null, orgWide: false, role: "viewer", createdByOrgMembershipId: "om_me", createdAt: "2026-10-27T00:00:00Z", removedAt: null } } }
}

const directory: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_org", state: "output-available",
  input: { name: "getOrg" },
  output: { currentMember: { id: "om_me" }, members: [{ id: "om_sam", user: { name: "Sam Taylor", email: "sam@example.com" } }, { id: "om_nameless", user: {} }], teams: [] },
}

function turn(parts: UIMessage["parts"], text?: string): UIMessage[] {
  return [
    { id: "user_1", role: "user", parts: [{ type: "text", text: "Create a skill for this and share it with Sam." }] },
    { id: "reply_1", role: "assistant", parts: text ? [...parts, { type: "text", text }] : parts },
  ]
}

function ready(cards: CreatedSkillCard[]) {
  return cards.flatMap((card) => card.kind === "ready" ? [card] : [])
}

describe("created skill results", () => {
  test("a validated create_skill result becomes one private card placed after that call", () => {
    const { cards } = collectCreatedSkills(turn([createSkill("call_create")]), { live: false })
    const [card] = ready(cards)
    expect(cards).toHaveLength(1)
    expect(card).toMatchObject({ skillId: "cob_crm", pluginId: "plg_crm", name: "Update CRM", mode: "created", anchorToolCallId: "call_create" })
    expect(card && createdSkillAccessLabel(card)).toBe("Only you")
  })

  test("prose never creates a card or claims sharing", () => {
    const { cards } = collectCreatedSkills(turn([], "I created the Update CRM skill and shared it with Sam Taylor."), { live: false })
    expect(cards).toEqual([])
  })

  test("a result that fails the saved-skill schema renders no card", () => {
    const { skillId: _skillId, ...withoutId } = saved
    expect(collectCreatedSkills(turn([createSkill("call_create", withoutId)]), { live: false }).cards).toEqual([])
    const invocation: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_get_skill", toolCallId: "call_use", state: "output-available", input: { name: "update-crm" }, output: "---\nname: update-crm\n---" }
    expect(collectCreatedSkills(turn([invocation]), { live: false }).cards).toEqual([])
  })

  test("a later version and a later share update the same card instead of adding one", () => {
    const update: DynamicToolUIPart = { ...createSkill("call_update", { ...saved, mode: "updated", name: "Update CRM v2" }), toolName: "openwork-cloud_update_skill" }
    const messages = [...turn([createSkill("call_create")]), { id: "reply_2", role: "assistant" as const, parts: [update, directory, share("call_share", "done")] }]
    const { cards, shareLabels } = collectCreatedSkills(messages, { live: false })
    const [card] = ready(cards)
    expect(cards).toHaveLength(1)
    expect(card).toMatchObject({ name: "Update CRM v2", mode: "created", anchorToolCallId: "call_create" })
    expect(card && createdSkillAccessLabel(card)).toBe("Shared with Sam Taylor")
    expect(skillShareSentence(shareLabels.get("call_share") ?? null).past).toBe("Shared Update CRM v2 with Sam")
  })

  test("a share still running says so; once the run is no longer live it is unverified, not done", () => {
    const parts = [createSkill("call_create"), directory, share("call_share", "running")]
    const [running] = ready(collectCreatedSkills(turn(parts), { live: true }).cards)
    expect(running && createdSkillAccessLabel(running)).toBe("Sharing with Sam…")
    const [lost] = ready(collectCreatedSkills(turn(parts), { live: false }).cards)
    expect(lost?.pending?.state).toBe("unverified")
    expect(lost && createdSkillAccessLabel(lost)).toBe("Last confirmed: only you")
  })

  test("blocked and failed shares keep the last confirmed access", () => {
    const [blocked] = ready(collectCreatedSkills(turn([createSkill("call_create"), share("call_share", "forbidden")]), { live: false }).cards)
    expect(blocked?.pending).toMatchObject({ state: "failed", reason: "blocked" })
    expect(blocked && createdSkillAccessLabel(blocked)).toBe("Only you")
    const [signIn] = ready(collectCreatedSkills(turn([createSkill("call_create"), share("call_share", "unauthorized")]), { live: false }).cards)
    expect(signIn?.pending).toMatchObject({ state: "failed", reason: "sign-in" })
    expect(signIn && createdSkillAccessLabel(signIn)).toBe("Only you")
  })

  test("a grant for someone else does not confirm the requested share", () => {
    const [card] = ready(collectCreatedSkills(turn([createSkill("call_create"), share("call_share", "other-member")]), { live: false }).cards)
    expect(card?.access).toEqual({ kind: "private" })
    expect(card?.pending?.state).toBe("unverified")
  })

  test("a recipient without a confirmed name is never shown by id", () => {
    const [card] = ready(collectCreatedSkills(turn([createSkill("call_create"), directory, share("call_share", "done", "om_nameless")]), { live: false }).cards)
    expect(card && createdSkillAccessLabel(card)).toBe("Shared with 1 person")
  })

  test("a Code Mode script's own calls produce the same card, and an unanswered save loads only while live", () => {
    const script = (details: unknown[], status: "running" | "completed"): DynamicToolUIPart => ({
      type: "dynamic-tool", toolName: "execute", toolCallId: "call_script",
      ...(status === "running" ? { state: "input-available" as const } : { state: "output-available" as const, output: "done" }),
      input: { code: "await tools['openwork-cloud'].create_skill({...})" },
      callProviderMetadata: { openwork: { codeMode: {
        calls: [{ tool: "openwork-cloud.create_skill", status: "completed", input: { pluginName: "Update CRM" } }],
        details,
      } } },
    })
    const withResult = collectCreatedSkills(turn([script([{ tool: "openwork-cloud.create_skill", ordinal: 0, invocationId: "call_script:1", output: { structuredContent: saved } }], "completed")]), { live: false })
    expect(ready(withResult.cards)[0]).toMatchObject({ skillId: "cob_crm", anchorToolCallId: "call_script" })

    const pending = turn([script([], "running")])
    expect(collectCreatedSkills(pending, { live: true }).cards).toEqual([{ kind: "loading", key: "call_script:call:0", anchorToolCallId: "call_script" }])
    expect(collectCreatedSkills(pending, { live: false }).cards).toEqual([])
  })

  test("a save still running claims nothing", () => {
    expect(collectCreatedSkills(turn([createSkill("call_create", saved, "input-available")]), { live: true }).cards).toEqual([])
    expect(savedSkillSentence(createSkill("call_create", saved, "input-available"))?.present).toBe("Creating the Update CRM skill")
    expect(savedSkillSentence(createSkill("call_create"))?.past).toBe("Created the Update CRM skill")
  })

  test("Open targets the Library detail Library rows use for that plugin file", () => {
    expect(createdSkillLibraryDetailId({ pluginId: "plg_crm", skillId: "cob_crm" })).toBe("plugin:plg_crm/file/cob_crm")
  })

  test("checking status reads live grants; the owner's own grant is not sharing", () => {
    const people = { currentMemberId: "om_me", members: [{ id: "om_sam", name: "Sam Taylor", email: null }], teams: [] }
    expect(accessFromGrants([{ id: "g1", orgMembershipId: "om_me", teamId: null, orgWide: false, role: "editor" }], people)).toEqual({ kind: "private" })
    expect(accessFromGrants([{ id: "g2", orgMembershipId: "om_sam", teamId: null, orgWide: false, role: "viewer" }], people))
      .toEqual({ kind: "shared", recipients: [{ kind: "person", id: "om_sam", name: "Sam Taylor" }] })
  })
})
