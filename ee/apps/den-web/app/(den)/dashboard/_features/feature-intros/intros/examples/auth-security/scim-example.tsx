"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { OKTA, scimExampleLog } from "./auth-security-example-data";

/** SCIM tab example: the sync log from the identity provider. */
export function ScimExample() {
  const step = useExampleStep(scimExampleLog.length);

  return (
    <div>
      <ExampleCaption>Provisioning, once running</ExampleCaption>

      <div className="mb-3 flex items-center gap-2.5">
        <ExampleServiceMark service={OKTA} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">Synced from Okta</span>
          <span className="text-[12px] leading-4 text-gray-500">Last sync 2 min ago</span>
        </span>
      </div>

      <ExampleGroupLabel>Recent changes</ExampleGroupLabel>
      <ExampleRows>
        {scimExampleLog.map((entry, index) => (
          <ExampleRow key={entry.title} active={step === index}>
            <ExampleAvatar>{entry.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{entry.title}</span>
              <span className="truncate text-[12px] text-gray-500">{entry.detail}</span>
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{entry.meta}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
