"use client";

import { useCallback, useRef, useState } from "react";

const FORM_ACTION =
  "https://app.loops.so/api/newsletter-form/cmkhtp90l03np0i1z8iy6kccz";

type FormState = "idle" | "loading" | "success" | "error" | "rate-limited";

export function WaitlistForm() {
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setState("idle");
    setErrorMsg("");
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const email = inputRef.current?.value?.trim();
      if (!email) return;

      const now = Date.now();
      const prev = localStorage.getItem("loops-form-timestamp");
      if (prev && Number(prev) + 60_000 > now) {
        setState("rate-limited");
        setErrorMsg("Too many signups, please try again in a little while");
        return;
      }
      localStorage.setItem("loops-form-timestamp", String(now));

      setState("loading");

      try {
        const body =
          "userGroup=&mailingLists=&email=" + encodeURIComponent(email);
        const res = await fetch(FORM_ACTION, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });

        if (res.ok) {
          setState("success");
          if (inputRef.current) inputRef.current.value = "";
        } else {
          const data = await res.json().catch(() => null);
          setState("error");
          setErrorMsg(
            data?.message ?? res.statusText ?? "Something went wrong"
          );
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "Failed to fetch") {
          setState("rate-limited");
          setErrorMsg("Too many signups, please try again in a little while");
          return;
        }
        setState("error");
        setErrorMsg(
          err instanceof Error ? err.message : "Something went wrong"
        );
        localStorage.setItem("loops-form-timestamp", "");
      }
    },
    []
  );

  if (state === "success") {
    return (
      <div className="space-y-3">
        <p className="text-[14px] text-gray-600">
          Thanks! We&apos;ll be in touch.
        </p>
        <button
          onClick={reset}
          className="text-[13px] text-gray-400 transition hover:text-black"
        >
          &larr; Sign up another email
        </button>
      </div>
    );
  }

  if (state === "error" || state === "rate-limited") {
    return (
      <div className="space-y-3">
        <p className="text-[14px] text-red-700">
          {errorMsg || "Oops! Something went wrong, please try again"}
        </p>
        <button
          onClick={reset}
          className="text-[13px] text-gray-400 transition hover:text-black"
        >
          &larr; Try again
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-center gap-3"
    >
      <input
        ref={inputRef}
        type="email"
        name="email"
        required
        placeholder="you@example.com"
        autoComplete="email"
        disabled={state === "loading"}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[14px] text-gray-900 outline-none transition focus:border-gray-300 disabled:opacity-60 sm:w-auto"
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="doc-button disabled:opacity-60"
      >
        {state === "loading" ? "Please wait\u2026" : "Join the waitlist"}
        {state !== "loading" && (
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M14 5l7 7m0 0l-7 7m7-7H3"
            />
          </svg>
        )}
      </button>
    </form>
  );
}
