import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8")

describe("Automation editor state", () => {
  test("background detail refetches do not replace unsaved edits", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("initialKey={detail.revision.id}")

    const editor = read("src/react-app/domains/automations/automation-editor.tsx")
    expect(editor).toContain("appliedInitialKey.current === props.initialKey")
    expect(editor).toContain("appliedInitialKey.current = props.initialKey")
  })
})
