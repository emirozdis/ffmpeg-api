import { processVideo } from './transcode.service';
import { jobService } from './job.service';
import { loadMonitor } from './load-monitor';
import { logger } from '../utils/logger';

class QueueService {
  private queue: string[] = []; // Array of Job IDs
  private activeCount = 0;

  /**
   * Adds a new transcode job to the scheduling queue.
   */
  public enqueue(jobId: string, inputPath: string): void {
    this.queue.push(jobId);
    logger.info(`Enqueued job ${jobId}. Queue length: ${this.queue.length}`, { jobId, queueLength: this.queue.length });
    this.processNext(inputPath);
  }

  /**
   * Attempts to process the next job in the queue if slots are available.
   */
  private async processNext(fallbackInputPath: string): Promise<void> {
    const maxConcurrent = loadMonitor.getConcurrency();

    if (this.activeCount >= maxConcurrent) {
      logger.debug(`Max concurrent jobs (${maxConcurrent}) reached. Waiting...`, { 
        activeCount: this.activeCount, 
        maxConcurrent 
      });
      return;
    }

    const jobId = this.queue.shift();
    if (!jobId) {
      return;
    }

    const job = jobService.getJob(jobId);
    if (!job) {
      this.processNext(fallbackInputPath);
      return;
    }

    this.activeCount++;
    logger.info(`Starting job ${jobId}. Active jobs: ${this.activeCount}/${maxConcurrent}`, { 
      jobId, 
      activeCount: this.activeCount, 
      maxConcurrent 
    });

    try {
      await processVideo(jobId, job.inputPath);
    } catch (error) {
      logger.error(`Error processing job ${jobId}`, { jobId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.activeCount--;
      logger.info(`Finished job ${jobId}. Active jobs: ${this.activeCount}/${maxConcurrent}`, { 
        jobId, 
        activeCount: this.activeCount, 
        maxConcurrent 
      });
      // Immediately trigger execution of the next pending job
      this.processNext(fallbackInputPath);
    }
  }
}

export const queueService = new QueueService();