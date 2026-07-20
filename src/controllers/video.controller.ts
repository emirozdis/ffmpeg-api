import { Request, Response } from 'express';
import path from 'path';
import { webhookPayloadMatchesJob } from '../utils/webhook-payload';
import { AppError } from '../utils/AppError';
import { jobService } from '../services/job.service';
import { queueService } from '../services/queue.service';
import { catchAsync } from '../utils/catchAsync';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { validateComposition } from '../utils/composition';
import { validateStorageBucket } from '../utils/storage';
import { validateRemoteStoragePaths } from '../utils/remote-storage-paths';

const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/;

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

export const uploadVideo = catchAsync(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new AppError('No video file provided.', 400);
  }

  const { originalname, path: inputPath, size } = req.file;

  logger.info(`Video upload received: ${originalname}`, {
    method: req.method,
    originalname,
    size,
    inputPath,
    ip: req.ip,
  });

  const job = jobService.createJob(originalname, inputPath);
  queueService.enqueue(job.id);

  res.status(202).json({
    status: 'success',
    message: 'Video upload accepted. Processing queued.',
    data: {
      jobId: job.id,
      status: job.status,
    },
  });
});

export const processRemoteVideo = catchAsync(async (req: Request, res: Response) => {
  const { jobId, bucket, sourceKey, outputDirKey, thumbnailKey, blurKey, webhookUrl, webhookPayload, options } = req.body;

  if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)) {
    throw new AppError('Invalid idempotent job identifier.', 400);
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
  if (typeof webhookPayload === 'string') {
    if (!webhookPayloadMatchesJob(webhookPayload, jobId)) {
      throw new AppError('Webhook payload does not match the job.', 400);
    }
  }

  const safeWebhookUrl = validateWebhookUrl(webhookUrl);
  validateRemoteStoragePaths({ jobId, sourceKey, outputDirKey, thumbnailKey, blurKey, options: sanitizedOptions });

  logger.info(`Remote processing request received for s3://${safeBucket}/${sourceKey}`, { ip: req.ip });

  const existingJob = jobId ? jobService.getJob(jobId) : undefined;
  const job = jobService.createRemoteJob(
    path.basename(sourceKey),
    {
      bucket: safeBucket,
      sourceKey,
      outputDirKey,
      thumbnailKey,
      blurKey,
      webhookUrl: safeWebhookUrl,
      webhookPayload,
      options: sanitizedOptions,
    },
    jobId,
  );

  if (!existingJob) queueService.enqueue(job.id);

  res.status(202).json({
    status: 'success',
    message: 'Remote processing job queued successfully.',
    data: {
      jobId: job.id,
      status: job.status,
    },
  });
});

export const getJobStatus = catchAsync(async (req: Request, res: Response) => {
  const { jobId } = req.params;

  logger.debug(`Job status requested for ${jobId}`, { jobId, ip: req.ip });

  const job = jobService.getJob(jobId);
  if (!job) {
    logger.warn(`Job not found: ${jobId}`, { jobId });
    throw new AppError('Job not found.', 404);
  }

  res.status(200).json({
    status: 'success',
    data: {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      outputPath: job.outputPath,
      error: job.error,
    },
  });
});
