import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import type { Storage } from "./types.js";

const UPLOAD_TTL_S = 10 * 60;
const READ_TTL_S = 60 * 60;

/** Production storage: any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO). The bucket stays private. */
export function createS3Storage(): Storage {
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });
  const Bucket = env.S3_BUCKET!;

  return {
    async createUpload(key, contentType, size) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: UPLOAD_TTL_S,
        // Signing these headers means the browser can't upload a different type or size.
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": contentType },
        expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000),
      };
    },

    readUrl: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: READ_TTL_S }),

    async stat(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
