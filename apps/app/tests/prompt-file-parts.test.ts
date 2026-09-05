import { describe, expect, test } from "bun:test";

import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import { firstLineLocalFileParts, isReadInlineablePath } from "../src/react-app/domains/session/sync/prompt-file-parts";
import {
  connectSkillSlashCommandOptions,
  getSlashCommandQuery,
  parseSlashCommandInvocation,
  skillMenuSlashCommandName,
  skillSlashCommandName,
} from "../src/react-app/domains/session/surface/composer/slash-command";

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

  test("leaves binary media paths as plain text instead of a Read-expanded file part", () => {
    // opencode expands text/plain file parts through the Read tool, which
    // refuses binaries with "Cannot read binary file" as a session error.
    expect(firstLineLocalFileParts(
      "could you add this to descript /Users/ben/Downloads/C0217.MP4",
      "/Users/ben/code/openwork",
    )).toEqual([]);
    expect(firstLineLocalFileParts("unzip ~/Downloads/archive.zip and C:\\Users\\ben\\deck.pptx", "/Users/ben/code")).toEqual([]);
  });

  test("keeps text, image, and PDF paths as file parts", () => {
    const parts = firstLineLocalFileParts(
      "compare /Users/ben/notes.md /Users/ben/shot.PNG /Users/ben/paper.pdf /Users/ben/Makefile",
      "/Users/ben/code",
    );

    expect(parts.map((part) => part.filename)).toEqual(["notes.md", "shot.PNG", "paper.pdf", "Makefile"]);
  });
});

describe("read-inlineable paths", () => {
  test("classifies by extension only", () => {
    expect(isReadInlineablePath("/Users/ben/Downloads/C0217.MP4")).toBe(false);
    expect(isReadInlineablePath("C:\\Users\\ben\\report.docx")).toBe(false);
    expect(isReadInlineablePath("/tmp/build/app.wasm")).toBe(false);
    expect(isReadInlineablePath("/Users/ben/notes.md")).toBe(true);
    expect(isReadInlineablePath("/Users/ben/shot.png")).toBe(true);
    expect(isReadInlineablePath("/Users/ben/paper.pdf")).toBe(true);
    expect(isReadInlineablePath("/Users/ben/.env")).toBe(true);
    expect(isReadInlineablePath("/Users/ben/Makefile")).toBe(true);
    expect(isReadInlineablePath("/Users/ben/weird.")).toBe(true);
  });
});

describe("draft file mentions", () => {
  test("binary @file mentions become the absolute path as text", async () => {
    const parts = await draftToParts(
      {
        mode: "prompt",
        text: "add @/Users/ben/Downloads/C0217.MP4 and @notes.md",
        parts: [
          { type: "file", path: "/Users/ben/Downloads/C0217.MP4" },
          { type: "file", path: "notes.md" },
        ],
        attachments: [],
      },
      "/Users/ben/code",
      "ses_test",
      null,
    );

    expect(parts).toEqual([
      { type: "text", text: "/Users/ben/Downloads/C0217.MP4" },
      { type: "file", mime: "text/plain", url: "file:///Users/ben/code/notes.md", filename: "notes.md" },
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

describe("Connect skill slash commands", () => {
  test("uses the skill trigger and preserves the remote capability identity", () => {
    const [option] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      description: "Prepare a support escalation.",
      path: "openwork-connect://marketplace_1/plugin_1/skill_1",
      origin: "openwork-connect",
      marketplaceName: "Team tools",
      pluginName: "Support kit",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);

    expect(option).toMatchObject({
      id: "connect-skill:plugin:plugin_1:skill_1",
      name: "escalate-ticket",
      description: "Prepare a support escalation. — Team tools · Support kit",
      source: "skill",
      skill: {
        connectCapabilityName: "plugin:plugin_1:skill_1",
      },
    });
  });

  test("falls back to a slash-safe slug when a skill has no trigger", () => {
    expect(skillSlashCommandName({ name: "Renewal Playbook" })).toBe("renewal-playbook");
  });

  test("does not normalize local skill labels", () => {
    expect(skillMenuSlashCommandName({
      name: "Local Playbook",
      trigger: "local-playbook",
      origin: "local",
    })).toBe("Local Playbook");
  });

  test("excludes local skills and Connect skills missing a capability identity", () => {
    expect(
      connectSkillSlashCommandOptions([
        {
          name: "Local Playbook",
          trigger: "local-playbook",
          path: "skill://local",
          origin: "local",
          connectCapabilityName: "plugin:plugin_1:skill_1",
        },
        {
          name: "Unresolved",
          trigger: "unresolved",
          path: "openwork-connect://marketplace_1/plugin_1/skill_2",
          origin: "openwork-connect",
        },
      ]),
    ).toEqual([]);
  });

  test("falls back to a slug when the trigger contains slash-unsafe characters", () => {
    expect(skillSlashCommandName({ name: "Escalate Ticket", trigger: "escalate ticket" })).toBe("escalate-ticket");
    expect(skillSlashCommandName({ name: "Escalate Ticket", trigger: "skills/escalate" })).toBe("escalate-ticket");
  });

  test("keeps the provenance line usable when the skill has no description", () => {
    const [withProvenance] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      path: "openwork-connect://marketplace_1/plugin_1/skill_1",
      origin: "openwork-connect",
      marketplaceName: "Team tools",
      pluginName: "Support kit",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);
    expect(withProvenance?.description).toBe("Team tools · Support kit");

    const [withoutProvenance] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      path: "openwork-connect://marketplace_1/plugin_1/skill_1",
      origin: "openwork-connect",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);
    expect(withoutProvenance?.description).toBe("");
  });
});


describe("computer task mentions", () => {
  for (const target of ["cloud", "desktop"] satisfies Array<"cloud" | "desktop">) {
    test(`${target} routing is hidden from the visible prompt and survives inline attachment parsing`, async () => {
      for (const attachmentToken of ["", "[attachment removed]"]) {
        const text = `@${target} Summarize notes for person@${target} ${attachmentToken}`;
        const parts = await draftToParts({
          mode: "prompt",
          text,
          parts: [{ type: "computer", target }, { type: "text", text: ` Summarize notes for person@${target} ` }],
          attachments: [],
        }, "/workspace", "ses_computer", null);
        const instructions = parts.filter((part) => part.type === "text" && part.synthetic);
        expect(instructions).toHaveLength(1);
        expect(instructions[0]).toMatchObject({ text: expect.stringContaining(`target "${target}"`) });
        expect(parts.filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => part.type === "text" ? part.text : "").join(""))
          .toBe(`@${target} Summarize notes for person@${target} `);
      }
    });
  }
});
