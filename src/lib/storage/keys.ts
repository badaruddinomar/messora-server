import { randomUUID } from "node:crypto";

export const UPLOAD_RULES = {
  receipt: {
    maxBytes: 5 * 1024 * 1024,
    types: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  },
} as const;

export type UploadPurpose = keyof typeof UPLOAD_RULES;
export type UploadContentType = keyof (typeof UPLOAD_RULES)[UploadPurpose]["types"];

/** Plain, path-safe keys only: lowercase segments, no `..`, no leading slash. */
export const isSafeKey = (key: string) => /^[a-z0-9-]+(\/[a-z0-9-]+)*\.[a-z0-9]+$/.test(key);

const folder = (messId: string, purpose: UploadPurpose) => `messes/${messId}/${purpose}s/`;

export const newFileKey = (messId: string, purpose: UploadPurpose, contentType: UploadContentType) =>
  `${folder(messId, purpose)}${randomUUID()}.${UPLOAD_RULES[purpose].types[contentType]}`;

/** Whether a key was issued for this mess and purpose (so one mess can't attach another's files). */
export const belongsTo = (key: string, messId: string, purpose: UploadPurpose) =>
  isSafeKey(key) && key.startsWith(folder(messId, purpose));
