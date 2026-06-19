import { describe, expect, it } from "bun:test";

import {
  parseSpreadsheet,
  serializeSpreadsheet,
} from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";

describe("artifact spreadsheet model", () => {
  it("round-trips CSV edits", async () => {
    const rows = await parseSpreadsheet({ name: "artifact-eval.csv", text: "name,revenue\nAda,10\n" });
    rows[1]![1] = "11";
    const output = await serializeSpreadsheet("artifact-eval.csv", rows);
    expect(output).toEqual({ kind: "text", content: "name,revenue\nAda,11\n" });
  });

  it("round-trips XLSX edits", async () => {
    const output = await serializeSpreadsheet("artifact-eval.xlsx", [["name", "revenue"], ["Ada", "10"]]);
    expect(output.kind).toBe("binary");
    if (output.kind !== "binary") throw new Error("expected binary");
    const parsed = await parseSpreadsheet({ name: "artifact-eval.xlsx", data: output.data });
    expect(parsed.slice(0, 2)).toEqual([["name", "revenue"], ["Ada", "10"]]);
  });
});
