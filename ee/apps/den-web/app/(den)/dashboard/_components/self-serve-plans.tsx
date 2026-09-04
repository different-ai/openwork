"use client";
import { z } from "zod";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { formatMoneyMinor } from "../../_lib/den-flow";

export const selfServeBillingSchema = z.object({
  tier: z.enum(["free", "team", "enterprise"]),
  source: z.enum(["default", "stripe", "manual", "grandfathered"]),
  catalog: z.array(z.object({
    id: z.enum(["team", "enterprise", "sso"]), name: z.string(), unitAmount: z.number(), configured: z.boolean(),
    currency: z.string(), interval: z.string(), quantityType: z.enum(["member", "organization"]),
  })),
  sso: z.object({ hasActiveSubscription: z.boolean(), unitAmount: z.number() }),
});
export type SelfServeBilling = z.infer<typeof selfServeBillingSchema>;
export type SelfServeProduct = SelfServeBilling["catalog"][number]["id"];

export function SelfServePlans({ billing, members, canManage, busy, onChoose }: {
  billing: SelfServeBilling; members: number; canManage: boolean; busy: boolean; onChoose: (product: SelfServeProduct) => void;
}) {
  const managed = billing.source === "manual" || billing.source === "grandfathered";
  return (
    <DenCard className="mb-6" data-testid="self-serve-plans">
      <h2 className="text-lg font-medium">Plans and add-ons</h2>
      <p className="mt-2 text-sm text-gray-500">Choose a monthly plan. Paid plans cover every organization member, including invited members. Taxes are calculated at checkout. AI model access is separate.</p>
      {managed ? <p className="mt-3 text-sm">Your organization has a managed agreement. Contact support to change it.</p> : null}
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {billing.catalog.map((product) => {
          const included = product.id === "sso" && billing.tier === "enterprise";
          const current = product.id === billing.tier || (product.id === "sso" && billing.sso.hasActiveSubscription);
          const quantity = product.quantityType === "organization" ? 1 : Math.max(1, members);
          const available = product.configured && !managed && !included && !current && (product.id !== "sso" || billing.tier === "team");
          return (
            <div className="rounded-2xl border border-gray-200 p-4" key={product.id}>
              <h3 className="font-medium">{product.name}</h3>
              <p className="mt-2 text-xl font-semibold">{formatMoneyMinor(product.unitAmount, product.currency)}<span className="text-xs font-normal text-gray-500"> / {product.quantityType === "member" ? "user / month" : "organization / month"}</span></p>
              <p className="mt-2 text-sm text-gray-500">{product.id === "enterprise" ? "Includes SSO, analytics, desktop policies, branding, and OpenWork Web." : product.id === "sso" ? "Add SSO / SAML to Team. Included with Enterprise." : "Shared skills and plugins, distributed model keys, and standard support."}</p>
              <p className="my-3 text-sm">{included ? "Included in your Enterprise plan" : `${formatMoneyMinor(product.unitAmount * quantity, product.currency)} monthly${product.quantityType === "member" ? ` for ${quantity} users` : ""}`}</p>
              <DenButton disabled={!canManage || busy || !available} onClick={() => onChoose(product.id)}>{included ? "Included" : current ? "Current subscription" : !product.configured ? "Not available yet" : product.id === "sso" ? "Add SSO" : `Choose ${product.name}`}</DenButton>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-gray-500">Stripe shows the final charge before confirmation. Use Manage billing to cancel. Before moving from Team + SSO to Enterprise, cancel the separate SSO subscription and let its paid period end.</p>
    </DenCard>
  );
}
