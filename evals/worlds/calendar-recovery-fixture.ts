import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase, type Den } from "@openwork/env";
import { isRecord } from "./library.ts";

export const CALENDAR_RECONNECT_RECOVERY_NAME = "What's waiting on me";
// The real cloud-agent-executor message: the owner has a recovery action in its second sentence.
export const CALENDAR_RECONNECT_RECOVERY_MESSAGE = "OpenWork Connect is not ready in the Cloud runtime. Reconnect it before retrying this Automation.";

/** Arrange only the disposable demo world before the first user act; leave HubSpot's actionful reason intact. */
export async function seedCalendarReconnectRecovery(den: Den, organizationId: string) {
  if (!den.database) throw new Error("Calendar recovery arrangement requires its own disposable database");
  const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": organizationId };
  const list = async () => {
    const result = await denFetch(den.admin, "/v1/automations?limit=100", { headers });
    if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.items)) throw new Error("Could not read the seeded Calendar automations");
    return result.body.items.filter(isRecord);
  };
  const messageFor = (items: Record<string, unknown>[], name: string) => {
    const item = items.find((entry) => isRecord(entry.automation) && entry.automation.name === name);
    if (!item || !isRecord(item.automation) || !isRecord(item.automation.needsAttentionReason)) return "";
    const reason = item.automation.needsAttentionReason;
    return typeof reason.message === "string" ? reason.message : "";
  };
  const hubspotMessage = messageFor(await list(), "Update launch deals");
  if (!hubspotMessage) throw new Error("Missing the existing HubSpot blocked fixture");
  const rows = await queryDenDatabase(den.database.url, "SELECT name FROM automation WHERE name = ?", [CALENDAR_RECONNECT_RECOVERY_NAME]);
  if (rows.length !== 1) throw new Error("The disposable Calendar recovery fixture is not unique");
  await queryDenDatabase(den.database.url, "UPDATE automation SET state = 'needs_attention', next_due_at = NULL, needs_attention_reason = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE name = ?", [JSON.stringify({ code: "connect_access_unavailable", message: CALENDAR_RECONNECT_RECOVERY_MESSAGE, occurredAt: Date.now() }), CALENDAR_RECONNECT_RECOVERY_NAME]);
  const saved = await list();
  if (messageFor(saved, CALENDAR_RECONNECT_RECOVERY_NAME) !== CALENDAR_RECONNECT_RECOVERY_MESSAGE || messageFor(saved, "Update launch deals") !== hubspotMessage) throw new Error("Calendar recovery fixture did not preserve both server messages");
  return { name: CALENDAR_RECONNECT_RECOVERY_NAME, message: CALENDAR_RECONNECT_RECOVERY_MESSAGE, hubspotMessage };
}
