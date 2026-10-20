/** Where the browser sends a file: a short-lived, pre-authorised PUT straight to storage. */
export interface UploadTarget {
  url: string;
  method: "PUT";
  /** Headers the browser must send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredFile {
  size: number;
  contentType: string;
}

/**
 * File storage behind one interface, so features never care whether files live on disk (development,
 * tests) or in an S3-compatible bucket (production). Keys look like `messes/<messId>/receipts/<id>.jpg`.
 */
export interface Storage {
  createUpload(key: string, contentType: string, size: number): Promise<UploadTarget>;
  /** A short-lived URL the browser can load the file from. */
  readUrl(key: string): Promise<string>;
  /** Size and type of a stored file, or null if it doesn't exist (e.g. the upload never finished). */
  stat(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}
