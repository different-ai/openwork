export function getV2Health() {
  return {
    ok: true as const,
    service: "openwork-server-v2" as const,
  };
}
