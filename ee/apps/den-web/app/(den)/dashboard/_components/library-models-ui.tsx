"use client";

import { ChevronRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { getLibraryModelRoute, getLibraryRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { ItemMenu, ItemPanel, ItemRow } from "./item-list";
import {
  type LibraryModelProvider,
  modelCount,
  modelNamesSummary,
  signInBrand,
} from "./library-models";
import { useLibraryModels, useModelSignIn } from "./library-models-data";

type ModelSignIn = ReturnType<typeof useModelSignIn>;

export function ProviderLogo({ provider, size = "sm" }: { provider: Pick<LibraryModelProvider, "name" | "iconSlug">; size?: "sm" | "lg" }) {
  return (
    <DenBrandMark
      name={provider.name}
      simpleIconSlug={provider.iconSlug}
      className={size === "lg" ? "h-10 w-10 rounded-xl border-gray-200" : "h-8 w-8 rounded-[7px] border-gray-200"}
      imageClassName={size === "lg" ? "h-5 w-5" : "h-[18px] w-[18px]"}
    />
  );
}

function WaitingOnAdmin() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
      Waiting on your admin
    </span>
  );
}

/** One provider in My Library, with the one thing the person can do about it on the right. */
export function LibraryModelRow({ provider, signIn }: { provider: LibraryModelProvider; signIn: ModelSignIn }) {
  const { orgSlug } = useOrgDashboard();
  const waiting = signIn.waitingFor === provider.id;
  const failure = signIn.failureFor(provider.id);
  const status = provider.state === "blocked"
    ? <WaitingOnAdmin />
    : waiting ? "Finish signing in in your browser"
      : failure ?? modelCount(provider.models.length);
  const action = provider.state === "blocked" ? null
    : waiting ? <DenButton variant="ghost" size="xs" onClick={signIn.cancel}>Cancel</DenButton>
      : provider.state === "needs_signin" ? (
        <DenButton variant="secondary" size="xs" onClick={() => void signIn.signIn(provider)}>
          {failure ? "Try again" : "Sign in"}
        </DenButton>
      ) : <ChevronRight className="h-4 w-4 text-gray-400" aria-hidden />;
  return (
    <div data-library-item={provider.name} data-library-kind="model" data-model-state={provider.state}>
      <ItemRow
        href={getLibraryModelRoute(orgSlug, provider.id)}
        logo={<ProviderLogo provider={provider} />}
        title={provider.name}
        description={modelNamesSummary(provider.models)}
        status={status}
        action={action ?? <span />}
      />
    </div>
  );
}

function stateLine(provider: LibraryModelProvider, waiting: boolean): { text: string; dot: string } {
  if (provider.state === "blocked") return { text: "Waiting on your admin to finish setting this up.", dot: "bg-gray-300" };
  if (waiting) return { text: "Finish signing in in your browser.", dot: "bg-gray-300" };
  if (provider.account) return { text: `Signed in as ${provider.account}`, dot: "bg-emerald-600" };
  if (provider.memberSets.length > 0) return { text: `Not signed in. Uses your own ${signInBrand(provider)} account.`, dot: "bg-gray-300" };
  return { text: "Your organization signs in for everyone.", dot: "bg-emerald-600" };
}

