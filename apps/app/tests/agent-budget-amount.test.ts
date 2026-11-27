import { expect, test } from "bun:test";

import { parseBudgetDollars } from "../src/react-app/domains/agents/agent-permission-words";

test("a typed budget accepts dollars and cents, with or without $ and commas", () => {
  expect(parseBudgetDollars("30")).toBe(30_000_000);
  expect(parseBudgetDollars(" $12.5 ")).toBe(12_500_000);
  expect(parseBudgetDollars("1,250.05")).toBe(1_250_050_000);
});

test("a typed budget rejects zero, negatives, fractions of a cent and text", () => {
  for (const text of ["", "0", "0.00", "-5", "3.333", "ten", "$"]) expect(parseBudgetDollars(text)).toBeNull();
});
