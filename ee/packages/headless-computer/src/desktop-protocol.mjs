/**
 * What the runner and a computer's desktop (its helper and guest) agree on: the helper's commands, the guest's routes
 * and their payloads. A runner keeps driving a computer built from another image while their protocols match, and
 * replaces it once nothing is running on it. Raise this only for a change an older desktop can't serve.
 */
export const DESKTOP_PROTOCOL = 1;
