import { DeviceApprovalScreen } from "../_components/device-approval-screen";

function firstParamValue(value: string | string[] | undefined): string {
  return typeof value === "string"
    ? value.trim()
    : Array.isArray(value)
      ? (value[0]?.trim() ?? "")
      : "";
}

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <DeviceApprovalScreen initialUserCode={firstParamValue(params.user_code)} />;
}
