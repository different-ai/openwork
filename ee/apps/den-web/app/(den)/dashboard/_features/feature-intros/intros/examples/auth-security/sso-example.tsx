"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { EXAMPLE_DOMAIN, EXAMPLE_ORG, OKTA, ssoExampleSettings } from "./auth-security-example-data";

/** SSO tab example: what people see when they sign in, and the connection behind it. */
export function SsoExample() {
  const step = useExampleStep(ssoExampleSettings.length);

  return (
    <div>
      <ExampleCaption>Signing in, once SSO is on</ExampleCaption>

      <div className="flex flex-col gap-2 border-b border-gray-100 pb-4">
        <span className="text-[13px] font-medium text-gray-900">Sign in to {EXAMPLE_ORG}</span>
        <span className="flex h-9 items-center rounded-lg border border-gray-200 px-3 text-[13px] text-gray-500">priya@{EXAMPLE_DOMAIN}</span>
        <span className="flex h-9 items-center justify-center gap-2 rounded-lg bg-gray-900 text-[13px] font-medium text-white">
          <ExampleServiceMark service={OKTA} size="sm" />
          Continue with Okta
        </span>
      </div>

      <div className="mt-3">
        <ExampleGroupLabel>Your connection</ExampleGroupLabel>
        <ExampleRows>
          {ssoExampleSettings.map((row, index) => (
            <ExampleRow key={row.label} active={step === index}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-gray-900">{row.label}</span>
                <span className="truncate text-[12px] text-gray-500">{row.detail}</span>
              </span>
              <span className="shrink-0 text-[12px] text-gray-700">{row.state}</span>
            </ExampleRow>
          ))}
        </ExampleRows>
      </div>
    </div>
  );
}
