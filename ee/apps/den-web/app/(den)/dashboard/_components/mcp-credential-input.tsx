"use client";

import type { DenInputProps } from "../../_components/ui/input";
import { DenInput } from "../../_components/ui/input";
import type { DenSecretInputProps } from "../../_components/ui/secret-input";
import { DenSecretInput } from "../../_components/ui/secret-input";

type McpIdentifierInputProps = Omit<
  DenInputProps,
  "autoCapitalize" | "autoComplete" | "autoCorrect" | "name" | "spellCheck" | "type"
> & {
  kind: "identifier";
  name: string;
  autoComplete?: "off" | "new-password";
};

type McpSecretInputProps = Omit<DenSecretInputProps, "name"> & {
  kind: "secret";
  name: string;
};

type McpCredentialInputProps = McpIdentifierInputProps | McpSecretInputProps;

export function McpCredentialInput(props: McpCredentialInputProps) {
  if (props.kind === "secret") {
    const { kind: _kind, autoComplete, ...secretProps } = props;
    return <DenSecretInput {...secretProps} autoComplete={autoComplete ?? "new-password"} />;
  }

  const { kind: _kind, autoComplete, ...identifierProps } = props;
  return (
    <DenInput
      {...identifierProps}
      type="text"
      autoComplete={autoComplete ?? "off"}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
    />
  );
}
