import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { env } from "./env.js"
import type { TempFileStorage } from "./temp-file-storage.js"

export type S3TempFileStorageConfig = {
  bucket: string
  region: string
  endpoint?: string
  prefix: string
  forcePathStyle: boolean
}

function missingKeyError(error: unknown) {
  const name = (error as { name?: string } | null)?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  return name === "NoSuchKey" || name === "NotFound" || status === 404
}

export function s3TempFileStorage(
  config: S3TempFileStorageConfig = resolveS3Config(),
  client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
  }),
): TempFileStorage {
  return {
    tier: "s3",
    keyFor: (fileId) => `${config.prefix}${fileId}`,
    async put(key, bytes) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: new Uint8Array(bytes),
      }))
    },
    async read(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        const bytes = await result.Body?.transformToByteArray()
        if (!bytes) return null
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      } catch (error) {
        if (missingKeyError(error)) return null
        throw error
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      } catch (error) {
        if (missingKeyError(error)) return
        throw error
      }
    },
  }
}

export function resolveS3Config(): S3TempFileStorageConfig {
  const bucket = env.tempFiles.s3.bucket
  if (!bucket) {
    throw new Error("DEN_TEMP_FILES_S3_BUCKET is required when DEN_TEMP_FILES_STORAGE=s3")
  }
  return {
    bucket,
    region: env.tempFiles.s3.region,
    endpoint: env.tempFiles.s3.endpoint,
    prefix: env.tempFiles.s3.prefix,
    forcePathStyle: env.tempFiles.s3.forcePathStyle,
  }
}
