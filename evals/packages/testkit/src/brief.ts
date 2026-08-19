import { currentTestEvidence } from "@openwork/test-evidence";
import { getBriefTestRegistrar } from "./brief-internal.ts";
import type { TestContext } from "./brief-internal.ts";

export interface BriefClaim {
  must: string;
  never?: string;
}

export function claim(must: string, opts: { never?: string } = {}): BriefClaim {
  return { must, ...opts };
}

export interface TestBrief<K extends string> {
  behavior: string;
  claims: Record<K, BriefClaim>;
}

export function testBrief<K extends string>(def: TestBrief<K>): TestBrief<K> {
  if (!def.behavior.trim()) throw new Error("Test brief behavior must not be empty.");
  const keys = Object.keys(def.claims);
  if (keys.length === 0) throw new Error("Test brief must declare at least one claim.");
  for (const key in def.claims) {
    const value = def.claims[key];
    if (!value.must.trim()) throw new Error(`Test brief claim "${key}" must not have a blank must.`);
    if (value.never !== undefined && !value.never.trim()) {
      throw new Error(`Test brief claim "${key}" must not have a blank never.`);
    }
  }
  return def;
}

export type Prove<K extends string> = Record<K, (passed: boolean, evidence: string) => void>;

export interface BriefRun<K extends string> {
  prove: Prove<K>;
  assertAllProven(): void;
  facts(): { key: K; passed: boolean; evidence: string }[];
}

export function createBriefRun<K extends string>(
  brief: TestBrief<K>,
  record: (claimText: string, evidence: string, passed: boolean) => void = (claimText, evidence, passed) => {
    currentTestEvidence()?.recordAssertionEvidence(claimText, evidence, passed);
  },
): BriefRun<K> {
  const latest = new Map<K, { key: K; passed: boolean; evidence: string }>();
  const prove: Prove<K> = Object.create(null);

  for (const key in brief.claims) {
    const value = brief.claims[key];
    prove[key] = (passed, evidence) => {
      if (!evidence.trim()) throw new Error(`Proof evidence for claim "${key}" must not be blank.`);
      const claimText = `${key}: ${value.must}${value.never === undefined ? "" : ` — never: ${value.never}`}`;
      record(claimText, evidence, passed);
      latest.set(key, { key, passed, evidence });
      if (passed !== true) throw new Error(`Claim failed: ${key} — ${value.must}. Evidence: ${evidence}`);
    };
  }

  return {
    prove,
    assertAllProven() {
      const missing: K[] = [];
      for (const key in brief.claims) {
        if (!latest.has(key)) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error(`Brief claims left unproven: ${missing.join(", ")}. Every declared claim needs a prove.<claim>() call.`);
      }
    },
    facts: () => [...latest.values()],
  };
}

interface BriefTestContext<K extends string> {
  prove: Prove<K>;
  place: TestContext["place"];
  evidence: TestContext["evidence"];
  skip: TestContext["skip"];
}

function briefTitle(behavior: string): string {
  const sentence = behavior.split(".", 1)[0].trim();
  return sentence.length <= 100 ? sentence : `${sentence.slice(0, 97)}...`;
}

export function briefTest<K extends string>(
  brief: TestBrief<K>,
  fn: (ctx: BriefTestContext<K>) => Promise<void> | void,
): void {
  getBriefTestRegistrar()(briefTitle(brief.behavior), async ({ place, evidence, skip }) => {
    const run = createBriefRun(brief);
    await fn({ prove: run.prove, place, evidence, skip });
    run.assertAllProven();
  });
}
