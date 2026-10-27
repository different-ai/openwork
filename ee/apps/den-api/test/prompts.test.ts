import assert from "node:assert/strict"
import { test } from "node:test"
import { composeMemberPromptText, orgPromptWriteSchema, resolveMemberPrompts, type ResolvablePrompt } from "@openwork/types/den/prompts"

const member = "om_member"
const design = { id: "tm_design", name: "Design" }
const sales = { id: "tm_sales", name: "Sales" }
const engineering = { id: "tm_engineering", name: "Engineering" }

function prompt(id: string, content: string, assignment: Partial<ResolvablePrompt["assignment"]>, createdAt = 0): ResolvablePrompt {
  return { id, content, createdAt: new Date(createdAt), assignment: { everyone: false, teamIds: [], memberIds: [], ...assignment } }
}

test("everyone's prompt comes first, then each of the member's teams by name, then the member's own", () => {
  const resolved = resolveMemberPrompts({
    memberId: member,
    teams: [sales, design, engineering],
    prompts: [
      prompt("osp_mine", "Mine", { memberIds: [member] }, 0),
      prompt("osp_sales", "Sales", { teamIds: [sales.id] }, 1),
      prompt("osp_design", "Design", { teamIds: [design.id] }, 2),
      prompt("osp_everyone", "Everyone", { everyone: true }, 3),
      prompt("osp_other", "Other team", { teamIds: ["tm_other"] }, 4),
    ],
  })
  assert.deepEqual(resolved.map((entry) => [entry.id, entry.source, entry.teamName ?? null]), [
    ["osp_everyone", "organization", null],
    ["osp_design", "team", "Design"],
    ["osp_sales", "team", "Sales"],
    ["osp_mine", "member", null],
  ])
})

test("a prompt that applies more than once is added once, at its first place, and blank prompts are skipped", () => {
  const resolved = resolveMemberPrompts({
    memberId: member,
    teams: [sales, design],
    prompts: [
      prompt("osp_shared", "Shared", { teamIds: [sales.id, design.id], memberIds: [member] }),
      prompt("osp_blank", "   ", { everyone: true }),
    ],
  })
  assert.deepEqual(resolved.map((entry) => [entry.id, entry.teamName]), [["osp_shared", "Design"]])
})

test("the appended text joins the prompts with a blank line", () => {
  assert.equal(composeMemberPromptText([{ content: " First \n" }, { content: "Second" }]), "First\n\nSecond")
  assert.equal(composeMemberPromptText([]), "")
})

test("a saved prompt needs text and stays within the length limit", () => {
  assert.equal(orgPromptWriteSchema.safeParse({ content: "  " }).success, false)
  assert.equal(orgPromptWriteSchema.safeParse({ content: "x".repeat(20_001) }).success, false)
  assert.equal(orgPromptWriteSchema.safeParse({ content: "Answer in British English." }).success, true)
})
