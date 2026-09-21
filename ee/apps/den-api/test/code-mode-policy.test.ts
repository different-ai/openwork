import { expect, test } from "bun:test"
import { codeModeSettingWriteAllowed, organizationCodeModeEnabled } from "../src/mcp/code-mode-policy.js"

test("a stored Code Mode opt-in is inert until the deployment enables it", () => {
  const optedIn = { codeModeEnabled: true }
  expect(organizationCodeModeEnabled(optedIn, { optInEnabled: false })).toBe(false)
  expect(organizationCodeModeEnabled(optedIn, { optInEnabled: true })).toBe(true)
})

test("the deployment switch alone never turns Code Mode on", () => {
  for (const metadata of [null, undefined, {}, { codeModeEnabled: false }, { codeModeEnabled: "true" }]) {
    expect(organizationCodeModeEnabled(metadata, { optInEnabled: true })).toBe(false)
  }
})

test("settings writes can only turn Code Mode on when the deployment allows it", () => {
  expect(codeModeSettingWriteAllowed(true, { optInEnabled: false })).toBe(false)
  expect(codeModeSettingWriteAllowed(true, { optInEnabled: true })).toBe(true)
  // Clearing a stale opt-in and untouched writes stay allowed either way.
  for (const optInEnabled of [false, true]) {
    expect(codeModeSettingWriteAllowed(false, { optInEnabled })).toBe(true)
    expect(codeModeSettingWriteAllowed(undefined, { optInEnabled })).toBe(true)
  }
})
