import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { z } from "zod";
import { checkoutRepository, checkoutTitle, cloudCodingChatApprovalWorld } from "../worlds/cloud-coding-chat-approval.ts";

const test = spec.world(cloudCodingChatApprovalWorld, {
  timeout: 600_000, needs: { commands: ["pnpm", "git", "npm"] },
  resources: { surfaces: ["appWeb", "web"], services: ["den", "mock"] },
});
const branch = "openwork/fix-rounding";
const deniedBranch = "openwork/declined-rounding";
const prompt = `Push to ${checkoutRepository}?`;
const pendingPath = "/v1/cloud-coding/approvals?status=pending";
const requestLine = /Asked Maya Chen to approve[^\n]*/;
const approvalList = z.object({ approvals: z.array(z.object({ id: z.string(), headSha: z.string(), branch: z.string() })) });
const button = (label: string) => ({ role: "button", label }) as const;

test("a person approves a push from their chat and the pull request opens in their name", async ({ world, user, probe, step, evidence }) => {
  const chat = user.on(world.app);
  const dashboard = user.on(world.dashboard);
  await step("before: the chat has no pending push and GitHub has no new branch", async () => {
    await chat.see("composer", { timeoutMs: 45_000 });
    await chat.notSee({ text: prompt });
    const pending = await probe.api(world.maya, pendingPath);
    expect(pending.response.status).toBe(200);
    expect(pending.body).toMatchObject({ approvals: [] });
    const writes = world.git.writes();
    const newBranch = await world.git.readBranch(checkoutRepository, branch);
    expect(writes).toHaveLength(0);
    expect(newBranch).toBeNull();
    evidence.recordAssertionEvidence("No push is waiting in Maya's chat", `The composer shows no push request. GitHub recorded ${writes.length} writes and has no ${branch} branch.`, newBranch === null && writes.length === 0);
    await chat.screenshot();
  });

  const task = await step("OpenWork starts the code change on a cloud computer", async () => {
    const started = await world.startTask();
    expect(started.status).toBe("running");
    expect(started.leakedSetupCode).toBe(false);
    evidence.recordAssertionEvidence("OpenWork starts the checkout fix without sharing its setup code", `The agent got ${started.status}. The setup code arrived only in the cloud computer's kickoff.`, started.status === "running" && !started.leakedSetupCode);
    return started;
  });

  const request = await step("the cloud computer clones the repository, fixes the bug and asks for the push", async () => {
    const requested = await task.requestPush(branch);
    const asked = requestLine.exec(requested.output)?.[0];
    expect(requested.code, requested.output).toBe(3);
    expect(asked).toBeDefined();
    evidence.recordAssertionEvidence("The computer waits for Maya's decision", `npm test: 1 passed. The helper exited ${requested.code} (waiting). ${asked}`, requested.code === 3 && Boolean(asked));
    return requested;
  });

  const approval = await step("after: the chat shows the push for approval and nothing has reached GitHub", async () => {
    await chat.see({ text: prompt }, { timeoutMs: 30_000 });
    await chat.see({ text: branch });
    await chat.see({ text: /1 file changed/ });
    await chat.see({ text: "Tests passed" });
    await chat.see(button("Deny"));
    await chat.see(button("Allow once"));
    await chat.notSee(button("Always"));
    await chat.click({ text: /^Files changed$/ });
    await chat.see({ text: "src/total.js" });
    await chat.click({ text: /^Test result$/ });
    await chat.see({ text: "1 passed" });
    const { body } = await probe.api(world.maya, pendingPath);
    const [pending] = approvalList.parse(body).approvals;
    expect(pending?.branch).toBe(branch);
    if (!pending) throw new Error("Maya has no pending push.");
    const writes = world.git.writes();
    const newBranch = await world.git.readBranch(checkoutRepository, branch);
    expect(writes).toHaveLength(0);
    expect(newBranch).toBeNull();
    evidence.recordAssertionEvidence("Maya can review the change without sending it", `${prompt} ${branch} · 1 file changed (src/total.js) · Tests passed · Deny / Allow once. GitHub recorded ${writes.length} writes; no new branch exists.`, writes.length === 0 && newBranch === null);
    await chat.screenshot();
    return pending;
  });

  await step("the person chooses Allow once", async () => {
    await chat.click(button("Allow once"));
    const progress = `Allowed. Pushing ${branch}…`;
    await chat.see({ text: progress });
    evidence.recordAssertionEvidence("The chat acknowledges the one-time approval", progress, await probe.on(world.app).has(progress));
    await chat.screenshot();
  });

  const link = await step("the cloud computer pushes the approved commit and opens the pull request", async () => {
    const result = await request.wait();
    expect(result.code, result.output).toBe(0);
    const url = /Pull request opened: (\S+)/.exec(result.output)?.[1];
    const pushed = await world.git.readBranch(checkoutRepository, branch);
    const main = await world.git.readBranch(checkoutRepository, "main");
    const writes = world.git.writes();
    const allMaya = writes.length > 0 && writes.every(write => write.credential === "user" && write.login === "maya-chen");
    const saved = await probe.api(world.maya, `/v1/cloud-coding/approvals/${approval.id}`);
    expect(saved.response.status).toBe(200);
    expect(saved.body).toMatchObject({ headSha: approval.headSha, pullRequest: { url } });
    expect(url).toBeDefined();
    expect(pushed?.sha).toBe(approval.headSha);
    expect(pushed?.parent).toBe(world.mainSha);
    expect(pushed?.author).toMatch(/^Maya Chen <101\+maya-chen@users\.noreply\.github\.com> /);
    expect(main?.sha).toBe(world.mainSha);
    expect(allMaya).toBe(true);
    expect(world.git.pulls()).toMatchObject([{ number: 1, html_url: url, title: checkoutTitle, user: { login: "maya-chen" } }]);
    evidence.recordAssertionEvidence("Only the approved commit goes to GitHub, as Maya", `The helper exited ${result.code}: Pull request opened: ${url}. The approved and pushed commits match (${pushed?.sha.slice(0, 12)}). All ${writes.length} GitHub writes used Maya's token. The commit is authored by Maya Chen and main is unchanged.`, allMaya && pushed?.sha === approval.headSha && main?.sha === world.mainSha);
    return url;
  });

  await step("after: the chat shows the pull request link", async () => {
    const opened = "Pull request opened · acme/storefront #1";
    await chat.see({ text: opened });
    await chat.see(button("Open pull request"));
    await chat.see("composer");
    evidence.recordAssertionEvidence("Maya can open the pull request from her chat", `${opened}. The panel offers Open pull request.`, await probe.on(world.app).has(opened));
    await chat.screenshot();
  });

  await step("Den lists the pull request under Recent pull requests", async () => {
    await dashboard.reload();
    await dashboard.see({ role: "heading", label: "Recent pull requests" }, { timeoutMs: 45_000 });
    await dashboard.wheelAt({ x: 1000, y: 800, deltaY: 850 });
    await dashboard.see({ role: "link", label: checkoutTitle });
    await dashboard.see({ text: "acme/storefront #1 · Open" });
    const rows = (await probe.on(world.dashboard).dom("tr")).elements;
    const row = rows.find(entry => entry.text.includes(checkoutTitle));
    expect(row?.text).toContain("Maya Chen");
    expect(link).toBeDefined();
    expect(await probe.on(world.dashboard).linkTargets("a")).toContain(link);
    evidence.recordAssertionEvidence("Recent pull requests credits Maya for the checkout fix", `${checkoutTitle} · acme/storefront #1 · Open · Maya Chen`, row?.text.includes("Maya Chen") === true);
    await dashboard.screenshot();
  });
});

