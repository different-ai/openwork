/** Types for calendar-mock.mjs (kept as plain JavaScript so worlds can upload it into a sandbox verbatim). */

export type CalendarMockProvider = "google" | "microsoft";
export type CalendarMockScenario = "ok" | "connection_missing" | "scope_missing" | "expired_token" | "throttled" | "policy_blocked";

export const SCENARIOS: readonly CalendarMockScenario[];

export type CalendarMockRequest = { method: string | undefined; path: string; query: string; at: string };

export type CalendarMockState = {
  timeZone: string;
  google: Record<string, unknown>[];
  outlook: Record<string, unknown>[];
  version: number;
  scenarios: Record<CalendarMockProvider, CalendarMockScenario>;
  requests: CalendarMockRequest[];
};

export type CalendarMockOptions = {
  now?: number;
  timeZone?: string;
  /** Extra short events on Tuesday, to overflow page limits. */
  load?: number;
  google?: CalendarMockScenario;
  microsoft?: CalendarMockScenario;
  env?: Record<string, string | undefined>;
};

export type CalendarMockAnswer = { status: number; body: unknown; headers?: Record<string, string> };

export function seedCalendars(options?: { now?: number; timeZone?: string; load?: number }): Pick<CalendarMockState, "timeZone" | "google" | "outlook">;
export function wallToInstant(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number;
export function createCalendarMockState(options?: CalendarMockOptions): CalendarMockState;
export function googleEventsList(state: CalendarMockState, query: URLSearchParams): CalendarMockAnswer;
export function graphCalendarView(state: CalendarMockState, query: URLSearchParams, preferHeader?: string, selfUrl?: string): CalendarMockAnswer;
export function denCalendarEvents(state: CalendarMockState, provider: CalendarMockProvider, query: URLSearchParams): CalendarMockAnswer;
export function denExtractGoogleEvents(json: unknown): unknown[];
export function denExtractMicrosoftEvents(json: unknown): unknown[];
export function createCalendarMockHandler(state: CalendarMockState): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;
export function startCalendarMock(options?: CalendarMockOptions & { host?: string; port?: number }): Promise<{
  baseUrl: string;
  state: CalendarMockState;
  stop(): Promise<void>;
}>;
