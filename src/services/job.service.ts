import { TranscodeJob, JobStatus, RemoteProcessPayload } from '../types';
import { v4 as uuidv4 } from 'uuid';

class JobService {
  private jobs: Map<string, TranscodeJob> = new Map();

  public createJob(originalFileName: string, inputPath: string): TranscodeJob {
    const id = uuidv4();
    const newJob: TranscodeJob = {
      id,
      status: 'PENDING',
      progress: 0,
      originalFileName,
      inputPath,
      outputPath: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobs.set(id, newJob);
    return newJob;
  }

  public createRemoteJob(originalFileName: string, payload: RemoteProcessPayload): TranscodeJob {
    const id = uuidv4();
    const newJob: TranscodeJob = {
      id,
      status: 'PENDING',
      progress: 0,
      originalFileName,
      inputPath: '', // Remains empty until downloading phase finishes
      outputPath: null,
      error: null,
      remotePayload: payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobs.set(id, newJob);
    return newJob;
  }

  public getJob(id: string): TranscodeJob | undefined {
    return this.jobs.get(id);
  }

  public updateJobStatus(id: string, status: JobStatus, progress?: number, outputPath?: string, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = status;
    job.updatedAt = new Date();

    if (progress !== undefined) job.progress = progress;
    if (outputPath !== undefined) job.outputPath = outputPath;
    if (error !== undefined) job.error = error;
  }
}

export const jobService = new JobService();