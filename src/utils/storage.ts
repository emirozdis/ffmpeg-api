import { AppError } from './AppError';

const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Accept the R2/S3 bucket selected by the authenticated caller while keeping
 * the value safe for AWS SDK requests. Storage credentials still determine
 * which buckets the transcoder is actually authorized to access.
 */
export function validateStorageBucket(value: unknown): string {
  if (typeof value !== 'string' || !BUCKET_NAME.test(value) ||
      value.includes('..') || value.includes('.-') || value.includes('-.') ||
      IPV4_ADDRESS.test(value)) {
    throw new AppError('Invalid storage bucket name.', 400);
  }
  return value;
}
