import { resolvePlace } from "@openwork/env";

export interface TestContext {
  place: ReturnType<typeof resolvePlace>;
  evidence: unknown;
  skip(note?: string): never;
}

export type RegisterTest = (title: string, fn: (ctx: TestContext) => Promise<void> | void) => void;

let registerTest: RegisterTest | undefined;

export function setBriefTestRegistrar(registrar: RegisterTest): void {
  registerTest = registrar;
}

export function getBriefTestRegistrar(): RegisterTest {
  if (!registerTest) throw new Error("briefTest must be imported from @openwork/testkit.");
  return registerTest;
}
