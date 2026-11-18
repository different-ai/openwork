/**
 * Images Workbot can show and read. Only these four get a picture in the page and reach the model as an image
 * (headless-runner `tool-files.ts`); anything else is a file Workbot has to open on its computer.
 */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isImage = (mediaType: string) => IMAGE_TYPES.has(mediaType);

const HEIC_NAME = /\.(heic|heif)$/i;

/** An iPhone photo or screenshot in Apple's HEIC/HEIF format (pickers sometimes leave the type empty). */
export function isHeic(file: File) {
  return file.type === "image/heic" || file.type === "image/heif" || HEIC_NAME.test(file.name);
}

/** Longest side of a converted photo: plenty for reading a screenshot, and keeps the upload small. */
const MAX_SIDE = 4096;

/**
 * The photo as a JPEG, decoded by the browser itself (Safari, where nearly all HEIC files come from, decodes HEIC).
 * Null when this browser can't decode it: the original is then sent as it is.
 */
async function heicToJpeg(file: File): Promise<File | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return null;
    const name = HEIC_NAME.test(file.name) ? file.name.replace(HEIC_NAME, ".jpg") : `${file.name || "photo"}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The files as they will be sent: HEIC photos become JPEGs where the browser can decode them; the rest as given. */
export function uploadableFiles(files: File[]): Promise<File[]> {
  return Promise.all(files.map(async (file) => (isHeic(file) ? ((await heicToJpeg(file)) ?? file) : file)));
}
