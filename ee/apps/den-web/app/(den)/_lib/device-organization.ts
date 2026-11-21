type DeviceOrganization = { id: string; isActive: boolean };

export function initialDeviceOrganizationId(clientId: string | null, organizations: readonly DeviceOrganization[]): string {
  if (clientId === "openwork-desktop-device" && organizations.length > 1) return "";
  return organizations.find((organization) => organization.isActive)?.id ?? organizations[0]?.id ?? "";
}