/** A provider's page in My Library: which account is in use and every model it gives the person. */
export function LibraryModelProviderScreen({ providerId }: { providerId: string }) {
  const { orgSlug } = useOrgDashboard();
  const models = useLibraryModels();
  const signIn = useModelSignIn();
  const back = { href: `${getLibraryRoute(orgSlug)}?show=models`, label: "My Library" };
  const provider = models.data?.find((entry) => entry.id === providerId) ?? null;

  if (!provider && models.isLoading) return <ItemPage><ItemHeader back={back} title="Loading..." /></ItemPage>;
  if (!provider && models.error) return <ItemPage><ItemHeader back={back} title="It did not load" description="Reload the page to try again." /></ItemPage>;
  if (!provider) return <ItemPage><ItemHeader back={back} title="Not in your Library" description="Your organization may have stopped giving you these models." /></ItemPage>;

  const waiting = signIn.waitingFor === provider.id;
  const failure = signIn.failureFor(provider.id);
  const line = stateLine(provider, waiting);
  const brand = signInBrand(provider);
  const signedIn = provider.memberSets.some((set) => set.hasCredential);
  const canSignIn = provider.signInSet !== null && provider.state !== "blocked";

  const actions = waiting
    ? <DenButton variant="secondary" onClick={signIn.cancel}>Cancel</DenButton>
    : signedIn
      ? (
        <ItemMenu
          size="md"
          label={`More for ${provider.name}`}
          entries={[
            ...(canSignIn ? [{ label: "Switch account", onSelect: () => void signIn.signIn(provider) }] : []),
            {
              label: "Sign out",
              onSelect: () => signIn.signOut(provider),
              confirm: {
                title: `Sign out of ${provider.name}?`,
                description: `You can't use these models until you sign in again. ${brand} may also sign you out of other OpenWork connections that use the same ${brand} account.`,
                action: "Sign out",
              },
            },
          ]}
        />
      )
      : canSignIn ? <DenButton onClick={() => void signIn.signIn(provider)}>{`Sign in with ${brand}`}</DenButton> : null;

  return (
    <ItemPage testId="library-model-provider">
      <ItemHeader
        back={back}
        logo={<ProviderLogo provider={provider} size="lg" />}
        title={provider.name}
        description={(
          <span className="inline-flex items-center gap-2" data-testid="model-provider-state">
            {waiting ? <LoaderCircle className="h-3 w-3 animate-spin text-gray-400" aria-hidden /> : <span className={`h-1.5 w-1.5 rounded-full ${line.dot}`} aria-hidden />}
            {line.text}
          </span>
        )}
        actions={actions}
      />
      {failure ? (
        <p className="-mt-3 text-[13px] leading-5 text-gray-600" role="status">
          {failure}{" "}
          <button type="button" className="font-medium text-gray-900 underline-offset-2 hover:underline" onClick={() => void signIn.signIn(provider)}>Try again</button>
        </p>
      ) : null}
      <section className="flex flex-col gap-2.5" data-testid="model-provider-models">
        <SectionTitle title={modelCount(provider.models.length)} />
        <ItemPanel>
          {provider.models.length === 0 ? <p className="px-5 py-4 text-[13px] text-gray-500">No models yet.</p> : null}
          {provider.models.map((model) => (
            <div key={model.name} className="flex items-center gap-3 px-5 py-3" data-testid="model-provider-model">
              <DenBrandMark name={model.vendor} simpleIconSlug={model.vendorIconSlug} className="h-6 w-6 rounded-md border-gray-200" imageClassName="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-gray-900">{model.name}</span>
              <span className="shrink-0 text-[12px] leading-4 text-gray-500">{model.vendor}</span>
            </div>
          ))}
        </ItemPanel>
      </section>
      <details className="group rounded-2xl border border-gray-100 bg-white" data-testid="model-provider-technical">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-[13px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden">
          Technical details
          <ChevronRight className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-90" aria-hidden />
        </summary>
        <dl className="flex flex-col gap-2 border-t border-gray-100 px-5 py-4 text-[12px] leading-4 text-gray-500">
          <div className="flex justify-between gap-4"><dt>Provider</dt><dd className="text-gray-700">{provider.providerKey}</dd></div>
          {provider.modelGroups.length > 0 ? <div className="flex justify-between gap-4"><dt>Model group</dt><dd className="text-gray-700">{provider.modelGroups.join(", ")}</dd></div> : null}
          {provider.memberSets.map((set) => (
            <div key={set.credentialSetId} className="flex justify-between gap-4">
              <dt>Credential set</dt>
              <dd className="text-gray-700">{set.name}: {set.ready ? "ready" : set.configurationRequired ? "needs admin setup" : !set.hasAccess ? "access removed" : "needs your sign-in"}</dd>
            </div>
          ))}
          {provider.memberSets.length > 0 ? <p className="pt-1">{`Sign-in uses ${brand} OAuth. Tokens stay on OpenWork's servers and are never shown here.`}</p> : null}
        </dl>
      </details>
    </ItemPage>
  );
}
