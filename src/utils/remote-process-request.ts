import { config } from '../config/env';
import { RemoteProcessPayload } from '../types';
import { AppError } from './AppError';
import { validateComposition } from './composition';
import { validateRemoteStoragePaths } from './remote-storage-paths';
import { validateStorageBucket } from './storage';
import { webhookPayloadMatchesJob } from './webhook-payload';

const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export interface ValidatedRemoteProcessRequest {
  jobId: string;
  originalFileName: string;
  payload: RemoteProcessPayload;
}

function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new AppError('Invalid webhook URL.', 400);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('Invalid webhook URL.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/api/webhooks/transcoder' || url.search || url.hash ||
      !config.ALLOWED_WEBHOOK_ORIGINS.includes(url.origin)) {
    throw new AppError('Webhook URL is not allowlisted.', 400);
  }
  return url.toString();
}

export function validateRemoteProcessRequest(body: Record<string, unknown>): ValidatedRemoteProcessRequest {
  const { jobId, bucket, sourceKey, outputDirKey, thumbnailKey, blurKey, webhookUrl, webhookPayload, options } = body;

  if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)) {
    throw new AppError('Invalid idempotent job identifier.', 400);
  }
  if (typeof sourceKey !== 'string') {
    throw new AppError('Invalid source object key.', 400);
  }
  const safeBucket = validateStorageBucket(bucket);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AppError('Invalid remote processing options.', 400);
  }
  const safeOptions = options as Record<string, unknown>;
  if ((safeOptions.generateHls !== undefined && typeof safeOptions.generateHls !== 'boolean') ||
      (safeOptions.generateThumbnail !== undefined && typeof safeOptions.generateThumbnail !== 'boolean') ||
      (safeOptions.generateBlur !== undefined && typeof safeOptions.generateBlur !== 'boolean') ||
      (safeOptions.facingMode !== undefined && !['user', 'environment'].includes(String(safeOptions.facingMode))) ||
      (safeOptions.thumbnailTime !== undefined &&
        (typeof safeOptions.thumbnailTime !== 'number' || !Number.isFinite(safeOptions.thumbnailTime) ||
          safeOptions.thumbnailTime < 0 || safeOptions.thumbnailTime > 30))) {
    throw new AppError('Invalid remote processing options.', 400);
  }
  const sanitizedOptions = {
    generateHls: safeOptions.generateHls as boolean | undefined,
    generateThumbnail: safeOptions.generateThumbnail as boolean | undefined,
    generateBlur: safeOptions.generateBlur as boolean | undefined,
    facingMode: safeOptions.facingMode as 'user' | 'environment' | undefined,
    thumbnailTime: safeOptions.thumbnailTime as number | undefined,
    composition: validateComposition(safeOptions.composition),
  };
  if (webhookPayload !== undefined && (typeof webhookPayload !== 'string' || webhookPayload.length > 4096)) {
    throw new AppError('Invalid webhook payload.', 400);
  }
  if (typeof webhookPayload === 'string' && !webhookPayloadMatchesJob(webhookPayload, jobId)) {
    throw new AppError('Webhook payload does not match the job.', 400);
  }

  const safeWebhookUrl = validateWebhookUrl(webhookUrl);
  validateRemoteStoragePaths({ jobId, sourceKey, outputDirKey, thumbnailKey, blurKey, options: sanitizedOptions });

  return {
    jobId,
    originalFileName: sourceKey.split('/').pop() || `${jobId}.mp4`,
    payload: {
      bucket: safeBucket,
      sourceKey,
      outputDirKey: outputDirKey as string | undefined,
      thumbnailKey: thumbnailKey as string | undefined,
      blurKey: blurKey as string | undefined,
      webhookUrl: safeWebhookUrl,
      webhookPayload: webhookPayload as string | undefined,
      options: sanitizedOptions,
    },
  };
}
