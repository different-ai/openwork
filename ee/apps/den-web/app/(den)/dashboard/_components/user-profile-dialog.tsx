"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { AuthUser } from "../../_lib/den-flow";

type UserProfileDialogProps = {
  user: AuthUser;
  title?: string;
  descriptor?: string;
  onCancel: () => void;
  onSave: (input: { firstName: string; lastName: string }) => Promise<void>;
};

function getProfileNameParts(name: string | null) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export function UserProfileDialog({
  user,
  title = "User Profile",
  descriptor,
  onCancel,
  onSave,
}: UserProfileDialogProps) {
  const initialName = useMemo(() => getProfileNameParts(user.name), [user.name]);
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName.trim();
  const hasChanged = normalizedFirstName !== initialName.firstName || normalizedLastName !== initialName.lastName;
  const hasName = normalizedFirstName.length > 0 || normalizedLastName.length > 0;
  const canSave = hasChanged && hasName && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSave({ firstName, lastName });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950/45 px-4 py-6" role="presentation">
      <section
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.7)] sm:p-7"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-profile-title"
        aria-describedby={descriptor ? "user-profile-description" : undefined}
      >
        <div className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">OpenWork</p>
          <h2 id="user-profile-title" className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-gray-950">
            {title}
          </h2>
          {descriptor ? (
            <p id="user-profile-description" className="mt-2 text-sm leading-6 text-gray-500">
              {descriptor}
            </p>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-gray-700">First name</span>
              <input
                type="text"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
                autoComplete="given-name"
                autoFocus
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-gray-700">Last name</span>
              <input
                type="text"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
                autoComplete="family-name"
              />
            </label>
          </div>

          {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-2xl border border-gray-200 px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-2xl bg-gray-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
