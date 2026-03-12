import type { AutoCompactionPolicy } from "./auto-compaction-policy";

export const customAutoCompactionPolicies: AutoCompactionPolicy[] = [];

export function resolveCustomAutoCompactionPolicyId(_input: {
  availablePolicies: AutoCompactionPolicy[];
  defaultPolicyId: string;
}): string | null {
  return null;
}
