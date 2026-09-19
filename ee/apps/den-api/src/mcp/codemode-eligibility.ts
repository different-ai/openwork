export type LiveCodemodeEligibility =
  | { eligible: true }
  | { eligible: false; reason: "no_script_path" | "external_authority" | "authority_unknown" | "not_read_only" }

/** Provider read-only hints never establish Den authority. */
export function liveCodemodeEligibility(input: {
  scriptPath?: string
  authority?: "den" | "external"
  readOnly?: boolean
}): LiveCodemodeEligibility {
  if (!input.scriptPath) return { eligible: false, reason: "no_script_path" }
  if (input.authority === "external") return { eligible: false, reason: "external_authority" }
  if (input.authority !== "den") return { eligible: false, reason: "authority_unknown" }
  if (input.readOnly !== true) return { eligible: false, reason: "not_read_only" }
  return { eligible: true }
}
