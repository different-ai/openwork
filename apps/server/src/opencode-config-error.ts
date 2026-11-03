import { readOpencodeConfigProblem, describeOpencodeConfigProblem } from "@openwork/types/opencode-config-error";
import { ApiError } from "./errors.js";

/** A clear 400 for an engine config error, instead of a generic 502. */
export function opencodeConfigApiError(body: unknown, path: string): ApiError | null {
  const problem = readOpencodeConfigProblem(body);
  if (!problem) return null;
  return new ApiError(400, "opencode_config_invalid", describeOpencodeConfigProblem(problem), {
    path,
    configPath: problem.path,
    problems: problem.problems,
  });
}
