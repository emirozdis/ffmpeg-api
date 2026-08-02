import { Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { jobService } from '../services/job.service';
import { queueService } from '../services/queue.service';
import { catchAsync } from '../utils/catchAsync';
import { logger } from '../utils/logger';
import { validateRemoteProcessRequest } from '../utils/remote-process-request';

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
  const { jobId, originalFileName, payload } = validateRemoteProcessRequest(req.body);

  logger.info(`Remote processing request received for s3://${payload.bucket}/${payload.sourceKey}`, { ip: req.ip });

  const existingJob = jobId ? jobService.getJob(jobId) : undefined;
  const shouldEnqueue = !existingJob || existingJob.status === 'COMPLETED' || existingJob.status === 'FAILED';
  const job = jobService.createRemoteJob(
    originalFileName,
    payload,
    jobId,
  );

  if (shouldEnqueue) queueService.enqueue(job.id);

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
