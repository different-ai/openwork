import { parseArgs } from "node:util"
import * as apiKeys from "./commands/api-keys.ts"
import * as audit from "./commands/audit.ts"
import * as auth from "./commands/auth.ts"
import * as config from "./commands/config.ts"
import * as invitations from "./commands/invitations.ts"
import * as members from "./commands/members.ts"
import * as org from "./commands/org.ts"
import * as teams from "./commands/teams.ts"
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
  teams: {
    list: { usage: "teams list", summary: "List teams and who is in them", run: teams.list },
    create: { usage: "teams create <name> [--members <emails>]", summary: "Create a team", run: teams.create },
    update: { usage: "teams update <id-or-name> [--name <new-name>] [--add <emails>] [--remove <emails>]", summary: "Rename a team or change its members", run: teams.update },
    delete: { usage: "teams delete <id-or-name> [--force]", summary: "Delete a team", run: teams.remove },
  },
  "api-keys": {
    list: { usage: "api-keys list", summary: "List the organization's API keys", run: apiKeys.list },
    create: { usage: "api-keys create <name> [--type standard|config] [--scopes <a,b>] [--areas <a,b>]", summary: "Create an API key or a config token, shown once", run: apiKeys.create },
    delete: { usage: "api-keys delete <id-or-name> [--force]", summary: "Delete an API key", run: apiKeys.remove },
  },
  audit: {
    list: { usage: "audit list [--from <date>] [--to <date>] [--action <name>] [--actor <user-id>] [--outcome <outcome>] [--limit <n>] [--cursor <cursor>]", summary: "List recorded operations, newest first", run: audit.list },
    export: { usage: "audit export [--format ndjson|csv] [--out <file>] [--from <date>] [--to <date>] [--action <name>] [--actor <user-id>] [--outcome <outcome>]", summary: "Download every recorded event", run: audit.exportEvents },
  },
  config: {
    areas: { usage: "config areas", summary: "List the configuration areas you can export or import", run: config.areas },
    pull: { usage: "config pull [--areas <a,b>] [--out <file>]", summary: "Download the organization's configuration as a file", run: config.pull },
    diff: { usage: "config diff <file> [--mode merge|mirror]", summary: "Show what importing a file would change", run: config.diff },
    push: { usage: "config push <file> [--mode merge|mirror] [--title <text>]", summary: "Upload a file as a change request for review", run: config.push },
    deploy: { usage: "config deploy <file> [--mode merge|mirror] [--title <text>] | --request <id>", summary: "Apply a file or an uploaded change request, and wait", run: config.deploy },
    requests: { usage: "config requests", summary: "List open change requests", run: config.requests },
    status: { usage: "config status <request-id>", summary: "Show a change request and its last apply", run: config.status },
    cancel: { usage: "config cancel <request-id> [--force]", summary: "Withdraw an open change request", run: config.cancel },
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
  "  OPENWORK_API_KEY     An organization API key for scripts and CI (a config token for `config`)",
  "  OPENWORK_API_TOKEN   A session token, used instead of a profile",
  "  OPENWORK_PROFILE     The profile to use",
  "  OPENWORK_ORG_ID      The organization to act on",
  "  OPENWORK_API_URL     The API for a self-hosted OpenWork",
]

function withoutOptions(usage: string): string {
  return usage.split(/ \[?--/)[0] ?? usage
}

function commandLines(resources: string[], complete: boolean): string[] {
  const commands = resources.flatMap((resource) => Object.values(COMMANDS[resource] ?? {}))
  if (complete) return commands.flatMap((command) => [`  openwork ${command.usage}`, `      ${command.summary}`])
  const usages = commands.map((command) => withoutOptions(command.usage))
  const width = Math.max(...usages.map((usage) => usage.length))
  return commands.map((command, index) => `  openwork ${(usages[index] ?? "").padEnd(width)}  ${command.summary}`)
}

export function helpText(resource?: string): string {
  const oneGroup = resource !== undefined && COMMANDS[resource] !== undefined
  return [
    "openwork: sign in to OpenWork Cloud, administer an organization and deploy its configuration",
    "",
    "Usage:",
    ...commandLines(oneGroup ? [resource] : Object.keys(COMMANDS), oneGroup),
    ...(oneGroup ? [] : ["", "Run `openwork help <group>` for a group's options, for example `openwork help config`."]),
    "",
    "Options:",
    ...GLOBAL_OPTIONS,
    "",
    "Environment:",
    ...ENVIRONMENT,
  ].join("\n")
}

const TEXT_OPTIONS = [
  "profile", "org", "role", "team", "base-url", "areas", "out", "mode", "title", "request", "members", "name", "add", "remove",
  "type", "scopes", "from", "to", "action", "actor", "outcome", "limit", "cursor", "format",
] as const
const OPTIONS_EVERY_COMMAND_TAKES = new Set(["json", "profile", "org", "dry-run", "force", "help", "version"])

function refuseOptionsTheCommandDoesNotTake(command: Command, given: string[]): void {
  const taken = new Set((command.usage.match(/--[a-z-]+/g) ?? []).map((option) => option.slice(2)))
  const stray = given.find((option) => !OPTIONS_EVERY_COMMAND_TAKES.has(option) && !taken.has(option))
  if (stray) throw new CliError("usage", `--${stray} is not an option of this command. Usage: openwork ${command.usage}`)
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
        ...Object.fromEntries(TEXT_OPTIONS.map((option) => [option, { type: "string" } as const])),
      },
    })
  } catch (error) {
    throw new CliError("usage", error instanceof Error ? error.message : String(error))
  }
}

function textOption(values: Record<string, unknown>, name: (typeof TEXT_OPTIONS)[number]): string | undefined {
  const value = values[name]
  return typeof value === "string" ? value : undefined
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
    refuseOptionsTheCommandDoesNotTake(command, Object.keys(values))
    const flags: Flags = {
      json,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      profile: textOption(values, "profile"),
      org: textOption(values, "org"),
      role: textOption(values, "role"),
      team: textOption(values, "team"),
      baseUrl: textOption(values, "base-url"),
      areas: textOption(values, "areas"),
      out: textOption(values, "out"),
      mode: textOption(values, "mode"),
      title: textOption(values, "title"),
      request: textOption(values, "request"),
      members: textOption(values, "members"),
      name: textOption(values, "name"),
      add: textOption(values, "add"),
      remove: textOption(values, "remove"),
      type: textOption(values, "type"),
      scopes: textOption(values, "scopes"),
      from: textOption(values, "from"),
      to: textOption(values, "to"),
      action: textOption(values, "action"),
      actor: textOption(values, "actor"),
      outcome: textOption(values, "outcome"),
      limit: textOption(values, "limit"),
      cursor: textOption(values, "cursor"),
      format: textOption(values, "format"),
    }
    await command.run({ io, flags, json, args })
    return 0
  } catch (error) {
    report(io, json, error)
    return 1
  }
}
