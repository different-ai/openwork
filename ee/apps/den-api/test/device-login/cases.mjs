import assert from "node:assert/strict";

function expectProtocol(result, error, message) {
  assert.equal(result.status, 400, `${message} HTTP status must be 400.`);
  assert.equal(result.body?.error, error, message);
}
function polledAt(row) { return row?.lastPolledAt?.getTime() ?? null; }

export async function runCliCase(fixture, caseName) {
  const { report, browserA, readCode, sessionRows, runCli, getCliCode, validateToken, advanceTo, poll } = fixture;
  const before = await sessionRows();
  const { credentials } = await runCli();
  const code = getCliCode();
  assert.ok(code, "The CLI must receive a real device code.");
  assert.equal(report.codeTtlSeconds, 900, "The real Den code TTL must be 900 seconds.");
  assert.equal(report.codeIntervalSeconds, 5, "The real Den poll interval must be five seconds.");
  assert.equal(report.requestCounts["/api/auth/device/code"], 1, "The CLI must keep its original device code.");
  const after = await sessionRows();
  report.sessionDelta = after.length - before.length;

  if (caseName === "delayed") {
    assert.equal(report.cliExit, 0, "Expected CLI exit 0 after delayed approval.");
    assert.equal(report.approved, true, "The browser must approve after 130 seconds.");
    assert.ok(report.elapsedSeconds >= 130, "The CLI must wait at least 130 seconds.");
    assert.ok(report.plain429 && report.rate429Count >= 1, "The CLI must recover from a real plain HTTP 429.");
    assert.equal(report.sessionDelta, 1, "Delayed approval must create exactly one session.");
    assert.equal(report.credentialsWritten, true, "The CLI must save credentials after approval.");
    await validateToken(credentials.accessToken, browserA.user);
    assert.ok((await readCode(code)) === null, "The granted device code must be consumed.");
    report.sessionValidated = true;
    return;
  }

  assert.equal(report.cliExit, 1, "Denial or expiry must produce CLI exit 1.");
  assert.equal(report.credentialsWritten, false, "Denial or expiry must not save credentials.");
  assert.equal(report.sessionDelta, 0, "Denial or expiry must not create a session.");
  if (caseName === "denial") {
    assert.equal(report.cliError, "login_denied", "The CLI must report login_denied.");
    assert.equal(report.denied, true, "The browser must deny the device code.");
    assert.equal(report.approved, false, "A denied device code must not be approved.");
    assert.equal(report.cliPolls, 1, "The CLI must stop after the first denial response.");
    assert.equal(report.pollTrace[0].error, "access_denied", "Real Den must return access_denied.");
    assert.ok((await readCode(code)) === null, "The denied device code must be consumed.");
    return;
  }

  assert.equal(caseName, "expiry", "Select a supported CLI case.");
  assert.equal(report.cliError, "login_expired", "The CLI must report login_expired.");
  assert.equal(report.cliElapsedSeconds, 900, "The CLI must wait the full code TTL, then stop at its deadline.");
  assert.equal(report.approved, false, "The expiry case must remain pending.");
  assert.equal(report.denied, false, "The expiry case must not receive a denial.");
  const cliPolls = report.pollTrace.filter((item) => item.source === "cli");
  assert.ok(cliPolls.length > 20, "The pending CLI must continue after the first IP limit.");
  assert.ok(cliPolls.every((item) => item.elapsedSeconds < 900), "The CLI must not poll at or after its deadline.");
  const row = await readCode(code);
  assert.equal(row?.status, "pending", "The original code must remain pending until expiry.");
  assert.equal((row.expiresAt.getTime() - code.issuedAt) / 1000, 900, "The real database code TTL must be 900 seconds.");
  report.cliStoppedAtDeadline = true;

  // The CLI correctly stops before this request. Check the server's own expiry
  // branch separately. Use a fresh IP so the IP limiter cannot hide that branch.
  advanceTo(901);
  const expired = await poll(code, "192.0.2.11");
  expectProtocol(expired, "expired_token", "Den must return expired_token after the full TTL.");
  report.serverExpiryStatus = expired.status;
  report.serverExpiryElapsedSeconds = 901;
  assert.ok((await readCode(code)) === null, "The expired code must be deleted by the real token endpoint.");
  assert.equal((await sessionRows()).length, before.length, "The direct expiry probe must not create a session.");
}

