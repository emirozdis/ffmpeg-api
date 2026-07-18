import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/env';
import { TranscodeJob, JobStatus, RemoteProcessPayload } from '../types';
import { logger } from '../utils/logger';

interface PersistedJobState {
  version: 1;
  jobs: Array<Omit<TranscodeJob, 'createdAt' | 'updatedAt'> & {
    createdAt: string;
    updatedAt: string;
  }>;
}

class JobService {
  private readonly jobs = new Map<string, TranscodeJob>();
  private readonly statePath = path.join(config.STATE_DIR, 'jobs.json');

  constructor() {
    this.loadFromDisk();
  }

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
    this.persist();
    return newJob;
  }

  public createRemoteJob(originalFileName: string, payload: RemoteProcessPayload, requestedId?: string): TranscodeJob {
    const id = requestedId || uuidv4();
    const existing = this.jobs.get(id);
    if (existing) return existing;

    const newJob: TranscodeJob = {
      id,
      status: 'PENDING',
      progress: 0,
      originalFileName,
      inputPath: '',
      outputPath: null,
      error: null,
      remotePayload: payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobs.set(id, newJob);
    this.persist();
    return newJob;
  }

  public getJob(id: string): TranscodeJob | undefined {
    return this.jobs.get(id);
  }

  public getRecoverableJobs(): TranscodeJob[] {
    const recoverable = Array.from(this.jobs.values()).filter(
      (job) => job.status !== 'COMPLETED' && job.status !== 'FAILED',
    );

    if (recoverable.length > 0) {
      const recoveredAt = new Date();
      recoverable.forEach((job) => {
        job.status = 'PENDING';
        job.progress = 0;
        job.error = null;
        job.updatedAt = recoveredAt;
      });
      this.persist();
    }

    return recoverable;
  }

  public updateJobStatus(id: string, status: JobStatus, progress?: number, outputPath?: string, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = status;
    job.updatedAt = new Date();

    if (progress !== undefined) job.progress = progress;
    if (outputPath !== undefined) job.outputPath = outputPath;
    if (error !== undefined) job.error = error;
    this.persist();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.statePath)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedJobState;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error('Unsupported job state format.');
      }

      parsed.jobs.forEach((storedJob) => {
        if (!storedJob.id || !storedJob.status || !storedJob.originalFileName) {
          throw new Error('Invalid job entry in persisted state.');
        }
        const createdAt = new Date(storedJob.createdAt);
        const updatedAt = new Date(storedJob.updatedAt);
        if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
          throw new Error(`Invalid timestamps for persisted job ${storedJob.id}.`);
        }
        this.jobs.set(storedJob.id, { ...storedJob, createdAt, updatedAt });
      });

      logger.info(`Restored ${this.jobs.size} transcoder job(s) from durable state.`, {
        jobs: this.jobs.size,
        statePath: this.statePath,
      });
    } catch (error) {
      logger.error('Unable to read durable transcoder job state. Refusing to discard queued work.', {
        statePath: this.statePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private persist(): void {
    const state: PersistedJobState = {
      version: 1,
      jobs: Array.from(this.jobs.values()).map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })),
    };
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.statePath);
  }
}

export const jobService = new JobService();
