/**
 * Daytona's preview proxy dials `localhost:<port>` inside the VM. On
 * 2026-10-16 some VMs booted with an empty /etc/hosts; every layer saved from
 * one kept it, and every world built on that layer answered 502 on all ports
 * while looking healthy inside. Repair it, prove it resolves, then save.
 * Part of the image and world names, so a poisoned layer is never reused.
 */
export const LOCALHOST_RECIPE = `grep -qE '^127\\.0\\.0\\.1[[:space:]]+localhost([[:space:]]|$)' /etc/hosts 2>/dev/null || echo '127.0.0.1 localhost' >> /etc/hosts
getent hosts localhost`;
