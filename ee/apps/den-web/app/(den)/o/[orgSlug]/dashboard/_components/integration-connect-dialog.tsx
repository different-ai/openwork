"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  GitBranch,
  Lock,
  ShieldCheck,
  X,
} from "lucide-react";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import { DenSelectableRow } from "../../../../_components/ui/selectable-row";
import {
  type IntegrationAccount,
  type IntegrationProvider,
  type IntegrationRepo,
  getProviderMeta,
  useConnectIntegration,
  useIntegrationAccounts,
  useIntegrationRepos,
} from "./integration-data";

/**
 * IntegrationConnectDialog
 *
 * Walks the user through a realistic OAuth-style connect flow entirely in-app:
 *   1. authorize        — eyebrow scopes + "Authorize" button (mocks the IdP redirect)
 *   2. select_account   — pick a personal account or an org/workspace
 *   3. select_repos     — pick one or more repos to expose
 *   4. connecting       — spinner while the mutation resolves
 *   5. connected        — success card with a "Done" CTA
 *
 * No real redirect to GitHub/Bitbucket — the "Authorize" step just advances
 * the wizard. All progress is stateful client-side so the walkthrough feels
 * real and the final React Query cache ends up in a correct state.
 */

type Step = "authorize" | "select_account" | "select_repos" | "connecting" | "connected";

const STEP_ORDER: Step[] = ["authorize", "select_account", "select_repos", "connecting", "connected"];
const STEP_LABELS: Record<Step, string> = {
  authorize: "Authorize",
  select_account: "Select account",
  select_repos: "Select repositories",
  connecting: "Connecting",
  connected: "Connected",
};

