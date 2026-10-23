"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  environmentVariableAssignmentOptionSchema,
  environmentVariableValueModeSchema,
  environmentVariableValueSourceSchema,
  type EnvironmentVariableValueMode,
} from "@openwork/types/den/environment-variables";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";

export const environmentVariableAssignmentSchema = z.object({
  accessId: z.string(),
  type: z.enum(["everyone", "team", "member"]),
  teamId: z.string().nullable(),
  orgMembershipId: z.string().nullable(),
  label: z.string(),
  email: z.string().nullable(),
  hasValue: z.boolean(),
  updatedAt: z.string(),
});
export type DenEnvironmentVariableAssignment = z.infer<typeof environmentVariableAssignmentSchema>;

export const environmentVariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  assignments: z.array(environmentVariableAssignmentSchema),
  memberValueCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DenEnvironmentVariable = z.infer<typeof environmentVariableSchema>;

const listSchema = z.object({ environmentVariables: z.array(environmentVariableSchema), canManage: z.boolean() });
const responseSchema = z.object({ environmentVariable: environmentVariableSchema });

export const memberEnvironmentVariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  source: environmentVariableValueSourceSchema.nullable(),
  hasValue: z.boolean(),
  editable: z.boolean(),
  assignments: z.array(environmentVariableAssignmentOptionSchema),
  selectedAccessId: z.string().nullable(),
  updatedAt: z.string(),
});
export type DenMemberEnvironmentVariable = z.infer<typeof memberEnvironmentVariableSchema>;
const memberListSchema = z.object({ environmentVariables: z.array(memberEnvironmentVariableSchema) });

export const VALUE_MODE_LABELS: Record<EnvironmentVariableValueMode, string> = {
  admin: "You set the value",
  per_member: "Each person sets their own",
};

/** Who receives a variable, in a few words. */
export function audienceSummary(variable: DenEnvironmentVariable): string {
  const everyone = variable.assignments.some((entry) => entry.type === "everyone");
  const teams = variable.assignments.filter((entry) => entry.type === "team").length;
  const people = variable.assignments.filter((entry) => entry.type === "member").length;
  const parts = [
    ...(everyone ? ["Everyone"] : []),
    ...(teams ? [`${teams} ${teams === 1 ? "team" : "teams"}`] : []),
    ...(people ? [`${people} ${people === 1 ? "person" : "people"}`] : []),
  ];
  return parts.join(", ") || "No one yet";
}

/** What is set, in a few words. Never a value. */
export function valueSummary(variable: DenEnvironmentVariable): { text: string; missing: boolean } {
  if (variable.valueMode === "per_member") {
    const people = variable.memberValueCount;
    return { text: `Each person sets their own, ${people} ${people === 1 ? "has" : "have"} so far`, missing: false };
  }
  const total = variable.assignments.length;
  const withValue = variable.assignments.filter((entry) => entry.hasValue).length;
  if (total === 0 || withValue === 0) return { text: "No value yet", missing: true };
  return { text: withValue === total ? (total === 1 ? "Value set" : "Values set") : `${withValue} of ${total} values set`, missing: false };
}

type LoadState<T> = { data: T | null; error: string | null; loading: boolean };

function useLoader<T>(load: (() => Promise<T>) | null) {
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, loading: load !== null });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!load) return;
    const current = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await load();
      if (generation.current === current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (generation.current === current) {
        setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Couldn't load environment variables." }));
      }
    }
  }, [load]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

export function useOrgEnvironmentVariables(enabled: boolean) {
  const load = useCallback(async () => {
    const { response, payload } = await requestJson("/v1/environment-variables", { method: "GET" }, 15_000);
    if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load environment variables (${response.status}).`));
    return listSchema.parse(payload);
  }, []);
  return useLoader(enabled ? load : null);
}

export function useOrgEnvironmentVariable(id: string | null, enabled: boolean) {
  const load = useCallback(async () => {
    if (!id) return null;
    const { response, payload } = await requestJson(`/v1/environment-variables/${encodeURIComponent(id)}`, { method: "GET" }, 15_000);
    if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load this environment variable (${response.status}).`));
    return responseSchema.parse(payload).environmentVariable;
  }, [id]);
  return useLoader(enabled ? load : null);
}

export function useMyEnvironmentVariables(enabled: boolean) {
  const load = useCallback(async () => {
    const { response, payload } = await requestJson("/v1/environment-variables/mine", { method: "GET" }, 15_000);
    if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your environment variables (${response.status}).`));
    return memberListSchema.parse(payload).environmentVariables;
  }, []);
  return useLoader(enabled ? load : null);
}

/** One assignment in a write. Leave value out to keep the stored one, null to remove it. */
export type EnvironmentVariableAssignmentWrite =
  | { type: "everyone"; value?: string | null }
  | { type: "team"; teamId: string; value?: string | null }
  | { type: "member"; orgMembershipId: string; value?: string | null };

export type EnvironmentVariableWrite = {
  name: string;
  key: string;
  description: string | null;
  valueMode: EnvironmentVariableValueMode;
  assignments: EnvironmentVariableAssignmentWrite[];
};

export async function saveEnvironmentVariable(id: string | null, body: EnvironmentVariableWrite): Promise<DenEnvironmentVariable> {
  const { response, payload } = await requestJson(
    id ? `/v1/environment-variables/${encodeURIComponent(id)}` : "/v1/environment-variables",
    { method: id ? "PATCH" : "POST", body: JSON.stringify(body) },
    20_000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Couldn't save the environment variable (${response.status}).`);
  return responseSchema.parse(payload).environmentVariable;
}

export async function deleteEnvironmentVariable(id: string): Promise<void> {
  const { response, payload } = await requestJson(`/v1/environment-variables/${encodeURIComponent(id)}`, { method: "DELETE" }, 20_000);
  if (!response.ok) throw getRequestError(payload, response, `Couldn't delete the environment variable (${response.status}).`);
}

export async function setMyEnvironmentVariableValue(id: string, value: string): Promise<void> {
  const { response, payload } = await requestJson(
    `/v1/environment-variables/${encodeURIComponent(id)}/my-value`,
    { method: "PUT", body: JSON.stringify({ value }) },
    20_000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Couldn't save your value (${response.status}).`);
}

export async function selectMyEnvironmentVariableAssignment(id: string, accessId: string | null): Promise<void> {
  const { response, payload } = await requestJson(
    `/v1/environment-variables/${encodeURIComponent(id)}/my-assignment`,
    { method: "PUT", body: JSON.stringify({ accessId }) },
    20_000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Couldn't save your choice (${response.status}).`);
}

export async function clearMyEnvironmentVariableValue(id: string): Promise<void> {
  const { response, payload } = await requestJson(`/v1/environment-variables/${encodeURIComponent(id)}/my-value`, { method: "DELETE" }, 20_000);
  if (!response.ok) throw getRequestError(payload, response, `Couldn't clear your value (${response.status}).`);
}
