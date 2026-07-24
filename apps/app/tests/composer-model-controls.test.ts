import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);

describe("composer model controls", () => {
  test("stay enabled during ordinary generation and disable during steering", () => {
    const composerSource = readFileSync(composerPath, "utf8");
    const modelSelectStart = composerSource.indexOf("<ModelSelect");
    const behaviorSelectStart = composerSource.indexOf("<ModelBehaviorSelect");
    const modelControls = [
      composerSource.slice(modelSelectStart, composerSource.indexOf("/>", modelSelectStart) + 2),
      composerSource.slice(behaviorSelectStart, composerSource.indexOf("/>", behaviorSelectStart) + 2),
    ].join("\n");

    expect(modelControls.match(/disabled=\{props\.steering\}/g)).toHaveLength(2);
    expect(modelControls).not.toContain("disabled={props.busy}");
  });

  test("tracks steering until the active run stops streaming", () => {
    const sessionSurfaceSource = readFileSync(sessionSurfacePath, "utf8");

    expect(sessionSurfaceSource).toContain("setSteering(true);\n    await handleSend();");
    expect(sessionSurfaceSource).toContain("if (!chatStreaming) setSteering(false);");
    expect(sessionSurfaceSource).toContain("steering={steering}");
  });
});
