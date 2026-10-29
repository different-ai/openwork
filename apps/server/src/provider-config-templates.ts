import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProviderConfigTemplateError {
  providerId: string;
  field: string;
  code: "missing_environment_variable" | "invalid_environment_variable" | "disallowed_environment_variable" | "unreadable_file_reference" | "disallowed_file_reference";
  message: string;
}

export const MACHINE_PROVIDER_TEMPLATE_OWNERSHIP = "__machine_provider_template_ownership__";

/** The approval covers the exact definition, not just its reusable provider ID. */
export function providerConfigFingerprint(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry === null || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  };
  return createHash("sha256").update(JSON.stringify(stable(value)) ?? "null").digest("hex");
}

export function machineOwnedProviderIds(providers: Record<string, unknown>, ownership: Record<string, unknown>): Set<string> {
  return new Set(Object.entries(providers).filter(([id, provider]) =>
    typeof ownership[id] === "string" && ownership[id] === providerConfigFingerprint(provider)).map(([id]) => id));
}

/** Only the value delivered by this provider is an approved remote binding.
 * A reused env name must not expose another provider's later replacement key. */
export function approvedProviderEnvironmentNames(
  ownership: unknown,
  environment: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const approved = new Map<string, Set<string>>();
  if (ownership === null || typeof ownership !== "object" || Array.isArray(ownership)) return approved;
  for (const [providerId, bindings] of Object.entries(ownership)) {
    if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) continue;
    const names = new Set<string>();
    for (const [name, expected] of Object.entries(bindings)) {
      const value = environment.get(name);
      if (typeof expected === "string" && value !== undefined && createHash("sha256").update(value).digest("hex") === expected) names.add(name);
    }
    approved.set(providerId, names);
  }
  return approved;
}

/** V1 substitutes env first, then trimmed file contents. Remote definitions are
 * less trusted than local config: they can reference stored user variables only
 * and never host files. Local files must remain inside the declaring directory.
 * Neither resolved values nor substituted file paths belong in diagnostics.
 */
export async function resolveProviderConfigTemplates(
  providers: Record<string, unknown>,
  options: {
    directory: string;
    environment: ReadonlyMap<string, string>;
    /** Only machine-declared, non-managed runtime providers may use local sources. */
    localProviderIds: ReadonlySet<string>;
    remoteEnvironmentNames: ReadonlyMap<string, ReadonlySet<string>>;
    inheritedEnvironment?: NodeJS.ProcessEnv;
    home?: string;
    readText?: (path: string) => Promise<string>;
    realPath?: (path: string) => Promise<string>;
  },
): Promise<{ providers: Record<string, unknown>; errors: ProviderConfigTemplateError[] }> {
  const errors: ProviderConfigTemplateError[] = [];
  const resolved: Record<string, unknown> = {};
  const inherited = options.inheritedEnvironment ?? process.env;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const canonical = options.realPath ?? realpath;
  const within = (directory: string, path: string) => {
    const child = relative(directory, path);
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  for (const [providerId, provider] of Object.entries(providers)) {
    const local = options.localProviderIds.has(providerId);
    const before = errors.length;
    const string = async (value: string, field: string): Promise<string> => {
      const expanded = value.replace(/\{env:([^}]+)\}/g, (_token, name: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          errors.push({ providerId, field, code: "invalid_environment_variable", message: `Provider ${providerId}: ${field} references an invalid environment variable name.` });
          return "";
        }
        if (!local && !options.remoteEnvironmentNames.get(providerId)?.has(name)) {
          errors.push({ providerId, field, code: "disallowed_environment_variable", message: `Provider ${providerId}: ${field} references environment variable ${name}, which is not an approved credential binding for this provider. Reconnect the provider with its own credentials.` });
          return "";
        }
        // The managed v1 child removes this server-only secret too. Remote
        // definitions must never consult the server process, even as a fallback.
        const replacement = name.toUpperCase() === "OPENWORK_ENCRYPTION_KEY" ? undefined
          : local ? inherited[name] ?? options.environment.get(name) : options.environment.get(name);
        if (!replacement) {
          errors.push({ providerId, field, code: "missing_environment_variable", message: `Provider ${providerId}: ${field} references missing environment variable ${name}. Set it in Settings > Environment and apply the changes.` });
        }
        return replacement ?? "";
      });
      let output = "";
      let cursor = 0;
      for (const match of expanded.matchAll(/\{file:([^}]+)\}/g)) {
        output += expanded.slice(cursor, match.index);
        const reference = match[1];
        const path = reference.startsWith("~/") ? join(options.home ?? homedir(), reference.slice(2)) : resolve(options.directory, reference);
        const blocked = () => errors.push({ providerId, field, code: "disallowed_file_reference", message: `Provider ${providerId}: ${field} uses a file reference that is not allowed. File references require a local provider and a file inside its configuration directory.` });
        if (!local || reference.split(/[\\/]/).includes("..") || !within(options.directory, path)) {
          blocked();
        } else {
          try {
            const directory = await canonical(options.directory);
            const file = await canonical(path);
            if (!within(directory, file)) blocked();
            else output += (await readText(file)).trim();
          } catch {
            // OS errors and file paths may contain substituted credentials.
            errors.push({ providerId, field, code: "unreadable_file_reference", message: `Provider ${providerId}: ${field} references a file that could not be read. Check the file reference inside the provider configuration directory.` });
          }
        }
        cursor = match.index + match[0].length;
      }
      return output + expanded.slice(cursor);
    };
    const visit = async (value: unknown, field: string): Promise<unknown> => {
      if (typeof value === "string") return string(value, field);
      if (Array.isArray(value)) return Promise.all(value.map((entry, index) => visit(entry, `${field}[${index}]`)));
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [
        await string(key, field), await visit(entry, field ? `${field}.${key}` : key),
      ])));
    };
    const value = await visit(provider, "");
    if (errors.length === before) resolved[providerId] = value;
  }
  return { providers: resolved, errors };
}