test("a person denies a push and nothing is pushed", async ({ world, user, step, evidence }) => {
  const chat = user.on(world.app);
  const request = await step("before: another checkout change is waiting for Maya's decision", async () => {
    const task = await world.startTask();
    const requested = await task.requestPush(deniedBranch);
    expect(requested.code, requested.output).toBe(3);
    await chat.see({ text: prompt }, { timeoutMs: 45_000 });
    await chat.see({ text: deniedBranch });
    await chat.see(button("Deny"));
    const writes = world.git.writes();
    expect(writes).toHaveLength(0);
    evidence.recordAssertionEvidence("The separate change waits without writing to GitHub", `${deniedBranch} waits for Maya. GitHub has ${writes.length} writes.`, writes.length === 0);
    await chat.screenshot();
    return requested;
  });
  await step("after: Maya denies, and nothing is pushed", async () => {
    await chat.click(button("Deny"));
    const denied = "Denied. Nothing was pushed.";
    await chat.see({ text: denied });
    const done = await request.wait();
    const writes = world.git.writes();
    expect(done.code, done.output).toBe(4);
    expect(done.output).toMatch(/denied/i);
    expect(writes).toHaveLength(0);
    expect(await world.git.readBranch(checkoutRepository, deniedBranch)).toBeNull();
    expect(world.git.pulls()).toHaveLength(0);
    evidence.recordAssertionEvidence("Deny leaves GitHub untouched", `${denied} The helper exited ${done.code} (denied): ${done.output.trim()}. GitHub has ${writes.length} writes, no new branch, and no pull request.`, done.code === 4 && writes.length === 0);
    await chat.screenshot();
  });
});
