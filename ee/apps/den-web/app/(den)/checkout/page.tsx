import { headers } from "next/headers";
import { CheckoutScreen } from "../_components/checkout-screen";

// Host is part of the local billing mock guard, so this page must stay per-request.
export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams?: Promise<{ customer_session_token?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const requestHeaders = await headers();
  const requestHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");

  return (
    <CheckoutScreen
      customerSessionToken={resolvedSearchParams?.customer_session_token ?? null}
      requestHost={requestHost}
    />
  );
}
