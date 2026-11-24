import { AuthScreen } from "./_components/auth-screen";
import { getMcpOAuthSelectOrganizationRoute } from "./_lib/mcp-oauth-route";

function toSearch(params: Record<string, string | string[] | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, entry);
  }
  return search.toString();
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const agentSignIn = getMcpOAuthSelectOrganizationRoute(toSearch(await searchParams)) !== null;
  return <AuthScreen agentSignIn={agentSignIn} />;
}
