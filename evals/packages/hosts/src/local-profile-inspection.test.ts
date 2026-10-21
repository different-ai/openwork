import { expect, test } from "vitest";
import { unrelatedLinuxProfileMounts } from "./local.ts";

const profile = "/owned/run/chrome-profile";
const device = 0x801n; // Linux makedev(8, 1).
const root = "1 0 8:1 / / rw - ext4 /dev/root rw";
const mount = (id: string, path: string, type = "overlay") => `2 1 ${id} / ${path} rw - ${type} source rw`;

test("Linux lsof can exempt only unrelated container filesystems on other devices", () => {
  const table = [root, mount("0:201", "/var/lib/docker/overlay2/fixture/merged"), mount("0:4", "/run/docker/netns/fixture", "nsfs")].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, device)).toEqual([
    "/var/lib/docker/overlay2/fixture/merged", "/run/docker/netns/fixture",
  ]);
});

test("profile descendants and ancestors are never exempted, even on another device", () => {
  const table = [root, mount("0:201", "/owned"), mount("0:202", `${profile}/nested`), mount("0:203", profile)].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, device)).toEqual([]);
});

test("same-device bind aliases cannot hide processes using the profile through another path", () => {
  const table = [root, mount("8:1", "/alias", "overlay"), mount("8:1", "/run/docker/netns/same-device", "nsfs")].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, device)).toEqual([]);
});

test("unknown filesystem types are not silently exempted", () => {
  const table = [root, mount("0:201", "/unrelated", "fuse"), mount("0:202", "/remote", "nfs")].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, device)).toEqual([]);
});

test("an unconfirmed profile filesystem or malformed mount table fails closed", () => {
  expect(() => unrelatedLinuxProfileMounts(root, profile, 0x802n)).toThrow("filesystem is unconfirmed");
  expect(() => unrelatedLinuxProfileMounts(`${root}\nmalformed`, profile, device)).toThrow("invalid Linux mount information");
  expect(() => unrelatedLinuxProfileMounts("", profile, device)).toThrow("invalid Linux mount information");
});

test("mount paths decode the kernel's octal escapes before scope checks", () => {
  const table = [root, mount("0:201", "/container\\040mount"), mount("0:202", "/owned/run/chrome-profile/inside\\040mount")].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, device)).toEqual(["/container mount"]);
});

test("Linux device identity uses both the high and low major and minor bits", () => {
  const major = 0x12345n;
  const minor = 0x6789n;
  const encoded = ((major & 0xfffn) << 8n) | ((major & 0xfffff000n) << 32n)
    | (minor & 0xffn) | ((minor & 0xffffff00n) << 12n);
  const table = [mount(`${major}:${minor}`, "/", "ext4"), mount(`${major}:${minor}`, "/alias"), mount("0:201", "/container")].join("\n");
  expect(unrelatedLinuxProfileMounts(table, profile, encoded)).toEqual(["/container"]);
});
