// Loads every source-served workspace export the built service imports, the way production starts (see
// verifySourceExportsLoad in build.mjs). Run after `build`, in a step with no build secrets.
import { verifySourceExportsLoad } from "./build.mjs"

verifySourceExportsLoad()
console.log("Workspace exports the service imports load in production.")
