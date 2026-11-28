import { createOrg, SkipError, type Place, type Seed } from "@openwork/env";
import { startMockGithubCloudCoding } from "@openwork/labs";
export { acmeCloudCodingRepositories } from "@openwork/labs";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function cloudCodingWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the GitHub lab, Den, and Chrome must share loopback");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new Error("Cloud coding needs an isolated Den boot with the GitHub lab configured; unset OPENWORK_EVAL_DEN_API_URL.");
  await using setup = new AsyncDisposableStack();
  const github = setup.use(await startMockGithubCloudCoding());
  const den = await seed.den({
    org: {
      name: "Acme Corp",
      admin: { name: "Maya Chen", email: "maya@acme.dev" },
      members: {
        sam: { name: "Sam Rivera", email: "sam@acme.dev" },
        leo: { name: "Leo Martin", email: "leo@acme.dev" },
        arjun: { name: "Arjun Patel", email: "arjun@acme.dev" },
      },
    },
    env: { ...github.env, DEN_DEPLOYMENT: "cloud", RESEND_API_KEY: "", SMTP_HOST: "" },
  });
  github.setDenWebOrigin(den.ref.webUrl);
  const maya = den.admin;
  const { sam, arjun } = den.members;
  if (!sam || !arjun) throw new Error("The Acme Corp roster is missing.");
  await enableOrganizationCapabilities(seed, maya, { cloudCoding: true });
  // Arjun still belongs to Acme Corp, but his separate browser uses an organization
  // whose feature defaults were never changed. No second Den boot is needed.
  setup.use(await createOrg({ ...den, admin: arjun }, "Acme Corp Sandbox"));
  const viewport = { width: 1440, height: 960 };
  const owner = await seed.web({ den, signedInAs: maya, startPath: "/dashboard", headless: true, viewport });
  const teammate = await seed.web({ den, signedInAs: sam, startPath: "/dashboard/cloud-coding", headless: true, viewport });
  const withoutFeature = await seed.web({ den, signedInAs: arjun, startPath: "/dashboard", headless: true, viewport });
  const resources = setup.move();
  return { den, github, owner, teammate, withoutFeature, maya, sam, arjun,
    url: (path: string) => new URL(path, den.ref.webUrl).href,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
