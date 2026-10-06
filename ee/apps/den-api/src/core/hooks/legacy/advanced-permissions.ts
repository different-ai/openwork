import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: advancedPermissions (custom organization roles).

// Always denied: turning the module off must not reopen raw role endpoints.
coreHooks.registerBootContributor({
  point: "auth.rawMutationDenials",
  id: "legacy/advanced-permissions/raw-role-mutations",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  contribute: () => [
    { path: "/organization/create-role", message: "Use the Den roles API to manage organization roles." },
    { path: "/organization/update-role", message: "Use the Den roles API to manage organization roles." },
    { path: "/organization/delete-role", message: "Use the Den roles API to manage organization roles." },
  ],
})
