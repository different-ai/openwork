#!/usr/bin/env node
// Smoke test: boots index.mjs as a real stdio MCP server and exercises every
// tool over JSON-RPC against the database at DATABASE_URL. Exits non-zero on
// any failure. Usage: DATABASE_URL=mysql://... node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

let failures = 0;

function report(label, passed, detail) {
  failures += passed ? 0 : 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function callTool(name, args, { expectError = false } = {}) {
  const response = await request("tools/call", { name, arguments: args });
  const result = response.result;
  const isError = Boolean(result?.isError);
  const text = result?.content?.[0]?.text ?? "";
  const passed = expectError ? isError : !isError && text.length > 0;
  report(`tools/call ${name}`, passed, passed ? summarize(name, text) : text.slice(0, 200));
  return text;
}

function summarize(name, text) {
  try {
    const data = JSON.parse(text);
    switch (name) {
      case "den_overview":
        return `users=${data.users.total} orgs=${data.organizations} dau=${data.activeUsers.daily} wau=${data.activeUsers.weekly} mau=${data.activeUsers.monthly} realDau=${data.realActiveUsers.daily} realWau=${data.realActiveUsers.weekly} realMau=${data.realActiveUsers.monthly}`;
      case "den_growth":
        return `buckets=${data.buckets.length} latestComplete=${JSON.stringify(data.latestCompletePeriod)}`;
      case "den_retention":
        return `cohorts=${data.cohorts.length} first=${JSON.stringify(data.cohorts[0] ?? null).slice(0, 120)}`;
      case "den_company_users":
        return `orgs=${data.organizations.length} members=${data.organizations[0]?.members.length ?? 0} domainUsers=${data.usersByEmailDomain.length}`;
      case "den_users_search":
        return `users=${data.users.length} first=${data.users[0]?.email ?? "none"}`;
      case "den_org_overview":
        return `org=${data.organization.slug} members7d=${data.activeMembersLast7d} roles=${JSON.stringify(data.membersByRole)}`;
      case "den_query":
        return `rows=${data.rowCount}`;
      default:
        return text.slice(0, 80);
    }
  } catch {
    return text.slice(0, 80);
  }
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "den-admin-mcp-smoke", version: "0.1.0" },
  });
  report("initialize", init.result?.serverInfo?.name === "den-admin");
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  const toolNames = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  report("tools/list", toolNames.length === 8, toolNames.join(", "));

  await callTool("den_admin_version", {});
  await callTool("den_overview", {});
  await callTool("den_growth", { metric: "users", interval: "month", periods: 6 });
  await callTool("den_retention", { weeks: 8 });
  await callTool("den_company_users", { company: "acme" });
  await callTool("den_users_search", { query: "alex" });
  await callTool("den_org_overview", { org: "acme-robotics-demo" });
  await callTool("den_query", { sql: "SELECT COUNT(*) AS users FROM user" });
  await callTool("den_query", { sql: "DELETE FROM user" }, { expectError: true });
  await callTool("den_query", { sql: "SELECT 1; SELECT 2" }, { expectError: true });
} catch (error) {
  failures += 1;
  console.error("FAIL ", error);
} finally {
  child.kill();
}

console.log(failures === 0 ? "\nSMOKE: all checks passed" : `\nSMOKE: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
