import { describe, expect, test } from "bun:test";

import { resolveDefaultModel } from "../src/react-app/domains/connections/provider-auth/default-model-rule";

const starter = { providerID: "opencode", modelID: "big-pickle" };
const claude = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
const gemini = { providerID: "ipr_google", modelID: "gwm_gemini_pro" };
const company = { providerID: "lpr_acme", modelID: "gpt-5.4" };

describe("resolveDefaultModel", () => {
  test("1. the person's own pick wins while the company still offers it", () => {
    expect(resolveDefaultModel({ ownPick: claude, offered: [claude, gemini], starter, firstCompanyModel: company })).toEqual(claude);
  });

  test("1. an own pick waiting on the person's sign-in is still offered, so it stays", () => {
    expect(resolveDefaultModel({ ownPick: gemini, offered: [gemini], starter, firstCompanyModel: null })).toEqual(gemini);
  });

  test("1. an own pick of the starter model stays when policy allows it", () => {
    expect(resolveDefaultModel({ ownPick: starter, offered: [gemini], starter, firstCompanyModel: null })).toEqual(starter);
  });

  test("2. an own pick the company no longer offers falls back to the starter model", () => {
    expect(resolveDefaultModel({ ownPick: claude, offered: [gemini], starter, firstCompanyModel: company })).toEqual(starter);
  });

  test("2. with no own pick, new chats start on the starter model", () => {
    expect(resolveDefaultModel({ ownPick: null, offered: [claude], starter, firstCompanyModel: company })).toEqual(starter);
  });

  test("3. when policy blocks the starter model, the first company model that works", () => {
    expect(resolveDefaultModel({ ownPick: null, offered: [company], starter: null, firstCompanyModel: company })).toEqual(company);
  });

  test("nothing applies when policy blocks the starter model and the company offers nothing", () => {
    expect(resolveDefaultModel({ ownPick: null, offered: [], starter: null, firstCompanyModel: null })).toBeNull();
  });
});
