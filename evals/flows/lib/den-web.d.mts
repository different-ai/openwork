import type { FlowContext } from "../../runner/flow.ts";

export interface DenApiResult {
  response: Response;
  body: unknown;
}

export function denWebUrl(): string;
export function denApiUrl(): string;
export function denApiFetch(path: string, options?: RequestInit): Promise<DenApiResult>;
export function signInViaBrowser(
  ctx: FlowContext,
  email: string,
  password: string,
  organizationName?: string,
): Promise<void>;
