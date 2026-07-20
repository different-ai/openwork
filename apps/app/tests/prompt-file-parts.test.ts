import { describe, expect, test } from "bun:test";

import { firstLineLocalFileParts } from "../src/react-app/domains/session/sync/prompt-file-parts";
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
