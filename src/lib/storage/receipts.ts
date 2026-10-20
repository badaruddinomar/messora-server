import { ERROR_CODES } from "../../constants/error-codes.js";
import { ApiError } from "../../utils/api-error.js";
import { logger } from "../logger.js";
import { belongsTo } from "./keys.js";
import { storage } from "./index.js";

/** A receipt key sent with a record must be this mess's, and the upload must have finished. */
export async function assertReceipt(messId: string, key: string) {
  if (!belongsTo(key, messId, "receipt") || !(await storage.stat(key))) {
    throw ApiError.unprocessable(
      "The receipt didn't finish uploading. Try adding it again.",
      ERROR_CODES.RECEIPT_NOT_FOUND,
    );
  }
}

/** Deleting a replaced receipt is best effort: a leftover file is harmless, a failed request isn't. */
export function discardFile(key: string | null) {
  if (!key) return;
  storage.delete(key).catch((err) => logger.warn({ err, key }, "Couldn't delete an old file"));
}
