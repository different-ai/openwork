type DeviceOrganization = { id: string; isActive: boolean };

/** Desktop consent must name an explicitly chosen organization when there is a choice. */
export function initialDeviceOrganizationId(clientId: string | null, organizations: readonly DeviceOrganization[]): string {
  if (clientId === "openwork-desktop-device" && organizations.length > 1) return "";
  return organizations.find((organization) => organization.isActive)?.id ?? organizations[0]?.id ?? "";
}
