import { CheckoutScreen } from "../_components/checkout-screen";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams?: Promise<{ customer_session_token?: string }>;
}) {
  const resolvedSearchParams = await searchParams;

  return (
    <CheckoutScreen
      customerSessionToken={resolvedSearchParams?.customer_session_token ?? null}
    />
  );
}
