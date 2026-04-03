import { Sandbox } from "microsandbox";

const image = process.argv[2];

if (!image) {
  console.error("Usage: node ./scripts/microsandbox-image-dry-run.js <image-ref-or-path>");
  process.exit(1);
}

async function main() {
  const box = await Sandbox.create({
    name: "labs-microsandbox-image-dry-run",
    image,
    replace: true,
    quietLogs: true,
  });

  try {
    const out = await box.shell("node -v && echo image-ok");
    process.stdout.write(out.stdout());
    if (out.stderr()) {
      process.stderr.write(out.stderr());
    }
  } finally {
    await box.stopAndWait();
    await Sandbox.remove("labs-microsandbox-image-dry-run");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
