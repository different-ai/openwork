import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DenRuntimeVersionLabel,
  parseDenRuntimeVersion,
} from "../app/(den)/_components/ui/den-runtime-version";

describe("Den runtime version", () => {
  test("reads a non-empty version from the public health payload", () => {
    expect(parseDenRuntimeVersion({ version: " 0.17.31 " })).toBe("0.17.31");
    expect(parseDenRuntimeVersion({ version: " " })).toBeNull();
    expect(parseDenRuntimeVersion(null)).toBeNull();
  });

  test("renders the version as light-gray inline metadata", () => {
    const markup = renderToStaticMarkup(
      <DenRuntimeVersionLabel version="0.17.31" />,
    );

    expect(markup).toContain("Den 0.17.31");
    expect(markup).toContain('data-den-runtime-version="0.17.31"');
    expect(markup).toContain("text-gray-400");
    expect(markup).toContain("<span");
  });
});
