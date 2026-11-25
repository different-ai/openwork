import { readOpencodeConfigProblem, describeOpencodeConfigProblem } from "@openwork/types/opencode-config-error";
import { ApiError } from "./errors.js";

export function opencodeConfigApiError(body: unknown, path: string): ApiError | null {
  const problem = readOpencodeConfigProblem(body);
  if (!problem) return null;
  return new ApiError(400, "opencode_config_invalid", describeOpencodeConfigProblem(problem), {
    path,
    configPath: problem.path,
    problems: problem.problems,
  });
}
