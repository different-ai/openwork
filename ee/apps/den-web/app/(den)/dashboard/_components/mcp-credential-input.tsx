"use client";

import type { DenInputProps } from "../../_components/ui/input";
import { DenInput } from "../../_components/ui/input";

type McpCredentialInputProps = Omit<
  DenInputProps,
  "autoCapitalize" | "autoComplete" | "autoCorrect" | "name" | "spellCheck" | "type"
> & {
  kind: "identifier" | "secret";
  name: string;
};

/**
 * Machine credentials must never be inferred from the Den account that is
 * signed in on this origin. The standard autocomplete hint covers browser
 * autofill; the data attributes cover common password-manager extensions.
 */
export function McpCredentialInput({
  kind,
  ...props
}: McpCredentialInputProps) {
  return (
    <DenInput
      {...props}
      type={kind === "secret" ? "password" : "text"}
      autoComplete={kind === "secret" ? "new-password" : "off"}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
    />
  );
}
