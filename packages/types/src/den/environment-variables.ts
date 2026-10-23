import { z } from "zod"

/**
 * Organization environment variables: admins define them in OpenWork Cloud and
 * desktops add them to the agent's (OpenCode's) process environment.
 *
 * Shared by den-api (validation and responses), den-web (editor) and the
 * desktop (settings and engine environment).
 */

/**
 * How a variable gets its value: `admin` puts a value on each assignment
 * (everyone, a team, one person); `per_member` lets each recipient set their own.
 */
export const ENVIRONMENT_VARIABLE_VALUE_MODES = ["admin", "per_member"] as const
export const environmentVariableValueModeSchema = z.enum(ENVIRONMENT_VARIABLE_VALUE_MODES)
export type EnvironmentVariableValueMode = z.infer<typeof environmentVariableValueModeSchema>

export const ENVIRONMENT_VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH = 255
export const ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH = 32_768

/**
 * Names the desktop owns or needs to start the agent. Deploying them would
 * break every recipient's agent, so Den refuses them.
 */
const RESERVED_KEYS = new Set([
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "TEMP", "TMP",
  "LANG", "TERM", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
])
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_", "BUN_", "ELECTRON_"]

/**
 * Names that make a program on the desktop load or run something else: the
 * dynamic loader, Git (GIT_CONFIG_* can set core.sshCommand), shells, language
 * runtimes, package managers and editors or pagers tools launch. A variable
 * must only ever be data, never a way to run commands on recipients' computers.
 */
const CODE_EXECUTION_KEYS = new Set([
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "CDPATH",
  "SSH_ASKPASS", "SSH_AUTH_SOCK", "SUDO_ASKPASS", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "BROWSER", "LESSOPEN", "LESSCLOSE",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONINSPECT",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB", "RUBYOPT", "RUBYLIB", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "PHPRC", "PHP_INI_SCAN_DIR", "TCLLIBPATH", "LUA_INIT", "LUA_PATH", "LUA_CPATH",
  "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_SCRIPT_SHELL", "NPM_CONFIG_NODE_OPTIONS",
  "GCONV_PATH", "HOSTALIASES", "RESOLV_HOST_CONF", "LOCPATH", "NLSPATH", "MALLOC_CHECK_",
  // Option variables tools read as command-line flags (tar --checkpoint-action=exec, make SHELL=…).
  "TAR_OPTIONS", "MAKEFLAGS", "MFLAGS", "GNUMAKEFLAGS", "RSYNC_RSH", "RSYNC_CONNECT_PROG", "CVS_RSH", "SVN_SSH",
  "LESS", "LESSKEYIN", "LESSKEY", "MANOPT", "MANROFFOPT", "GROFF_COMMAND_PREFIX", "FPATH", "PS0", "PS1", "PS2", "PS3",
  // More editors, pagers and terminals tools launch.
  "FCEDIT", "SELECTED_EDITOR", "SYSTEMD_PAGER", "SYSTEMD_EDITOR", "PSQL_PAGER", "PSQL_EDITOR", "SVN_EDITOR", "HGEDITOR", "TERMINAL",
  // Weakening or logging TLS: with a proxy these would expose recipients' traffic and credentials.
  "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "AWS_CA_BUNDLE",
  "PYTHONHTTPSVERIFY", "CURL_SSL_BACKEND", "NODE_USE_ENV_PROXY",
  // Editor startup commands (vi/Vim run these as Ex commands, which can call the shell).
  "VIMINIT", "GVIMINIT", "EXINIT", "MYVIMRC", "MYGVIMRC", "VIMRUNTIME", "VIM", "EMACSLOADPATH", "EMACSNATIVELOADPATH", "INPUTRC",
])
const CODE_EXECUTION_PREFIXES = ["LD_", "DYLD_", "GIT_", "BASH_FUNC_", "NPM_CONFIG_", "YARN_", "PNPM_", "PIP_", "UV_", "CARGO_", "RUSTC_", "HG", "RSYNC_", "NVIM_", "NODE_TLS_", "SSL_"]

/** Why a key cannot be deployed, or null when it can. */
export function environmentVariableKeyProblem(key: string): string | null {
  if (!key) return "Enter a key."
  if (key.length > ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH) return `Use at most ${ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH} characters.`
  if (!ENVIRONMENT_VARIABLE_KEY_PATTERN.test(key)) return "Use letters, numbers and underscores, starting with a letter or underscore."
  const upper = key.toUpperCase()
  if (RESERVED_KEYS.has(upper)) return `${key} is used by the desktop app and can't be deployed.`
  const prefix = RESERVED_PREFIXES.find((candidate) => upper.startsWith(candidate))
  if (prefix) return `Keys starting with ${prefix} are reserved for OpenWork.`
  if (CODE_EXECUTION_KEYS.has(upper)) return `${key} can make programs run other commands, so it can't be deployed.`
  const runner = CODE_EXECUTION_PREFIXES.find((candidate) => upper.startsWith(candidate))
  if (runner) return `Keys starting with ${runner} can change how programs run, so they can't be deployed.`
  return null
}

export const environmentVariableKeySchema = z.string().trim().superRefine((value, ctx) => {
  const problem = environmentVariableKeyProblem(value)
  if (problem) ctx.addIssue({ code: "custom", message: problem })
})

export const environmentVariableValueSchema = z.string().min(1).max(ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH)

/**
 * Where a person's effective value comes from: an assignment to everyone, to
 * one of their teams, directly to them, or their own value.
 */
export const environmentVariableValueSourceSchema = z.enum(["everyone", "team", "direct", "own"])
export type EnvironmentVariableValueSource = z.infer<typeof environmentVariableValueSourceSchema>

/**
 * An assignment that gives this person a value, by name ("Everyone in Acme",
 * "Sales", "Directly to you"). Never the value.
 */
export const environmentVariableAssignmentOptionSchema = z.object({
  accessId: z.string(),
  kind: z.enum(["everyone", "team", "direct"]),
  label: z.string(),
})
export type EnvironmentVariableAssignmentOption = z.infer<typeof environmentVariableAssignmentOptionSchema>

/**
 * One variable as the desktop applies it. `value` is null when nothing is set
 * for this person yet. `editable` is true only for variables each person sets
 * themselves: everything else is provisioned by an admin and read-only.
 * `assignments` lists every assignment that gives a value (admin mode), and
 * `selectedAccessId` the one in use; the person may choose another.
 */
export const resolvedEnvironmentVariableSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  source: environmentVariableValueSourceSchema.nullable(),
  editable: z.boolean(),
  assignments: z.array(environmentVariableAssignmentOptionSchema),
  selectedAccessId: z.string().nullable(),
  value: z.string().nullable(),
  updatedAt: z.string().datetime(),
})
export type ResolvedEnvironmentVariable = z.infer<typeof resolvedEnvironmentVariableSchema>

export const resolvedEnvironmentVariablesResponseSchema = z.object({
  environmentVariables: z.array(resolvedEnvironmentVariableSchema),
})
export type ResolvedEnvironmentVariablesResponse = z.infer<typeof resolvedEnvironmentVariablesResponseSchema>
