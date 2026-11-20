import assert from "node:assert/strict";
import { test } from "node:test";
import { readSidebarBrand, selectSidebarBrand } from "./sidebar-brand";

const wordmarkUrl = "https://example.com/wordmark.png";
const iconUrl = "https://example.com/icon.png";
const appName = "Acme Robotics";
const metadata = JSON.stringify({ brandLogoUrl: wordmarkUrl, brandIconUrl: iconUrl, brandAppName: ` ${appName} ` });

test("prefer the wordmark and fall back to the icon and app name when it fails or is missing", () => {
  const brand = readSidebarBrand(metadata, true);
  assert.deepEqual(selectSidebarBrand(brand, []), { kind: "wordmark", url: wordmarkUrl, name: appName });
  const iconAndName = { kind: "icon", url: iconUrl, name: appName };
  assert.deepEqual(selectSidebarBrand(brand, [wordmarkUrl]), iconAndName);
  assert.deepEqual(selectSidebarBrand(readSidebarBrand(JSON.stringify({ brandIconUrl: iconUrl, brandAppName: appName }), true), []), iconAndName);
  assert.deepEqual(selectSidebarBrand(brand, [wordmarkUrl, iconUrl]), { kind: "icon", url: null, name: appName });
});

test("keep the default mark when there is no usable branding", () => {
  const defaultMark = { kind: "default", url: null, name: null };
  assert.deepEqual(selectSidebarBrand(readSidebarBrand(null, true), []), defaultMark);
  assert.deepEqual(selectSidebarBrand(readSidebarBrand(metadata, false), []), defaultMark);
  assert.deepEqual(selectSidebarBrand(readSidebarBrand(undefined, true), []), { ...defaultMark, kind: "loading" });
  const imagesOnly = readSidebarBrand(JSON.stringify({ brandLogoUrl: wordmarkUrl, brandIconUrl: iconUrl }), true);
  assert.deepEqual(selectSidebarBrand(imagesOnly, [wordmarkUrl, iconUrl]), defaultMark);
});
