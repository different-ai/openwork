import { Sandbox } from "microsandbox";

async function main() {
  const box = await Sandbox.create({
    name: "labs-microsandbox-dry-run",
    image: "node:current-bookworm",
    replace: true,
    quietLogs: true,
  });

  try {
    const out = await box.shell("node -v && echo microsandbox-ok");
    process.stdout.write(out.stdout());
    if (out.stderr()) {
      process.stderr.write(out.stderr());
    }
  } finally {
    await box.stopAndWait();
    await Sandbox.remove("labs-microsandbox-dry-run");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
