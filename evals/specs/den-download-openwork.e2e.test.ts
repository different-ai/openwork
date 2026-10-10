import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denDownloadAdmin, denDownloadCapabilityOff, denDownloadFailures, denDownloadMember } from "../worlds/den-download-openwork.ts";

const admin = spec.world(denDownloadAdmin, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const failures = spec.world(denDownloadFailures, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const member = spec.world(denDownloadMember, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const capabilityOff = spec.world(denDownloadCapabilityOff, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });
const download = { testId: "den-download-openwork" };
const popover = { testId: "workspace-install-popover" };
const copy = { testId: "workspace-install-copy" };
const open = { testId: "workspace-install-open" };
const clipboardPermissionMessage = "Your browser didn't give permission to copy. Allow clipboard access and try again, or open the install page.";

admin("an admin shares and opens a workspace download from the shared header", async ({ world, user, probe, evidence, step }) => {
  let copiedUrl = "";
  await step("after: the admin finds Download OpenWork after Docs instead of a dashboard card", async () => {
    await user.see({ ...download, role: "button", label: "Download OpenWork" }, { timeoutMs: 90_000 });
    await user.notSee(popover);
    await user.notSee({ testId: "workspace-install-card" });
    await user.notSee({ text: "Download for this workspace" });
    const header = await probe.dom('header a, header [data-testid="den-download-openwork"]');
    const docsIndex = header.elements.findIndex((element) => element.text === "Docs");
    expect(docsIndex).toBeGreaterThanOrEqual(0);
    expect(header.elements[docsIndex + 1]?.text).toBe("Download OpenWork");
    evidence.recordAssertionEvidence("Download follows Docs with no old card or open panel", `Docs position=${docsIndex}; next=${header.elements[docsIndex + 1]?.text}; panel closed`, true);
    await user.screenshot();
  });

  await step("after: the download panel explains that teammates get this workspace already connected", async () => {
    await user.click(download);
    await user.see(popover);
    await user.see({ text: "Download for this workspace" });
    await user.see({ text: `Teammates get OpenWork already connected to ${world.organizationName}.` });
    await user.see(open);
    await user.see(copy);
    const requests = await world.mintRequests();
    expect(requests).toHaveLength(0);
    evidence.recordAssertionEvidence("Opening the panel offers both actions without minting a link", `mint requests=${requests.length}; workspace=${world.organizationName}`, requests.length === 0);
    await user.screenshot();
  });

  await step("the admin copies a genuine shareable link and sees Copied without losing the panel", async () => {
    await user.click(copy);
    await user.see(copy, { text: "Copied" });
    await user.see(popover);
    copiedUrl = await world.readClipboard();
    const resolved = await world.resolveInstallLink(copiedUrl);
    expect(resolved).toEqual({ status: 200, organizationName: world.organizationName, requireSignin: true });
    const requests = await world.mintRequests();
    expect(requests.map((request) => [request.status, request.faulted])).toEqual([[200, false]]);
    evidence.recordAssertionEvidence("The actual browser clipboard holds a valid link for this workspace", `mint=200; resolve=${resolved.status}; workspace=${resolved.organizationName}; sign-in required=${resolved.requireSignin}`, resolved.status === 200);
    await user.screenshot();
  });

  await step("the admin opens a real install tab for the same workspace", async () => {
    await user.click(open);
    const popup = await probe.eventually(() => world.installPopup(), {
      within: 30_000, label: "workspace install tab", until: (value) => value !== null,
    });
    if (!popup) throw new Error("The install action did not open a browser tab.");
    await user.on(popup.surface).see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 60_000 });
    await user.on(popup.surface).see({ role: "link", label: "I already installed OpenWork" });
    expect(popup.url).not.toBe(copiedUrl);
    const resolved = await world.resolveInstallLink(popup.url);
    expect(resolved.organizationName).toBe(world.organizationName);
    expect(resolved.status).toBe(200);
    evidence.recordAssertionEvidence("A new browser tab renders the genuine workspace install guide", `new token=true; resolve=${resolved.status}; workspace=${resolved.organizationName}`, resolved.status === 200);
    await user.on(popup.surface).screenshot();
  });

  await step("the same download remains usable on another page at a narrow window width", async () => {
    await user.navigate(new URL("/dashboard/members", world.den.ref.webUrl).toString());
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ ...download, role: "button", label: "Download OpenWork" }, { timeoutMs: 60_000 });
    await user.click(download);
    await user.see(popover);
    await user.see(copy);
    const geometry = await probe.dom('[data-testid="workspace-install-popover"]');
    const panel = geometry.elements[0];
    expect(panel).toBeDefined();
    expect(panel.rect.left).toBeGreaterThanOrEqual(0);
    expect(panel.rect.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(await world.location()).toBe("/dashboard/members");
    evidence.recordAssertionEvidence("The shared header keeps the panel inside the narrow viewport", `route=/dashboard/members; panel=${panel.rect.left}..${panel.rect.right}; viewport=${geometry.viewportWidth}`, panel.rect.left >= 0 && panel.rect.right <= geometry.viewportWidth);
    await user.screenshot();
    await user.press("Escape");
    await user.notSee(popover);
  });

  await user.navigate(new URL("/dashboard/custom-llm-providers", world.den.ref.webUrl).toString());
  for (const width of [375, 768, 800, 850, 1024, 1440]) {
    await step(`after: the long page title leaves download and search usable at ${width}px`, async () => {
      await user.resizeViewport({ width, height: 1000, deviceScaleFactor: 1 });
      await user.see({ text: "Bring your Own Keys" }, { timeoutMs: 60_000 });
      await user.see(download);
      const geometry = await probe.dom('header button, header a');
      const controls = geometry.elements.filter((element) => element.rect.width > 0 && element.rect.height > 0);
      for (const [index, control] of controls.entries()) {
        expect(control.rect.left).toBeGreaterThanOrEqual(0);
        expect(control.rect.right).toBeLessThanOrEqual(width);
        if (index > 0) expect(control.rect.left).toBeGreaterThanOrEqual(controls[index - 1].rect.right);
      }
      const label = await probe.dom('[data-testid="den-download-openwork"] span');
      expect(label.elements[0].rect.width > 0).toBe(width >= 640);
      const title = await probe.dom('header > div:first-child > span');
      expect(title.elements[0].rect.width).toBeGreaterThan(0);
      await user.click({ testId: "den-command-palette-trigger", nth: width >= 1024 ? 0 : 1 });
      await user.see({ testId: "den-command-palette-input" });
      await user.press("Escape");
      await user.notSee({ testId: "den-command-palette" });
      const restored = await probe.eventually(() => probe.dom('header [data-testid="den-command-palette-trigger"]'), {
        within: 5000, label: "focus returns to the visible search control", until: (value) => value.elements.some((element) => element.focused && element.rect.width > 0),
      });
      expect(restored.elements.some((element) => element.focused && element.rect.width > 0)).toBe(true);
      evidence.recordAssertionEvidence("The long-title header has no overlapping controls and restores search focus", `viewport=${width}; visible controls=${controls.length}; download label=${width >= 640 ? "visible" : "hidden"}; focus restored`, true);
      await user.screenshot();
    });
  }
});

