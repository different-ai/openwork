import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const coworkerRoot = path.resolve(scriptDir, "..");
const iconsRoot = path.join(coworkerRoot, "resources", "icons");
const source = path.join(iconsRoot, "open-coworker-app-icon.png");
const masterPng = path.join(iconsRoot, "icon.png");
const macMasterPng = path.join(iconsRoot, "icon-macos.png");
const linuxRoot = path.join(iconsRoot, "linux");
const macIcon = path.join(iconsRoot, "icon.icns");
const windowsIcon = path.join(iconsRoot, "icon.ico");
const linuxSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512];
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];

if (process.platform !== "darwin") {
  throw new Error("Open Coworker icon rendering currently requires macOS sips and iconutil.");
}

const renderSize = async (input, size, output) => {
  await execFileAsync("sips", ["-z", String(size), String(size), input, "--out", output]);
};

const assertPngSize = (buffer, expectedSize, label) => {
  if (buffer.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`${label} is not a PNG file.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${label} is ${width}x${height}; expected ${expectedSize}x${expectedSize}.`);
  }
};

const createIco = async (entries, output) => {
  const images = await Promise.all(entries.map(async ({ size, file }) => {
    const buffer = await readFile(file);
    assertPngSize(buffer, size, path.basename(file));
    return { size, buffer };
  }));
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  images.forEach(({ size, buffer }, index) => {
    const entryOffset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(buffer.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += buffer.length;
  });

  await writeFile(output, Buffer.concat([header, ...images.map(({ buffer }) => buffer)]));
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "open-coworker-icons-"));

try {
  const artwork = await readFile(source);
  const sourceSize = artwork.readUInt32BE(16);
  assertPngSize(artwork, sourceSize, path.basename(source));
  if (sourceSize < 1024) {
    throw new Error("The canonical icon artwork must be at least 1024x1024.");
  }
  await mkdir(linuxRoot, { recursive: true });
  await renderSize(source, 1024, masterPng);
  await copyFile(masterPng, macMasterPng);
  assertPngSize(await readFile(masterPng), 1024, path.basename(masterPng));

  await Promise.all(linuxSizes.map((size) => (
    renderSize(masterPng, size, path.join(linuxRoot, `${size}x${size}.png`))
  )));

  const iconsetRoot = path.join(temporaryRoot, "OpenCoworker.iconset");
  await mkdir(iconsetRoot);
  const macEntries = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  await Promise.all(macEntries.map(([size, filename]) => (
    renderSize(macMasterPng, size, path.join(iconsetRoot, filename))
  )));
  await execFileAsync("iconutil", ["-c", "icns", iconsetRoot, "-o", macIcon]);

  const windowsRoot = path.join(temporaryRoot, "windows");
  await mkdir(windowsRoot);
  const windowsEntries = windowsSizes.map((size) => ({
    size,
    file: path.join(windowsRoot, `${size}x${size}.png`),
  }));
  await Promise.all(windowsEntries.map(({ size, file }) => renderSize(masterPng, size, file)));
  await createIco(windowsEntries, windowsIcon);

  await Promise.all(linuxSizes.map(async (size) => {
    const file = path.join(linuxRoot, `${size}x${size}.png`);
    assertPngSize(await readFile(file), size, path.relative(coworkerRoot, file));
  }));
  const ico = await readFile(windowsIcon);
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== windowsSizes.length) {
    throw new Error("The generated Windows icon does not contain the expected image set.");
  }

  console.log("Rendered Open Coworker app icons for macOS, Windows, and Linux.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
