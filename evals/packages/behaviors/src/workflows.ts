import { denFetch } from "./den.ts";
import type { DenSession } from "./den.ts";

export interface WorkflowSaveInput {
  name: string;
  description?: string;
  code: string;
  currentInput?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface WorkflowRunInput {
  pluginId: string;
  configObjectVersionId: string;
  input: unknown;
}

export interface ResponseFacts {
  status: number;
  body: unknown;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(admin: DenSession): Record<string, string> {
  return { authorization: `Bearer ${admin.token}` };
}

function preview(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).slice(0, 500);
}

async function request(admin: DenSession, path: string, init: RequestInit = {}): Promise<ResponseFacts> {
  const { response, body, text } = await denFetch(admin, path, init);
  return { status: response.status, body, text };
}

export async function grantOpenWorkWebAccess(
  admin: DenSession,
  organizationId: string,
  reason: string,
): Promise<void> {
  const result = await request(admin, `/v1/admin/organizations/${organizationId}/openwork-web-access`, {
    method: "PUT",
    headers: auth(admin),
    body: JSON.stringify({ enabled: true, reason }),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Granting OpenWork Web access failed (${result.status}): ${preview(result.body)}`);
  }
}

export function saveWorkflow(admin: DenSession, input: WorkflowSaveInput): Promise<ResponseFacts> {
  return request(admin, "/v1/workflows", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify(input),
  });
}

export async function runWorkflow(
  admin: DenSession,
  configObjectId: string,
  input: WorkflowRunInput,
): Promise<Record<string, unknown>> {
  const result = await request(admin, `/v1/workflows/${configObjectId}/run`, {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify(input),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Running Workflow failed (${result.status}): ${preview(result.body)}`);
  }
  if (!isRecord(result.body)) throw new Error(`Running Workflow returned an invalid body: ${preview(result.body)}`);
  return result.body;
}

export async function readWorkflowDetail(
  admin: DenSession,
  configObjectId: string,
): Promise<{ script: Record<string, unknown>; workflow: Record<string, unknown> }> {
  const result = await request(admin, `/v1/workflows/${configObjectId}`, { headers: auth(admin) });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Reading Workflow failed (${result.status}): ${preview(result.body)}`);
  }
  if (!isRecord(result.body) || !isRecord(result.body.script) || !isRecord(result.body.workflow)) {
    throw new Error(`Reading Workflow returned an invalid body: ${preview(result.body)}`);
  }
  return { script: result.body.script, workflow: result.body.workflow };
}

export async function listWorkflows(admin: DenSession): Promise<{ items: Record<string, unknown>[] }> {
  const result = await request(admin, "/v1/workflows", { headers: auth(admin) });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Listing Workflows failed (${result.status}): ${preview(result.body)}`);
  }
  if (!isRecord(result.body) || !Array.isArray(result.body.items) || !result.body.items.every(isRecord)) {
    throw new Error(`Listing Workflows returned an invalid body: ${preview(result.body)}`);
  }
  return { items: result.body.items };
}

export function createCloudAutomation(admin: DenSession, body: unknown): Promise<ResponseFacts> {
  return request(admin, "/v1/cloud-automations", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify(body),
  });
}

export function readAutomationRuns(admin: DenSession, automationId: string): Promise<ResponseFacts> {
  return request(admin, `/v1/automations/${automationId}/runs`, { headers: auth(admin) });
}

export function readAutomationRun(admin: DenSession, runId: string): Promise<ResponseFacts> {
  return request(admin, `/v1/automation-runs/${runId}`, { headers: auth(admin) });
}

export function readAutomation(admin: DenSession, automationId: string): Promise<ResponseFacts> {
  return request(admin, `/v1/automations/${automationId}`, { headers: auth(admin) });
}

export function patchAutomation(admin: DenSession, automationId: string, body: unknown): Promise<ResponseFacts> {
  return request(admin, `/v1/automations/${automationId}`, {
    method: "PATCH",
    headers: auth(admin),
    body: JSON.stringify(body),
  });
}

export function runAutomationNow(admin: DenSession, automationId: string): Promise<ResponseFacts> {
  return request(admin, `/v1/automations/${automationId}/run`, {
    method: "POST",
    headers: auth(admin),
  });
}
