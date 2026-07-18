import fs from 'fs';
import path from 'path';
import { config } from '../config/env';
import { processVideo } from './transcode.service';
import { jobService } from './job.service';
import { loadMonitor } from './load-monitor';
import { logger } from '../utils/logger';

interface PersistedQueueState {
  version: 1;
  jobIds: string[];
}

class QueueService {
  private readonly queue: string[] = [];
  private readonly activeJobs = new Set<string>();
  private readonly statePath = path.join(config.STATE_DIR, 'queue.json');

  constructor() {
    this.restoreQueue();
    setImmediate(() => this.drain());
  }

  public enqueue(jobId: string): void {
    if (this.queue.includes(jobId) || this.activeJobs.has(jobId)) return;

    this.queue.push(jobId);
    this.persist();
    logger.info(`Enqueued job ${jobId}. Queue length: ${this.queue.length}`, {
      jobId,
      queueLength: this.queue.length,
    });
    this.drain();
  }

  private drain(): void {
    const maxConcurrent = Math.max(1, loadMonitor.getConcurrency());

    while (this.activeJobs.size < maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift();
      this.persist();
      if (!jobId || this.activeJobs.has(jobId)) continue;

      const job = jobService.getJob(jobId);
      if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') continue;

      this.activeJobs.add(jobId);
      void this.runJob(jobId, job.inputPath);
    }
  }

  private async runJob(jobId: string, inputPath: string): Promise<void> {
    const maxConcurrent = Math.max(1, loadMonitor.getConcurrency());
    logger.info(`Starting job ${jobId}. Active jobs: ${this.activeJobs.size}/${maxConcurrent}`, {
      jobId,
      activeCount: this.activeJobs.size,
      maxConcurrent,
    });

    try {
      await processVideo(jobId, inputPath);
    } catch (error) {
      logger.error(`Error processing job ${jobId}`, {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeJobs.delete(jobId);
      logger.info(`Finished job ${jobId}. Active jobs: ${this.activeJobs.size}`, {
        jobId,
        activeCount: this.activeJobs.size,
      });
      this.drain();
    }
  }

  private restoreQueue(): void {
    const restored: string[] = [];
    if (fs.existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedQueueState;
        if (parsed.version !== 1 || !Array.isArray(parsed.jobIds) || parsed.jobIds.some((id) => typeof id !== 'string')) {
          throw new Error('Unsupported queue state format.');
        }
        restored.push(...parsed.jobIds);
      } catch (error) {
        logger.error('Unable to read durable transcoder queue. Refusing to discard queued work.', {
          statePath: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const recoverableIds = jobService.getRecoverableJobs().map((job) => job.id);
    const uniqueIds = Array.from(new Set([...restored, ...recoverableIds])).filter((jobId) => {
      const job = jobService.getJob(jobId);
      return !!job && job.status !== 'COMPLETED' && job.status !== 'FAILED';
    });
    this.queue.push(...uniqueIds);
    this.persist();

    if (uniqueIds.length > 0) {
      logger.info(`Recovered ${uniqueIds.length} unfinished transcode job(s).`, {
        queueLength: uniqueIds.length,
      });
    }
  }

  private persist(): void {
    const state: PersistedQueueState = { version: 1, jobIds: [...this.queue] };
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.statePath);
  }
}

export const queueService = new QueueService();