export function IntegrationConnectDialog({
  open,
  provider,
  onClose,
}: {
  open: boolean;
  provider: IntegrationProvider | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("authorize");
  const [selectedAccount, setSelectedAccount] = useState<IntegrationAccount | null>(null);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
  const [repoQuery, setRepoQuery] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const accountsQuery = useIntegrationAccounts(provider ?? "github", Boolean(provider) && step === "select_account");
  const reposQuery = useIntegrationRepos(provider ?? "github", selectedAccount?.id ?? null);
  const connectMutation = useConnectIntegration();

  // Reset the wizard every time the dialog is re-opened.
  useEffect(() => {
    if (open) {
      setStep("authorize");
      setSelectedAccount(null);
      setSelectedRepoIds(new Set());
      setRepoQuery("");
      setLocalError(null);
    }
  }, [open, provider]);

  if (!open || !provider) {
    return null;
  }

  const meta = getProviderMeta(provider);
  const stepIndex = STEP_ORDER.indexOf(step);
  const progressLabel =
    step === "connected"
      ? "Done"
      : `Step ${Math.min(stepIndex + 1, 4)} of 4 · ${STEP_LABELS[step]}`;

  // Filtered repos for the select step.
  const filteredRepos = useMemo(() => {
    const repos = reposQuery.data ?? [];
    const normalized = repoQuery.trim().toLowerCase();
    if (!normalized) return repos;
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(normalized) ||
        repo.description.toLowerCase().includes(normalized),
    );
  }, [reposQuery.data, repoQuery]);

  function handleToggleRepo(repo: IntegrationRepo) {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repo.id)) {
        next.delete(repo.id);
      } else {
        next.add(repo.id);
      }
      return next;
    });
  }

  async function handleConnect() {
    if (!selectedAccount || !provider) return;
    const repos = (reposQuery.data ?? []).filter((repo) => selectedRepoIds.has(repo.id));
    if (repos.length === 0) {
      setLocalError("Select at least one repository to connect.");
      return;
    }

    setLocalError(null);
    setStep("connecting");
    try {
      await connectMutation.mutateAsync({
        provider,
        account: selectedAccount,
        repos,
      });
      setStep("connected");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to connect integration.");
      setStep("select_repos");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${meta.name}`}
    >
      <div className="relative w-full max-w-lg rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]">
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="grid gap-2 pr-8">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
            {progressLabel}
          </p>
          <div className="flex items-center gap-3">
            <ProviderBadge provider={provider} />
            <div>
              <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-gray-950">
                Connect {meta.name}
              </h2>
              <p className="text-[13px] text-gray-500">{meta.description}</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="mt-6">
          {step === "authorize" ? (
            <AuthorizeStep scopes={meta.scopes} providerName={meta.name} />
          ) : step === "select_account" ? (
            <SelectAccountStep
              accounts={accountsQuery.data ?? []}
              loading={accountsQuery.isLoading}
              selectedId={selectedAccount?.id ?? null}
              onSelect={(account) => {
                setSelectedAccount(account);
              }}
            />
          ) : step === "select_repos" ? (
            <SelectReposStep
              repos={filteredRepos}
              totalCount={(reposQuery.data ?? []).length}
              loading={reposQuery.isLoading}
              selectedIds={selectedRepoIds}
              onToggle={handleToggleRepo}
              query={repoQuery}
              onQueryChange={setRepoQuery}
            />
          ) : step === "connecting" ? (
            <ConnectingStep providerName={meta.name} />
          ) : (
            <ConnectedStep
              providerName={meta.name}
              account={selectedAccount}
              repoCount={selectedRepoIds.size}
            />
          )}
        </div>

        {/* Error */}
        {localError ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {localError}
          </div>
        ) : null}

        {/* Footer actions */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          {step === "authorize" ? (
            <>
              <DenButton variant="secondary" onClick={onClose}>
                Cancel
              </DenButton>
              <DenButton onClick={() => setStep("select_account")} icon={ArrowRight}>
                Authorize with {meta.name}
              </DenButton>
            </>
          ) : step === "select_account" ? (
            <>
              <DenButton variant="secondary" onClick={() => setStep("authorize")}>
                Back
              </DenButton>
              <DenButton
                onClick={() => setStep("select_repos")}
                disabled={!selectedAccount}
                icon={ArrowRight}
              >
                Continue
              </DenButton>
            </>
          ) : step === "select_repos" ? (
            <>
              <DenButton variant="secondary" onClick={() => setStep("select_account")}>
                Back
              </DenButton>
              <DenButton
                onClick={() => void handleConnect()}
                disabled={selectedRepoIds.size === 0}
                loading={connectMutation.isPending}
              >
                {selectedRepoIds.size === 0
                  ? "Select a repository"
                  : `Connect ${selectedRepoIds.size} ${selectedRepoIds.size === 1 ? "repo" : "repos"}`}
              </DenButton>
            </>
          ) : step === "connecting" ? (
            <span className={buttonVariants({ variant: "secondary" })}>Working…</span>
          ) : (
            <DenButton onClick={onClose}>Done</DenButton>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step components ────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: IntegrationProvider }) {
  const bg = provider === "github" ? "bg-[#0f172a]" : "bg-[#2684FF]";
  const label = provider === "github" ? "GH" : "BB";
  return (
    <div
      className={`flex h-10 w-10 items-center justify-center rounded-[12px] text-[13px] font-semibold text-white ${bg}`}
      aria-hidden="true"
    >
      {label}
    </div>
  );
}

function AuthorizeStep({ providerName, scopes }: { providerName: string; scopes: string[] }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-gray-50/60 p-5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-gray-900">
        <ShieldCheck className="h-4 w-4 text-gray-500" />
        {providerName} is requesting the following permissions
      </p>
      <ul className="mt-3 grid gap-2 text-[13px] text-gray-600">
        {scopes.map((scope) => (
          <li key={scope} className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-gray-400" />
            <code className="rounded bg-white px-1.5 py-0.5 text-[12px] text-gray-700 ring-1 ring-gray-200">
              {scope}
            </code>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12px] leading-5 text-gray-400">
        You will be redirected to {providerName} to approve access. This preview simulates that
        redirect — no data leaves your browser.
      </p>
    </div>
  );
}

function SelectAccountStep({
  accounts,
  loading,
  selectedId,
  onSelect,
}: {
  accounts: IntegrationAccount[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (account: IntegrationAccount) => void;
}) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 px-5 py-10 text-center text-[13px] text-gray-400">
        Loading accounts…
      </div>
    );
  }
  if (accounts.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 px-5 py-10 text-center text-[13px] text-gray-400">
        No accounts available.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
      <div className="divide-y divide-gray-100">
        {accounts.map((account) => (
          <DenSelectableRow
            key={account.id}
            title={account.name}
            description={account.kind === "user" ? "Personal account" : "Organization"}
            descriptionBelow
            selected={selectedId === account.id}
            onClick={() => onSelect(account)}
            leading={
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0f172a] text-[12px] font-semibold text-white">
                {account.avatarInitial}
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}

function SelectReposStep({
  repos,
  totalCount,
  loading,
  selectedIds,
  onToggle,
  query,
  onQueryChange,
}: {
  repos: IntegrationRepo[];
  totalCount: number;
  loading: boolean;
  selectedIds: Set<string>;
  onToggle: (repo: IntegrationRepo) => void;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <DenInput
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Filter repositories..."
      />

      {loading ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-5 py-10 text-center text-[13px] text-gray-400">
          Loading repositories…
        </div>
      ) : repos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-5 py-10 text-center text-[13px] text-gray-400">
          {totalCount === 0 ? "No repositories available on this account." : "No repositories match that filter."}
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto rounded-2xl border border-gray-100 bg-white">
          <div className="divide-y divide-gray-100">
            {repos.map((repo) => (
              <DenSelectableRow
                key={repo.id}
                title={repo.fullName}
                description={repo.description}
                descriptionBelow
                selected={selectedIds.has(repo.id)}
                onClick={() => onToggle(repo)}
                leading={<GitBranch className="h-4 w-4 text-gray-400" />}
                aside={
                  repo.hasPlugins ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      has plugins
                    </span>
                  ) : null
                }
              />
            ))}
          </div>
        </div>
      )}

      <p className="text-[12px] text-gray-400">
        {selectedIds.size === 0
          ? "Select one or more repos to expose their plugins and skills."
          : `${selectedIds.size} of ${totalCount} selected.`}
      </p>
    </div>
  );
}

function ConnectingStep({ providerName }: { providerName: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-gray-50/60 px-5 py-10 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center">
        <svg aria-hidden="true" className="h-8 w-8 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
      <p className="text-[14px] font-medium text-gray-900">Installing {providerName} integration…</p>
      <p className="mt-1 text-[12px] text-gray-500">Registering webhooks and indexing repository manifests.</p>
    </div>
  );
}

function ConnectedStep({
  providerName,
  account,
  repoCount,
}: {
  providerName: string;
  account: IntegrationAccount | null;
  repoCount: number;
}) {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 px-5 py-6 text-center">
      <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-700" />
      <p className="text-[14px] font-medium text-gray-900">
        {providerName} connected{account ? ` · ${account.name}` : ""}
      </p>
      <p className="mt-1 text-[12px] text-gray-500">
        {repoCount} {repoCount === 1 ? "repository" : "repositories"} will now contribute plugins and skills.
      </p>
    </div>
  );
}
