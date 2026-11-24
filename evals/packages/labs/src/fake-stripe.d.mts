/** Types for fake-stripe.mjs (plain JavaScript so Den's own process can load it through the egress guard). */

export type FakeStripePrice = {
  id: string;
  /** Cents per unit per interval, e.g. 1000 for $10.00. */
  unitAmount: number;
  /** Shown as the line item name on the test-mode Checkout page. */
  nickname: string;
  currency?: string;
  interval?: string;
};

export type FakeStripeOptions = {
  /** Synthetic key Den sends; must start with sk_test_. */
  secretKey: string;
  prices: FakeStripePrice[];
  port?: number;
  host?: string;
};

export type FakeStripeLineItem = { price: string; quantity: number };

export type FakeStripeSession = {
  id: string;
  object: "checkout.session";
  mode: string;
  status: "open" | "complete" | "expired";
  payment_status: string;
  customer: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  success_url: string;
  cancel_url: string;
  subscription: string | null;
  setup_intent: string | null;
  amount_total: number;
  url: string;
  lineItems: FakeStripeLineItem[];
};

export type FakeStripeSubscription = {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  metadata: Record<string, string>;
  items: { object: "list"; data: { id: string; quantity: number; price: { id: string; unit_amount: number; nickname: string } }[] };
};

export type FakeStripeState = {
  customers: { id: string; email: string | null; metadata: Record<string, string> }[];
  sessions: FakeStripeSession[];
  subscriptions: FakeStripeSubscription[];
  requests: { method: string; path: string }[];
};

export type FakeStripe = {
  port: number;
  origin: string;
  state(): FakeStripeState;
  complete(sessionId: string): Omit<FakeStripeSession, "lineItems">;
  setSubscriptionStatus(subscriptionId: string, status: string): FakeStripeSubscription;
  close(): Promise<void>;
};

export function startFakeStripe(options: FakeStripeOptions): Promise<FakeStripe>;
export function redirectStripeSdk(options: { sdkRoot: URL | string; port: number; secretKey: string; timeoutMs?: number }): Promise<void>;
export function parseStripeForm(text: string): Record<string, unknown>;
