/**
 * Template installer — copies skills and commands from an AikaTemplate
 * into the active workspace using existing Tauri APIs.
 */

import {
  installSkillTemplate,
  opencodeCommandWrite,
} from "../../lib/tauri";
import type { AikaTemplate } from "./index";

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal, handles our template command format)
// ---------------------------------------------------------------------------

interface ParsedCommand {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

/**
 * Parse a command markdown file into the fields expected by
 * `OpencodeCommandDraft`. The file format is:
 *
 * ```
 * ---
 * name: my-command
 * description: What it does
 * agent: optional-agent
 * ---
 *
 * Prompt body text...
 * ```
 */
function parseCommandMarkdown(raw: string): ParsedCommand {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return { name: "unknown", description: "", template: raw.trim() };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  const get = (key: string): string | undefined => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim();
  };

  return {
    name: get("name") ?? "unknown",
    description: get("description") ?? "",
    template: body,
    agent: get("agent"),
    model: get("model"),
    subtask: get("subtask") === "true" ? true : undefined,
  };
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

export interface InstallResult {
  ok: boolean;
  skillsInstalled: number;
  commandsInstalled: number;
  errors: string[];
}

/**
 * Install a template's skills and commands into the workspace at `projectDir`.
 *
 * - Skills are written to `.opencode/skills/<slug>/SKILL.md`
 * - Commands are written to `.opencode/commands/<slug>.md`
 *
 * Existing skills/commands with the same name are skipped (not overwritten)
 * unless `overwrite` is true.
 */
export async function installTemplate(
  projectDir: string,
  template: AikaTemplate,
  options?: { overwrite?: boolean },
): Promise<InstallResult> {
  const overwrite = options?.overwrite ?? false;
  const errors: string[] = [];
  let skillsInstalled = 0;
  let commandsInstalled = 0;

  // Install skills
  for (const skill of template.skills) {
    try {
      const result = await installSkillTemplate(
        projectDir,
        skill.slug,
        skill.content,
        { overwrite },
      );
      if (result.ok) {
        skillsInstalled++;
      } else if (result.stderr && !result.stderr.includes("already exists")) {
        errors.push(`Skill "${skill.slug}": ${result.stderr}`);
      }
      // "already exists" is not an error when overwrite=false, just skip
    } catch (e) {
      errors.push(`Skill "${skill.slug}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Install commands
  for (const cmd of template.commands) {
    try {
      const parsed = parseCommandMarkdown(cmd.content);
      const result = await opencodeCommandWrite({
        scope: "workspace",
        projectDir,
        command: {
          name: parsed.name,
          description: parsed.description,
          template: parsed.template,
          agent: parsed.agent,
          model: parsed.model,
          subtask: parsed.subtask,
        },
      });
      if (result.ok) {
        commandsInstalled++;
      } else if (result.stderr) {
        errors.push(`Command "${cmd.slug}": ${result.stderr}`);
      }
    } catch (e) {
      errors.push(`Command "${cmd.slug}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: errors.length === 0,
    skillsInstalled,
    commandsInstalled,
    errors,
  };
}
