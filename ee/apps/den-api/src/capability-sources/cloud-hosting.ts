import type { DenOrgMode } from "../env.js"

export function cloudHostingAvailable(options: { orgMode: DenOrgMode; openworkWebEnabled: boolean }): boolean {
  return options.orgMode === "multi_org" || options.openworkWebEnabled
}
