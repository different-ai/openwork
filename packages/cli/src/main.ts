import { parseArgs } from "node:util"
import * as auth from "./commands/auth.ts"
import * as invitations from "./commands/invitations.ts"
import * as members from "./commands/members.ts"
import * as org from "./commands/org.ts"
import type { Context, Flags } from "./context.ts"
import { CliError, processIo, type Io } from "./io.ts"

export const VERSION = "0.1.0"

type Command = { usage: string; summary: string; run(context: Context): Promise<void> }

const COMMANDS: Record<string, Record<string, Command>> = {
  auth: {
    login: { usage: "auth login [--profile <name>] [--base-url <url>] [--force]", summary: "Sign in from the browser with a one-time code", run: auth.login },
    logout: { usage: "auth logout [--profile <name>]", summary: "Sign out and delete the saved sign-in", run: auth.logout },
    whoami: { usage: "auth whoami", summary: "Show who is signed in, and to which organization", run: auth.whoami },
    list: { usage: "auth list", summary: "List saved profiles", run: auth.list },
    switch: { usage: "auth switch <profile>", summary: "Use another saved profile", run: auth.switchProfile },
  },
  org: {
    list: { usage: "org list", summary: "List the organizations you belong to", run: org.list },
    get: { usage: "org get", summary: "Show the current organization", run: org.get },
    use: { usage: "org use <id-or-slug>", summary: "Choose the organization this profile acts on", run: org.use },
  },
  members: {
    list: { usage: "members list", summary: "List the organization's members", run: members.list },
    "set-role": { usage: "members set-role <id-or-email> --role <role>", summary: "Change a member's role", run: members.setRole },
    remove: { usage: "members remove <id-or-email> [--force]", summary: "Remove a member from the organization", run: members.remove },
  },
  invitations: {
    list: { usage: "invitations list", summary: "List invitations", run: invitations.list },
    create: { usage: "invitations create <email> [--role <role>] [--team <team-id>]", summary: "Invite someone by email", run: invitations.create },
    cancel: { usage: "invitations cancel <id-or-email> [--force]", summary: "Cancel a pending invitation", run: invitations.cancel },
    link: { usage: "invitations link <id-or-email>", summary: "Print a pending invitation's join link", run: invitations.link },
  },
}

const GLOBAL_OPTIONS = [
  "  --json               Print JSON (the default when output is piped)",
  "  --profile <name>     Use this saved profile",
  "  --org <id-or-slug>   Act on this organization",
  "  --dry-run            Print the change instead of making it",
  "  --force              Skip the confirmation for a destructive change",
  "  -h, --help           Show help",
  "  -v, --version        Show the version",
]

const ENVIRONMENT = [
  "  OPENWORK_API_KEY     An organization API key, for scripts and CI",
  "  OPENWORK_API_TOKEN   A session token, used instead of a profile",
  "  OPENWORK_PROFILE     The profile to use",
  "  OPENWORK_ORG_ID      The organization to act on",
  "  OPENWORK_API_URL     The API for a self-hosted OpenWork",
]

function commandLines(resources: string[]): string[] {
  const commands = resources.flatMap((resource) => Object.values(COMMANDS[resource] ?? {}))
  const width = Math.max(...commands.map((command) => command.usage.length))
  return commands.map((command) => `  openwork ${command.usage.padEnd(width)}  ${command.summary}`)
}

export function helpText(resource?: string): string {
  const resources = resource && COMMANDS[resource] ? [resource] : Object.keys(COMMANDS)
  return [
    "openwork: sign in to OpenWork Cloud and administer an organization",
    "",
    "Usage:",
    ...commandLines(resources),
    "",
    "Options:",
    ...GLOBAL_OPTIONS,
    "",
    "Environment:",
    ...ENVIRONMENT,
  ].join("\n")
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        profile: { type: "string" },
        org: { type: "string" },
        role: { type: "string" },
        team: { type: "string" },
        "base-url": { type: "string" },
      },
    })
  } catch (error) {
    throw new CliError("usage", error instanceof Error ? error.message : String(error))
  }
}

function report(io: Io, json: boolean, error: unknown): void {
  const failure = error instanceof CliError ? error : new CliError("unexpected_error", error instanceof Error ? error.message : String(error))
  io.err(json
    ? JSON.stringify({ error: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) })
    : `Error: ${failure.message}${failure.code === "usage" ? "\nRun `openwork --help` for the commands." : ""}`)
}

/** Run one command, shaped `openwork <resource> <verb>`. Returns the exit code: 0 on success, 1 on any failure. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  let json = !io.interactive || argv.includes("--json")
  try {
    const { values, positionals } = parse(argv)
    json = !io.interactive || values.json === true
    if (values.version) {
      io.out(VERSION)
      return 0
    }
    const [resource, verb, ...args] = positionals
    if (values.help || !resource || resource === "help") {
      io.out(helpText(resource === "help" ? verb : resource))
      return 0
    }
    const verbs = COMMANDS[resource]
    if (!verbs) throw new CliError("usage", `Unknown command "${resource}".`)
    if (!verb) {
      io.out(helpText(resource))
      return 0
    }
    const command = verbs[verb]
    if (!command) throw new CliError("usage", `Unknown command "${resource} ${verb}". Try: ${Object.keys(verbs).join(", ")}.`)
    const flags: Flags = {
      json,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      profile: values.profile,
      org: values.org,
      role: values.role,
      team: values.team,
      baseUrl: values["base-url"],
    }
    await command.run({ io, flags, json, args })
    return 0
  } catch (error) {
    report(io, json, error)
    return 1
  }
}
