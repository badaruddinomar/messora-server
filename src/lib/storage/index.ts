import { env } from "../../config/env.js";
import { localStorage } from "./local.js";
import { createS3Storage } from "./s3.js";
import type { Storage } from "./types.js";

export const storage: Storage = env.STORAGE_DRIVER === "s3" ? createS3Storage() : localStorage;

export * from "./keys.js";
export type { Storage, StoredFile, UploadTarget } from "./types.js";
