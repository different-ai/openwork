import { JoinSandboxScreen } from "../_components/join-sandbox-screen";

export default async function JoinSandboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tokenParam = params.token;
  const token = typeof tokenParam === "string"
    ? tokenParam.trim()
    : Array.isArray(tokenParam)
      ? (tokenParam[0]?.trim() ?? "")
      : "";

  return <JoinSandboxScreen token={token} />;
}
