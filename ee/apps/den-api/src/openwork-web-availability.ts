import { env } from "./env.js"

export function openWorkWebDeploymentAvailable(enabled: boolean) {
  return enabled === true
}

export function isOpenWorkWebAvailable() {
  return openWorkWebDeploymentAvailable(env.openworkWebEnabled)
}
