import { describe, expect, test } from "bun:test";
import { OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, openWorkModelsAllowanceErrorBody } from "@openwork/types/den/inference";
import { presentOpencodeSessionError, sessionErrorPresentationFromUIMessage } from "../src/react-app/domains/session/sync/session-error";
import { createSessionErrorUIMessage } from "../src/react-app/domains/session/sync/usechat-adapter";
import {
  openWorkModelsLimitCopy,
  parseOpenWorkModelsLimitError,
  usageLimitActions,
  type UsageLimitViewer,
} from "../src/react-app/domains/cloud/usage-limit-state";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const resetAt = "2026-10-21T13:10:00.000Z";
const body = JSON.stringify(openWorkModelsAllowanceErrorBody());

/** What engine v1 reports after the quota plugin answers the gateway's allowance response once. */
function v1Error(headers: Record<string, string> = {}) {
  return {
    name: "APIError",
    data: {
      message: "Your workspace used its OpenWork Models allowance.", statusCode: 429, isRetryable: false,
      responseHeaders: { "x-openwork-error-code": OPENWORK_MODELS_ALLOWANCE_ERROR_CODE, "x-openwork-usage-state": "blocked",
        "x-openwork-limit-window-type": "five_hour", "x-openwork-limit-reset-at": resetAt, "retry-after": "4200", ...headers },
      responseBody: body,
    },
  };
}

describe("a used-up OpenWork Models allowance", () => {
  test("is classified with its window and reset, not as a rate limit", () => {
    expect(parseOpenWorkModelsLimitError(v1Error(), now)).toEqual({ windowType: "five_hour", resetAt });
  });

  test("reads the reset from retry-after when the gateway sent no absolute time", () => {
    const error = v1Error();
    delete error.data.responseHeaders["x-openwork-limit-reset-at"];
    expect(parseOpenWorkModelsLimitError(error, now)?.resetAt).toBe(new Date(now + 4200_000).toISOString());
  });

  test("engine v2 text naming HTTP 429 with the gateway body is the same limit", () => {
    expect(parseOpenWorkModelsLimitError({ name: "UnknownError", data: { message: `Provider request failed with HTTP 429: ${body}` } }, now))
      .toEqual({ windowType: null, resetAt: null });
  });

  test("engine v2's bare gateway message is the same limit, without a reset it cannot read", () => {
    expect(parseOpenWorkModelsLimitError({ name: "UnknownError", data: { message: "Your workspace used its OpenWork Models allowance." } }, now))
      .toEqual({ windowType: null, resetAt: null });
    expect(presentOpencodeSessionError({ name: "UnknownError", data: { message: "Your workspace used its OpenWork Models allowance." } }).openworkModelsLimit)
      .toEqual({ windowType: null, resetAt: null });
  });

  test("an ordinary 429, another status or a spoofed header alone is not this limit", () => {
    expect(parseOpenWorkModelsLimitError({ name: "APIError", data: { message: "Too many requests", statusCode: 429, responseBody: "{}" } }, now)).toBeNull();
    expect(parseOpenWorkModelsLimitError({ ...v1Error(), data: { ...v1Error().data, statusCode: 503 } }, now)).toBeNull();
    expect(parseOpenWorkModelsLimitError({ name: "APIError", data: { message: "Too many requests", statusCode: 429,
      responseHeaders: { "x-openwork-error-code": "other", "x-openwork-usage-state": "blocked" }, responseBody: "{}" } }, now)).toBeNull();
  });

  test("the transcript classifies the allowance without a rollout flag and carries its reset evidence", () => {
    const presentation = presentOpencodeSessionError(v1Error());
    expect(presentation.kind).toBe("generic");
    expect(presentation.title).toBe("Your workspace used its OpenWork Models allowance");
    expect(presentation.openworkModelsLimit).toEqual({ windowType: "five_hour", resetAt });
    expect(presentation.technicalDetails).not.toMatch(/org_/);
    const restored = sessionErrorPresentationFromUIMessage(createSessionErrorUIMessage("turn", presentation));
    expect(restored?.openworkModelsLimit).toEqual({ windowType: "five_hour", resetAt });
  });

  test("says which workspace ran out and when it resets, never an organization id", () => {
    expect(openWorkModelsLimitCopy({ windowType: "five_hour", resetAt }, "Acme", now))
      .toEqual({ title: "Acme used its OpenWork Models allowance", reset: "5-hour allowance resets in 1 hour" });
    expect(openWorkModelsLimitCopy({ windowType: null, resetAt: null }, null, now))
      .toEqual({ title: "Your workspace used its OpenWork Models allowance", reset: null });
  });
});

const viewer = (overrides: Partial<UsageLimitViewer>): UsageLimitViewer => ({ signedIn: true, canBuy: false, modelsOffered: true, ...overrides });
const summary = (actions: ReturnType<typeof usageLimitActions>) => actions.map((action) => `${action.emphasis}:${action.label}${action.lockedReason ? " (locked)" : ""}`);

describe("the usage-limit card's actions", () => {
  test("free Auto signed out: sign in first, OpenWork Models next to it, another model last", () => {
    expect(summary(usageLimitActions("free_auto", viewer({ signedIn: false })))).toEqual([
      "primary:Sign in for more free use", "secondary:Get OpenWork Models", "tertiary:Use another model",
    ]);
  });

  test("free Auto signed in: owners and admins buy OpenWork Models, members see who can", () => {
    expect(summary(usageLimitActions("free_auto", viewer({ canBuy: true })))).toEqual(["primary:Get OpenWork Models", "tertiary:Use another model"]);
    expect(summary(usageLimitActions("free_auto", viewer({ canBuy: false })))).toEqual(["primary:Ask an admin for OpenWork Models (locked)", "tertiary:Use another model"]);
  });

  test("where OpenWork Models is not sold (self-hosted), nothing is upsold", () => {
    expect(summary(usageLimitActions("free_auto", viewer({ signedIn: false, modelsOffered: false })))).toEqual(["primary:Sign in for more free use", "tertiary:Use another model"]);
    expect(summary(usageLimitActions("free_auto", viewer({ canBuy: true, modelsOffered: false })))).toEqual(["primary:Use another model"]);
  });

  test("paid allowance: admins add a team provider (and upgrade when a plan is sold), members ask an admin", () => {
    expect(summary(usageLimitActions("models_allowance", viewer({ canBuy: true })))).toEqual(["primary:Add a team provider", "tertiary:Use another model"]);
    expect(summary(usageLimitActions("models_allowance", viewer({ canBuy: true, planUpgrade: true })))).toEqual(["primary:Add a team provider", "secondary:Upgrade plan", "tertiary:Use another model"]);
    expect(summary(usageLimitActions("models_allowance", viewer({ canBuy: false })))).toEqual(["primary:Ask an admin for more (locked)", "tertiary:Use another model"]);
  });

  test("every variant has exactly one primary action and a way to keep working", () => {
    for (const kind of ["free_auto", "models_allowance"] as const) {
      for (const signedIn of [true, false]) for (const canBuy of [true, false]) for (const modelsOffered of [true, false]) {
        const actions = usageLimitActions(kind, viewer({ signedIn, canBuy, modelsOffered }));
        expect(actions.filter((action) => action.emphasis === "primary")).toHaveLength(1);
        expect(actions.some((action) => action.id === "use_another_model")).toBe(true);
      }
    }
  });
});
