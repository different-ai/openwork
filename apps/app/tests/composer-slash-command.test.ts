import { describe, expect, test } from "bun:test";
import {
  filterSlashCommands, getSlashCommandQuery, parseSlashCommandInvocation, slashTriggerAtCaret,
  type ComposerSlashCommandOption,
} from "../src/react-app/domains/session/surface/composer/slash-command";

function trigger(draft: string) {
  return slashTriggerAtCaret(draft, draft.length);
}

const slug: ComposerSlashCommandOption = { id: "slug", name: "analytics-dashboard", source: "skill" };
const title: ComposerSlashCommandOption = { id: "title", name: "Analytics Dashboard", source: "skill" };
const description: ComposerSlashCommandOption = { id: "description", name: "metrics", description: "Analytics dash", source: "skill" };
const command: ComposerSlashCommandOption = { id: "command", name: "analytics", source: "command" };

describe("composer slash suggestions", () => {
  test("finds a slash at a line or whitespace boundary and uses the caret", () => {
    expect(trigger("/")).toEqual({ query: "", offset: 0, end: 1 });
    expect(trigger("please use /analytics dash")).toEqual({ query: "analytics dash", offset: 11, end: 26 });
    expect(trigger("hello\n/analysis")).toEqual({ query: "analysis", offset: 6, end: 15 });
    expect(slashTriggerAtCaret("/analyZE this later", 6)).toEqual({ query: "analy", offset: 0, end: 8 });
    expect(trigger("/analytics\nhello")).toBeNull();
  });

  test("does not treat a path, URL or joined words as a trigger", () => {
    for (const draft of ["src/app", "https://x", "and/or", "/usr/local", "open /usr/local", "this and / or that"]) {
      expect(trigger(draft)).toBeNull();
    }
    expect(slashTriggerAtCaret("/usr/local", 3)).toBeNull();
  });

  test("matches spaced queries across title and slug, but not description", () => {
    const items = [slug, title, description];
    expect(filterSlashCommands(items, { query: "analytics dash", offset: 0 }).map((item) => item.id).sort()).toEqual(["slug", "title"]);
    expect(filterSlashCommands(items, { query: "analytics", offset: 0 })).toContain(description);
    expect(filterSlashCommands(items, { query: "analytics tomorrow", offset: 0 })).toEqual([]);
  });

  test("only offers skills away from the very start", () => {
    expect(filterSlashCommands([command, slug], { query: "analy", offset: 0 })).toContain(command);
    expect(filterSlashCommands([command, slug], { query: "analy", offset: 7 })).toEqual([slug]);
  });

  test("leaves legacy suggestions and command parsing unchanged", () => {
    expect(getSlashCommandQuery("/analy")).toBe("analy");
    expect(getSlashCommandQuery("/analytics dash")).toBeNull();
    expect(getSlashCommandQuery("hello /analy")).toBeNull();
    expect(parseSlashCommandInvocation("/analytics these results")).toEqual({ name: "analytics", arguments: "these results" });
    expect(parseSlashCommandInvocation("hello /analytics")).toBeNull();
  });
});
