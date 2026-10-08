// Turning pasted, dropped, uploaded or vault images into something Claude can read.
import { TFile, type App } from "obsidian";
import type { ImageInput } from "../../core/types";

export interface Img extends ImageInput {
  id: number;
  /** data: URL for previews. */
  url: string;
  name: string;
}

export const MAX_IMAGES = 4;
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
const SUPPORTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Longest side sent to Claude; bigger photos are scaled down (plenty for handwriting). */
const MAX_SIDE = 1800;
const MAX_BYTES = 1_500_000;
let nextId = 1;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Scale down and re-encode big or unusual images; keep small PNG/JPEG/GIF/WebP as they are. */
export async function prepareImage(blob: Blob, name: string): Promise<Img> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(`Couldn't read “${name}” as an image (PNG, JPEG, GIF or WebP work best).`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  let out = blob;
  if (scale < 1 || blob.size > MAX_BYTES || !SUPPORTED.includes(blob.type)) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // transparent areas become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.88));
  }
  bitmap.close();
  const url = await readAsDataUrl(out);
  return { id: nextId++, url, name, mediaType: out.type || "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

export async function fromVault(app: App, file: TFile): Promise<Img> {
  const ext = file.extension.toLowerCase();
  const type = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return prepareImage(new Blob([await app.vault.readBinary(file)], { type }), file.name);
}

/** Image files from a paste or drop event. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) return files;
  return [...data.items]
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** What we send to the backend (no preview URL). */
export function toInputs(images: Img[]): ImageInput[] {
  return images.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
}