failures("an admin can retry a failed mint and a denied clipboard without reopening the panel", async ({ world, user, probe, evidence, step }) => {
  await step("a failed install-link request leaves its error and both actions in the open panel", async () => {
    await user.see({ ...download, role: "button", label: "Download OpenWork" }, { timeoutMs: 90_000 });
    await user.click(download);
    expect(await world.mintRequests()).toHaveLength(0);
    await user.click(open);
    await user.see({ role: "alert" }, { text: "Install link temporarily unavailable. Please retry.", timeoutMs: 20_000 });
    await user.see(popover);
    await user.see(copy, { text: "Copy install link" });
    await user.see(open);
    await user.notSee({ role: "button", label: "Copied" });
    const alerts = await probe.dom('[data-testid="workspace-install-popover"] [role="alert"]');
    const mintError = alerts.elements.map((element) => element.text).join(" ");
    expect(mintError).toBe("Install link temporarily unavailable. Please retry.");
    expect(mintError).not.toMatch(/clipboard|permission|copied/i);
    const requests = await world.mintRequests();
    expect(requests.map((request) => [request.status, request.faulted])).toEqual([[503, true]]);
    const extraPages = await probe.eventually(() => world.newPageCount(), {
      within: 10_000, label: "failed install tab is closed", until: (count) => count === 0,
    });
    evidence.recordAssertionEvidence("The link failure stays distinct from clipboard permission and keeps both retry actions", `mint statuses=${requests.map((request) => request.status).join(",")}; inline error=${mintError}; extra tabs=${extraPages}; not copied`, extraPages === 0);
    await user.screenshot();
  });

  await step("after: denied clipboard access names the permission and next action without browser errors", async () => {
    await user.click(copy);
    const requests = await probe.eventually(() => world.mintRequests(), {
      within: 20_000, label: "retry reaches real minting", until: (entries) => entries.length === 2,
    });
    await user.see({ role: "alert" }, { text: clipboardPermissionMessage, timeoutMs: 20_000 });
    await user.see(popover);
    await user.see(copy, { text: "Copy install link" });
    await user.see(open);
    await user.notSee({ role: "button", label: "Copied" });
    expect(requests.map((request) => [request.status, request.faulted])).toEqual([[503, true], [200, false]]);
    const alerts = await probe.dom('[data-testid="workspace-install-popover"] [role="alert"]');
    const clipboardError = alerts.elements.map((element) => element.text).join(" ");
    expect(clipboardError).toBe(clipboardPermissionMessage);
    expect(clipboardError).toMatch(/denied|not allowed|permission/i);
    expect(clipboardError).not.toMatch(/Failed to execute|writeText|['"]Clipboard['"]|DOMException|NotAllowedError|\bat\s+\S+\s*\(/i);
    expect(clipboardError).not.toContain("Install link temporarily unavailable.");
    evidence.recordAssertionEvidence("A genuine clipboard denial shows safe recovery, not browser errors or a copied status", `mint statuses=503,200; inline error=${clipboardError}; both actions visible; not copied`, clipboardError === clipboardPermissionMessage);
    await user.screenshot();
  });

  await step("after: allowing clipboard access makes the next retry copy successfully and clear the error", async () => {
    await world.allowClipboard();
    await user.click(copy);
    await user.see(copy, { text: "Copied" });
    await user.notSee({ role: "alert" });
    await user.see(popover);
    const resolved = await world.resolveInstallLink(await world.readClipboard());
    expect(resolved).toEqual({ status: 200, organizationName: world.organizationName, requireSignin: true });
    const requests = await world.mintRequests();
    expect(requests.map((request) => request.status)).toEqual([503, 200, 200]);
    evidence.recordAssertionEvidence("Retry copies a valid workspace link without closing and reopening the panel", `mint statuses=503,200,200; resolve=${resolved.status}; error cleared`, resolved.status === 200);
    await user.screenshot();
  });
});

member("a member keeps both download actions and uses the header to go straight to install", async ({ world, user, probe, evidence, step }) => {
  await step("after: the member has header and in-page download actions for the same workspace", async () => {
    await user.see({ ...download, role: "link", label: "Download OpenWork" }, { timeoutMs: 90_000 });
    await user.see({ testId: "member-dashboard" });
    await user.see({ role: "heading", label: `${world.organizationName} is set up for you` });
    await user.see({ testId: "member-download-app", role: "button", label: "Get OpenWork" });
    await user.see({ role: "link", label: "Open OpenWork" });
    await user.notSee(popover);
    const href = await probe.dom('header a[data-testid="den-download-openwork"][href="/install"]');
    expect(href.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Members get a direct install link, not workspace sharing controls", "header href=/install; original Get OpenWork and Open OpenWork actions visible; panel absent", true);
    await user.screenshot();
  });

  await step("the member follows the header directly to the authenticated install guide", async () => {
    await user.click(download);
    await user.see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 60_000 });
    const location = await world.location();
    expect(location).toBe("/install");
    await user.notSee(popover);
    await user.notSee(copy);
    const requests = await world.mintRequests();
    expect(requests).toHaveLength(0);
    evidence.recordAssertionEvidence("The member reaches install without a token, popup, or minted share link", `path=${location}; mint requests=${requests.length}`, location === "/install" && requests.length === 0);
    await user.screenshot();
  });

  await step("the member's original Get OpenWork action still reaches the same install guide", async () => {
    await user.navigate(new URL("/dashboard", world.den.ref.webUrl).toString());
    await user.see({ testId: "member-download-app" }, { timeoutMs: 60_000 });
    await user.click({ testId: "member-download-app" });
    await user.see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 60_000 });
    const location = await world.location();
    expect(location).toBe("/install");
    expect(await world.mintRequests()).toHaveLength(0);
    evidence.recordAssertionEvidence("The original member download action is unchanged", `path=${location}; no minted share link`, location === "/install");
    await user.screenshot();
  });
});

