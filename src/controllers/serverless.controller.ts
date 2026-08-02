import { execFile } from 'child_process';
import { Request, Response } from 'express';
import { jobService } from '../services/job.service';
import { processVideo } from '../services/transcode.service';
import { AppError } from '../utils/AppError';
import { catchAsync } from '../utils/catchAsync';
import { logger } from '../utils/logger';
import { validateRemoteProcessRequest } from '../utils/remote-process-request';

function runNvencBenchmark(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=1',
      '-an', '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq',
      '-f', 'null', '-',
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve();
    });
  });
}

export const benchmarkServerlessWorker = catchAsync(async (_req: Request, res: Response) => {
  await runNvencBenchmark();
  res.status(200).json({ status: 'success', workload: 100 });
});

export const processServerlessVideo = catchAsync(async (req: Request, res: Response) => {
  const { jobId, originalFileName, payload } = validateRemoteProcessRequest(req.body);
  const existing = jobService.getJob(jobId);

  if (existing?.status === 'COMPLETED') {
    return res.status(200).json({
      status: 'success',
      message: 'Remote processing job already completed.',
      data: { jobId, status: existing.status },
    });
  }
  if (existing && !['FAILED', 'COMPLETED'].includes(existing.status)) {
    throw new AppError('This job is already running on the worker.', 409);
  }

  const job = jobService.createRemoteJob(originalFileName, payload, jobId);
  logger.info(`Vast Serverless job ${jobId} started.`, {
    jobId,
    bucket: payload.bucket,
    sourceKey: payload.sourceKey,
  });

  await processVideo(job.id, job.inputPath);
  const completedJob = jobService.getJob(jobId);
  if (!completedJob || completedJob.status !== 'COMPLETED') {
    throw new AppError(completedJob?.error || 'Transcoding failed.', 500);
  }

  res.status(200).json({
    status: 'success',
    message: 'Remote processing job completed.',
    data: { jobId, status: completedJob.status },
  });
});
