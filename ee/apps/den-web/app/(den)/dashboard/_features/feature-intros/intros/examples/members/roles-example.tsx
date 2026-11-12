"use client";

import { Check, ShieldCheck } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { rolesExampleBuiltIn, rolesExamplePermissions, rolesExampleRole } from "./roles-example-data";

function RoleTile() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gray-100 text-gray-700">
      <ShieldCheck className="size-3.5" strokeWidth={1.5} aria-hidden />
    </span>
  );
}

/** One custom role on two teams and the permissions it adds (Members › Roles box, next to the real built-in roles). */
export function CustomRoleExample() {
  const step = useExampleStep(rolesExamplePermissions.length);

  return (
    <div>
      <ExampleCaption>A custom role, given to two teams</ExampleCaption>
      <div className="mb-2 flex items-center gap-2.5">
        <RoleTile />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{rolesExampleRole.name}</span>
          <span className="truncate text-[12px] text-gray-500">{rolesExampleRole.teams}</span>
        </span>
      </div>
      <ExampleGroupLabel>{rolesExampleRole.base}</ExampleGroupLabel>
      <ExampleRows>
        {rolesExamplePermissions.map((permission, index) => (
          <ExampleRow key={permission} active={step === index}>
            <Check className="size-4 shrink-0 text-gray-900" strokeWidth={2} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900">{permission}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}

/** Roles example: a custom role, and the built-in roles beside it. */
export function RolesExample() {
  return (
    <div>
      <CustomRoleExample />
      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>Built-in roles</ExampleGroupLabel>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rolesExampleBuiltIn.map((role) => (
            <li key={role.name} className="flex min-w-0 items-baseline gap-2 text-[12px]">
              <span className="w-14 shrink-0 font-medium text-gray-900">{role.name}</span>
              <span className="min-w-0 flex-1 truncate text-gray-500">{role.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