capabilityOff("an admin without workspace install links gets the same direct download as a member", async ({ world, user, probe, evidence, step }) => {
  await step("before: workspace install links are disabled and the admin sees a direct header link", async () => {
    await user.see({ ...download, role: "link", label: "Download OpenWork" }, { timeoutMs: 90_000 });
    await user.notSee({ testId: "workspace-install-card" });
    await user.notSee(popover);
    const href = await probe.dom('header a[data-testid="den-download-openwork"][href="/install"]');
    expect(href.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Admin role alone does not expose workspace sharing", "installLinks=false; header href=/install; old card and panel absent", true);
    await user.screenshot();
  });

  await step("the admin follows Download OpenWork straight to install", async () => {
    await user.click(download);
    await user.see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 60_000 });
    const location = await world.location();
    expect(location).toBe("/install");
    await user.notSee(popover);
    evidence.recordAssertionEvidence("The disabled capability falls back to the ordinary install page", `path=${location}; no sharing panel`, location === "/install");
    await user.screenshot();
  });

  await step("after: the direct download offers installers without minting a shareable link", async () => {
    await user.see({ role: "link", label: "I already installed OpenWork" });
    await user.notSee(copy);
    const requests = await world.mintRequests();
    expect(requests).toHaveLength(0);
    evidence.recordAssertionEvidence("The capability-off admin never requests a workspace share link", `workspace=${world.organizationName}; mint requests=${requests.length}`, requests.length === 0);
    await user.screenshot();
  });
});
