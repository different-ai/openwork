import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { chrome } from "@openwork/hosts"
import { captureScreenshot, evaluate } from "@openwork/cdp"
import type { UpgradeLab } from "./den-super-admin-upgrade.ts"
import { decodePng } from "../packages/test-evidence/src/screen-change.ts"

/** Supplementary real Den Web images; API assertions decide the test verdict. */
export async function capturePreservedTeam(lab: UpgradeLab, teamId: string, setId: string) {
  await lab.serveWeb()
  await using browser = await chrome({ name: "exp-o2-preserved-team", headless: true, startUrl: "http://127.0.0.1:38920" })
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.client.send("Page.navigate", { url: "http://127.0.0.1:38920" })
  const readyBy = Date.now() + 60_000
  while (Date.now() < readyBy) {
    if (await evaluate(browser.client, () => location.origin === "http://127.0.0.1:38920" && document.readyState === "complete")) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  assert.equal(await evaluate(browser.client, () => location.origin), "http://127.0.0.1:38920")
  // Authenticate the disposable fixture through the real web auth proxy. Never
  // inject markup, application stores, roles, permissions or layout changes.
  const status = await evaluate(browser.client, async () => {
    const response = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ email: "exp-o2-owner@example.test", password: "Exp-o2-Disposable-123!" }) })
    return response.status
  })
  assert.equal(status, 200)
  for (const [label, path, expected] of [
    ["team", `/dashboard/members/teams/${teamId}`, "Super Admins Permissions"],
    ["permissions", `/dashboard/permissions/${setId}`, "Super Admins Permissions"],
  ]) {
    await browser.client.send("Page.navigate", { url: `http://127.0.0.1:38920${path}` })
    const end = Date.now() + 60_000
    let healthy = false
    while (Date.now() < end) {
      const view = await evaluate(browser.client, () => ({ text: document.body.innerText, width: document.body.getBoundingClientRect().width, height: document.body.getBoundingClientRect().height, dialog: document.querySelector('[role="dialog"]') !== null }))
      healthy = view.text.includes(expected) && view.width >= 1000 && view.height > 500 && !view.dialog && !view.text.includes("Application error")
      if (healthy) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    await evaluate(browser.client, async () => { await document.fonts.ready; return true })
    const png = await captureScreenshot(browser.client)
    writeFileSync(new URL(`../../exp-o2-${label}.png`, import.meta.url), png)
    assert.ok(healthy, `${label}: settled real content, healthy dimensions and no unexpected overlay`)
    const pixels = decodePng(png)
    assert.ok(pixels)
    const values: number[] = []
    for (let y = 100; y < Math.min(900, pixels.height); y += 5)
      for (let x = 360; x < Math.min(1300, pixels.width); x += 5) values.push(pixels.rgb[(y * pixels.width + x) * 3])
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    assert.ok(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length > 25, "main content pixels have meaningful variance")
  }
}
