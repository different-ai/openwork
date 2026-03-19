import { CheckoutScreen } from "../_components/checkout-screen";

export default function CheckoutPage({
  searchParams,
}: {
  searchParams?: { customer_session_token?: string };
}) {
  return <CheckoutScreen customerSessionToken={searchParams?.customer_session_token ?? null} />;
}
