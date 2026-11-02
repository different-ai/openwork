import assert from "node:assert/strict";
import { test } from "node:test";
import { workplaceNext } from "./workplace-agent.ts";

const TOOLS = ["search_capabilities", "execute_capability"];
const user = (text: string) => ({ role: "user", content: text });
const call = (name: string) => ({ role: "assistant", content: [{ type: "tool_use", id: name, name, input: {} }] });
const result = (value: unknown) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: JSON.stringify(value) }] }] });
const EVENT = { id: "evt-1", subject: "Supplier sync", start: "2026-11-04T18:00:00.0000000", end: "2026-11-04T18:30:00.0000000" };

test("moving a meeting finds it, then reschedules it with the same length and confirmed notifications", () => {
  const messages = [user('move the meeting "Supplier sync" to 2026-11-05T18:00:00Z')];
  assert.deepEqual(workplaceNext(messages, TOOLS), { tool: "search_capabilities", input: { query: "list Microsoft 365 calendar events", limit: 10 } });
  messages.push(call("search_capabilities"), result({ matches: [{ name: "native:microsoft-365:list", method: "GET", path: "/v1/capabilities/microsoft-365/calendar-events" }] }));
  const list = workplaceNext(messages, TOOLS);
  assert.ok("tool" in list && list.input.name === "native:microsoft-365:list");
  messages.push(call("execute_capability"), result({ ok: true, events: [EVENT] }));
  assert.deepEqual(workplaceNext(messages, TOOLS), { tool: "search_capabilities", input: { query: "reschedule Outlook calendar event", limit: 10 } });
  messages.push(call("search_capabilities"), result({ matches: [{ name: "native:microsoft-365:update", method: "PATCH", path: "/v1/capabilities/microsoft-365/calendar-events/{eventId}" }] }));
  assert.deepEqual(workplaceNext(messages, TOOLS), { tool: "execute_capability", input: { name: "native:microsoft-365:update", path: { eventId: "evt-1" }, body: { confirmNotifications: true, start: "2026-11-05T18:00:00.000Z", end: "2026-11-05T18:30:00.000Z" } } });
  messages.push(call("execute_capability"), result({ ok: true, event: { ...EVENT, start: "2026-11-05T18:00:00.0000000" } }));
  assert.deepEqual(workplaceNext(messages, TOOLS), { text: 'Moved "Supplier sync" to 2026-11-05T18:00:00.0000000.' });
});

test("a failed read is reported, a new request starts over, and unknown requests get the help line", () => {
  const messages = [user('find the meeting "Supplier sync"'), call("search_capabilities"), result({ matches: [{ name: "n", method: "GET", path: "/v1/capabilities/microsoft-365/calendar-events" }] }), call("execute_capability"), result({ error: "needs_connection", message: "Connect Microsoft 365" })];
  assert.deepEqual(workplaceNext(messages, TOOLS), { text: "I couldn't read your calendar: Connect Microsoft 365." });
  messages.push({ role: "assistant", content: [{ type: "text", text: "…" }] }, user('find the file "notes"'));
  assert.deepEqual(workplaceNext(messages, TOOLS), { tool: "search_capabilities", input: { query: "search OneDrive files", limit: 10 } });
  assert.match(JSON.stringify(workplaceNext([user("hello")], TOOLS)), /I can find a meeting/);
  assert.deepEqual(workplaceNext([user('find the meeting "x"')], []), { text: "I can't reach your connected apps from here." });
});
