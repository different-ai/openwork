import { describe, expect, test } from "bun:test";

import { firstLineLocalFileParts } from "../src/react-app/domains/session/sync/prompt-file-parts";
import { getSlashCommandQuery, parseSlashCommandInvocation } from "../src/react-app/domains/session/surface/composer/slash-command";

describe("first-line local file parts", () => {
  test("detects tilde paths in the first line", () => {
    const parts = firstLineLocalFileParts(
      "check ~/code/research/openwork-users/list.csv\nits a list of unique email domains",
      "/Users/omar/code/openwork",
    );

    expect(parts).toEqual([
      {
        type: "file",
        mime: "text/plain",
        url: "file:///Users/omar/code/research/openwork-users/list.csv",
        filename: "list.csv",
      },
    ]);
  });

  test("only detects paths from the first line", () => {
    const parts = firstLineLocalFileParts(
      "summarize this\n~/code/research/openwork-users/list.csv",
      "/Users/omar/code/openwork",
    );

    expect(parts).toEqual([]);
  });

  test("does not treat URL paths as local files", () => {
    const parts = firstLineLocalFileParts(
      "check https://example.com/research/list.csv",
      "/Users/omar/code/openwork",
    );

    expect(parts).toEqual([]);
  });

  test("detects Windows absolute paths in the first line", () => {
    expect(firstLineLocalFileParts("check C:\\Users\\omar\\list.csv", "C:/Users/omar/code/openwork")).toEqual([
      {
        type: "file",
        mime: "text/plain",
        url: "file:///C:/Users/omar/list.csv",
        filename: "list.csv",
      },
    ]);

    expect(firstLineLocalFileParts("check C:/Users/omar/list.csv", "C:/Users/omar/code/openwork")).toEqual([
      {
        type: "file",
        mime: "text/plain",
        url: "file:///C:/Users/omar/list.csv",
        filename: "list.csv",
      },
    ]);
  });
});

describe("slash-command parsing", () => {
  test("parses command invocations", () => {
    expect(parseSlashCommandInvocation("/compact")).toEqual({ name: "compact", arguments: "" });
    expect(parseSlashCommandInvocation("/review this diff")).toEqual({ name: "review", arguments: "this diff" });
  });

  test("does not parse absolute file paths as commands", () => {
    expect(parseSlashCommandInvocation("/Users/omar/code/openwork/apps/app/src/file.ts\nwhy does this fail?")).toBeNull();
    expect(getSlashCommandQuery("/Users/omar/code/file.ts")).toBeNull();
  });
});
