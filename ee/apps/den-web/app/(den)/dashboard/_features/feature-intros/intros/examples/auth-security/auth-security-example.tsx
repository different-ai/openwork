"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { OKTA, authSecurityExampleActivity, authSecurityExampleRows } from "./auth-security-example-data";

/** Section example: single sign-on and provisioning from one identity provider, and what they did today. */
export function AuthSecurityExample() {
  const step = useExampleStep(authSecurityExampleActivity.length);

  return (
    <div>
      <ExampleCaption>Auth &amp; Security, once running</ExampleCaption>

      <ExampleRows>
        {authSecurityExampleRows.map((row) => (
          <ExampleRow key={row.title}>
            <ExampleServiceMark service={OKTA} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.title}</span>
              <span className="truncate text-[12px] text-gray-500">{row.detail}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-700">{row.state}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>Recent activity</ExampleGroupLabel>
        <ul className="m-0 flex list-none flex-col p-0">
          {authSecurityExampleActivity.map((item, index) => (
            <li
              key={item.sentence}
              className={`-mx-2 flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
            >
              <ExampleAvatar>{item.initials}</ExampleAvatar>
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{item.sentence}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{item.when}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