export async function runAbuseIsolationCase(fixture) {
  const { report, browserA, createBrowser, issueCode, poll, decide, rawDecide, readCode, validateToken,
    advanceTo, snapshotCounters, sessionRows } = fixture;
  const browserB = await createBrowser("B", "192.0.2.21");
  const before = await sessionRows();
  const codeA = await issueCode();
  const codeB = await issueCode();
  assert.ok(codeA.device_code !== codeB.device_code, "The two device codes must differ.");
  assert.equal(codeA.expires_in, 900, "Device A must use the real code TTL.");
  assert.equal(codeB.expires_in, 900, "Device B must use the real code TTL.");
  report.limiterScope = "IP and endpoint; codes on one IP share its rate limit";

  advanceTo(5);
  expectProtocol(await poll(codeA), "authorization_pending", "The first device A poll must be pending.");
  const firstA = await readCode(codeA);
  const untouchedB = await readCode(codeB);
  assert.ok(polledAt(firstA) !== null, "The first poll must update device A lastPolledAt.");
  assert.equal(polledAt(untouchedB), null, "A poll for device A must not update device B lastPolledAt.");
  expectProtocol(await poll(codeA), "slow_down", "An immediate same-code poll must return slow_down.");
  assert.equal(polledAt(await readCode(codeA)), polledAt(firstA), "A slow_down response must not move lastPolledAt.");
  expectProtocol(await poll(codeB), "authorization_pending", "A first poll for device B must not inherit device A polling state.");
  const firstB = await readCode(codeB);
  assert.equal(firstB.status, "pending", "Device B must remain pending.");
  assert.equal((await readCode(codeA)).status, "pending", "Device A must remain pending.");

  // Three token requests already used the primary IP. Fill its 20-request
  // bucket with real, excessive requests. Do not write rate-limit rows by hand.
  for (let requests = 3; requests < 20; requests += 1) {
    expectProtocol(await poll(codeA), "slow_down", "Excessive polling must remain slow_down within the IP limit.");
  }
  const fullCounters = await snapshotCounters();
  const primaryCounter = fullCounters.find((row) => row.key.includes("192.0.2.10"));
  assert.equal(primaryCounter?.count, 20, "The primary IP database counter must reach 20.");
  const blockedA = await poll(codeA);
  assert.equal(blockedA.status, 429, "Request 21 from the primary IP must return HTTP 429.");
  const blockedB = await poll(codeB);
  assert.equal(blockedB.status, 429, "A second code on the same IP must share the full IP limit.");
  assert.equal(polledAt(await readCode(codeA)), polledAt(firstA), "IP refusal must not change device A polling state.");
  assert.equal(polledAt(await readCode(codeB)), polledAt(firstB), "IP refusal must not change device B polling state.");
  report.primaryIpLimitedAtRequest = 21;
  report.sharedIpCodeStatus = blockedB.status;

  advanceTo(10);
  const separateIp = await poll(codeB, "192.0.2.11");
  expectProtocol(separateIp, "authorization_pending", "A second IP must poll independently of the full primary IP limit.");
  const separateCounters = await snapshotCounters();
  assert.equal(separateCounters.find((row) => row.key.includes("192.0.2.10"))?.count, 20, "The primary counter must remain full.");
  assert.equal(separateCounters.find((row) => row.key.includes("192.0.2.11"))?.count, 1, "The second IP must have its own database counter.");
  assert.ok(polledAt(await readCode(codeB)) > polledAt(firstB), "A permitted poll must move only device B lastPolledAt.");
  assert.equal(polledAt(await readCode(codeA)), polledAt(firstA), "Device B polling must not change device A lastPolledAt.");
  // Per-device protection is shared across IPs, unlike the endpoint IP bucket.
  expectProtocol(await poll(codeB, "192.0.2.12"), "slow_down", "A new IP must not bypass same-code polling protection.");
  report.separateIpPollStatus = separateIp.status;
  report.pollStateIsolated = true;

  // Better Auth's own approve/deny endpoints skip Den's /device review, so a
  // signed-in browser cookie must not decide a code through them.
  const rawApproveA = await rawDecide(codeA, browserA, "approve");
  assert.equal(rawApproveA.status, 403, "Raw Better Auth device approval must be refused.");
  const rawDenyA = await rawDecide(codeA, browserA, "deny");
  assert.equal(rawDenyA.status, 403, "Raw Better Auth device denial must be refused.");
  const untouchedA = await readCode(codeA);
  assert.equal(untouchedA.status, "pending", "Refused raw decisions must leave device A pending.");
  assert.ok(untouchedA.userId === browserA.user.id, "Only Better Auth's verification claim may bind device A, to user A.");
  assert.equal(untouchedA.organizationId, null, "Refused raw decisions must not stage an organization for device A.");
  report.rawDecisionStatuses = { approve: rawApproveA.status, deny: rawDenyA.status };

  const approveA = await decide(codeA, browserA, "approve");
  assert.equal(approveA.status, 200, "Browser A must approve device A.");
  const approvedA = await readCode(codeA);
  const pendingB = await readCode(codeB);
  assert.equal(approvedA.status, "approved", "Device A must be approved.");
  assert.ok(approvedA.userId === browserA.user.id, "Device A must bind to user A.");
  assert.equal(pendingB.status, "pending", "Approving device A must not approve device B.");
  assert.ok(pendingB.userId === null, "Approving device A must not bind device B to a user.");
  const wrongUserDecision = await decide(codeA, browserB, "approve");
  assert.equal(wrongUserDecision.status, 404, "User B must not rebind user A's approved code.");
  const repeatedDecision = await decide(codeA, browserA, "approve");
  assert.equal(repeatedDecision.status, 409, "User A must not decide the same code twice.");
  assert.ok((await readCode(codeA)).userId === browserA.user.id, "Refused decisions must preserve device A's owner.");
  const approveB = await decide(codeB, browserB, "approve");
  assert.equal(approveB.status, 200, "Browser B must approve device B.");
  assert.ok((await readCode(codeB)).userId === browserB.user.id, "Device B must bind to user B.");
  assert.ok((await readCode(codeA)).userId === browserA.user.id, "Approving device B must not change device A's owner.");
  report.decisionStatuses = { approveA: approveA.status, wrongUser: wrongUserDecision.status,
    repeated: repeatedDecision.status, approveB: approveB.status };

  // Supply the other browser's bearer token. The approved device owner must
  // determine the issued session. The caller must not substitute its own user.
  const tokenA = await poll(codeA, "192.0.2.11", browserB.session);
  assert.equal(tokenA.status, 200, "Approved device A must receive a session.");
  await validateToken(tokenA.body?.access_token, browserA.user);
  const afterA = await sessionRows();
  assert.equal(afterA.filter((row) => row.userId === browserB.user.id).length,
    before.filter((row) => row.userId === browserB.user.id).length,
    "Redeeming device A must not create a session for user B.");
  assert.ok((await readCode(codeA)) === null, "Redeeming device A must consume only device A.");
  assert.equal((await readCode(codeB)).status, "approved", "Device B must remain approved until its own redemption.");

  advanceTo(15);
  const tokenB = await poll(codeB, "192.0.2.11", browserA.session);
  assert.equal(tokenB.status, 200, "Approved device B must receive a session.");
  await validateToken(tokenB.body?.access_token, browserB.user);
  assert.ok((await readCode(codeB)) === null, "Redeeming device B must consume device B.");
  const after = await sessionRows();
  report.sessionDelta = after.length - before.length;
  assert.equal(report.sessionDelta, 2, "Two approvals must create exactly two sessions.");
  for (const browser of [browserA, browserB]) {
    assert.equal(after.filter((row) => row.userId === browser.user.id).length,
      before.filter((row) => row.userId === browser.user.id).length + 1,
      "Each approving user must receive exactly one device session.");
  }
  advanceTo(20);
  expectProtocol(await poll(codeA, "192.0.2.11"), "invalid_grant", "A consumed code must not create another session.");
  assert.equal((await sessionRows()).length, after.length, "A replay must not create a session.");
  report.sessionValidated = true;
  report.decisionStateIsolated = true;
  report.sessionOwnersIsolated = true;
}
