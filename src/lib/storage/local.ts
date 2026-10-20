import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "../../config/env.js";
import { API_PREFIX } from "../../constants/index.js";
import { isSafeKey } from "./keys.js";
import type { Storage, StoredFile } from "./types.js";

const UPLOAD_TTL_S = 10 * 60;
const READ_TTL_S = 60 * 60;

const root = resolve(env.LOCAL_STORAGE_DIR);
const pathOf = (key: string) => {
  if (!isSafeKey(key)) throw new Error(`Unsafe storage key: ${key}`);
  return join(root, key);
};
const metaPath = (key: string) => `${pathOf(key)}.meta.json`;

// A separate key derived from the server secret, so storage signatures can't be confused with tokens.
const secret = createHmac("sha256", env.JWT_ACCESS_SECRET).update("messora:local-storage").digest();

export const sign = (...parts: (string | number)[]) =>
  createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");

export function verify(signature: string, ...parts: (string | number)[]) {
  const expected = Buffer.from(sign(...parts));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const expiry = (ttl: number) => Math.floor(Date.now() / 1000) + ttl;

/**
 * Development/test storage: files on local disk, uploaded and read through signed API URLs
 * (`/files/...`), so the browser flow is the same as with presigned S3 URLs.
 */
export const localStorage: Storage = {
  async createUpload(key, contentType, size) {
    const expires = expiry(UPLOAD_TTL_S);
    const sig = sign("put", key, contentType, size, expires);
    const query = new URLSearchParams({
      key,
      type: contentType,
      size: String(size),
      expires: String(expires),
      sig,
    });
    return {
      url: `${API_PREFIX}/files/upload?${query}`,
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(expires * 1000),
    };
  },

  async readUrl(key) {
    const expires = expiry(READ_TTL_S);
    return `${API_PREFIX}/files/${key}?expires=${expires}&sig=${sign("get", key, expires)}`;
  },

  async stat(key) {
    try {
      const [info, meta] = await Promise.all([fsStat(pathOf(key)), readFile(metaPath(key), "utf8")]);
      return { size: info.size, contentType: (JSON.parse(meta) as StoredFile).contentType };
    } catch {
      return null;
    }
  },

  async delete(key) {
    await Promise.all([rm(pathOf(key), { force: true }), rm(metaPath(key), { force: true })]);
  },
};

/** Used by the local `/files` routes. */
export async function writeLocalFile(key: string, contentType: string, data: Buffer) {
  await mkdir(dirname(pathOf(key)), { recursive: true });
  await writeFile(pathOf(key), data);
  await writeFile(metaPath(key), JSON.stringify({ contentType }));
}

export const readLocalFile = async (key: string) => readFile(pathOf(key));
