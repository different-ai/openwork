import assert from "node:assert/strict";
import { getManagedBrandIconUrl } from "./den-org.ts";

const managedIconUrl = "https://den.example.test/v1/brand-assets/org_acme/icon/version.png";
const managedIcon = {
  kind: "icon",
  version: "version",
  extension: "png",
  contentType: "image/png",
  url: managedIconUrl,
  width: 256,
  height: 256,
  byteLength: 1024,
  originalName: "acme.png",
  uploadedAt: "2026-07-10T00:00:00.000Z",
};

assert.equal(
  getManagedBrandIconUrl(JSON.stringify({
    brandIconUrl: "https://legacy.example.test/icon.png",
    brandIconAsset: managedIcon,
  })),
  managedIconUrl,
);
assert.equal(
  getManagedBrandIconUrl(JSON.stringify({
    brandIconUrl: "https://legacy.example.test/icon.png",
  })),
  null,
);
assert.equal(getManagedBrandIconUrl(null), null);
assert.equal(getManagedBrandIconUrl("not-json"), null);

console.log("ok: Den sidebar resolves only the canonical managed square icon");
