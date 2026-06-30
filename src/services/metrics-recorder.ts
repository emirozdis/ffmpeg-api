import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobMetrics {
  jobId: string;
  originalFileName: string;
  inputFileSizeBytes: number;
  outputDirectorySizeBytes: number;
  videoDurationMs: number;
  transcodeDurationMs: number;
  speedRatio: number;
  sizeRatio: number;
  status: 'COMPLETED' | 'FAILED';
  completedAt: string;
}

export interface AggregatedMetrics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  successRate: number;
  avgProcessingTimeMs: number;
  avgSpeedRatio: number;
  throughputJobsPerHour: number;
  firstJobAt: string;
  lastJobAt: string;
}

// ---------------------------------------------------------------------------
// MetricsRecorder class
// ---------------------------------------------------------------------------

export class MetricsRecorder {
  private buffer: JobMetrics[] = [];
  private totalStartTime: number = 0;

  constructor() {
    logger.info('Metrics recorder initialized', { bufferSize: config.METRICS_BUFFER_SIZE });
  }

  /** Record a completed or failed job. */
  record(
    jobId: string,
    originalFileName: string,
    inputPath: string,
    outputDir: string,
    videoDurationMs: number,
    transcodeDurationMs: number,
    status: 'COMPLETED' | 'FAILED',
  ): void {
    const inputFileSize = this.getFileSize(inputPath);
    const outputDirSize = this.getDirSize(outputDir);

    const metrics: JobMetrics = {
      jobId,
      originalFileName,
      inputFileSizeBytes: inputFileSize,
      outputDirectorySizeBytes: outputDirSize,
      videoDurationMs,
      transcodeDurationMs,
      speedRatio: videoDurationMs > 0 ? transcodeDurationMs / videoDurationMs : 0,
      sizeRatio: inputFileSize > 0 ? outputDirSize / inputFileSize : 0,
      status,
      completedAt: new Date().toISOString(),
    };

    this.buffer.push(metrics);
    if (this.buffer.length > config.METRICS_BUFFER_SIZE) {
      this.buffer.shift();
    }

    if (status === 'COMPLETED') {
      logger.info(`Job ${jobId} completed: ${speedRatioStr(metrics.speedRatio)} in ${msStr(transcodeDurationMs)}`, {
        jobId,
        speedRatio: metrics.speedRatio,
        durationMs: transcodeDurationMs,
      });
    } else {
      logger.warn(`Job ${jobId} failed`, { jobId });
    }
  }

  /** Set the total start time for throughput calculation. */
  setTotalStartTime(ms: number): void {
    this.totalStartTime = ms;
  }

  /** Recent job metrics (last N). */
  get recentJobs(): JobMetrics[] {
    return [...this.buffer];
  }

  /** Aggregated metrics from all recorded jobs. */
  get aggregated(): AggregatedMetrics {
    const completed = this.buffer.filter((m) => m.status === 'COMPLETED');
    const failed = this.buffer.filter((m) => m.status === 'FAILED');
    const total = completed.length + failed.length;

    const totalProcessingTime = completed.reduce((sum, m) => sum + m.transcodeDurationMs, 0);
    const totalSpeedRatio = completed.reduce((sum, m) => sum + m.speedRatio, 0);

    const avgProcessingTimeMs = completed.length > 0 ? totalProcessingTime / completed.length : 0;
    const avgSpeedRatio = completed.length > 0 ? totalSpeedRatio / completed.length : 0;

    // Throughput: jobs per hour
    let throughputJobsPerHour = 0;
    if (total > 0) {
      const elapsedMs = this.totalStartTime > 0 ? Date.now() - this.totalStartTime : totalProcessingTime;
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      throughputJobsPerHour = elapsedHours > 0 ? total / elapsedHours : total;
    }

    const firstJob = this.buffer[0]?.completedAt ?? '';
    const lastJob = this.buffer[this.buffer.length - 1]?.completedAt ?? '';

    return {
      totalJobs: total,
      completedJobs: completed.length,
      failedJobs: failed.length,
      successRate: total > 0 ? completed.length / total : 0,
      avgProcessingTimeMs,
      avgSpeedRatio,
      throughputJobsPerHour,
      firstJobAt: firstJob,
      lastJobAt: lastJob,
    };
  }

  /** Get full metrics report. */
  getMetrics(): { recentJobs: JobMetrics[]; aggregated: AggregatedMetrics; currentConcurrency: number } {
    return {
      recentJobs: this.recentJobs,
      aggregated: this.aggregated,
      currentConcurrency: 0, // set externally
    };
  }

  /** Reset all metrics. */
  reset(): void {
    this.buffer = [];
    this.totalStartTime = 0;
    logger.info('Metrics recorder reset');
  }

  // --- helpers -----------------------------------------------------------

  private getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private getDirSize(dirPath: string): number {
    let total = 0;
    if (!fs.existsSync(dirPath)) return 0;
    try {
      const entries = fs.readdirSync(dirPath, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            total += fs.statSync(path.join(dirPath, entry.path)).size;
          } catch {
            // skip
          }
        }
      }
    } catch {
      // ignore
    }
    return total;
  }
}

// --- formatting helpers -----------------------------------------------------

function speedRatioStr(ratio: number): string {
  if (ratio === 0) return 'N/A';
  const multiplier = (1 / ratio).toFixed(1);
  return `${multiplier}x`;
}

function msStr(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const metricsRecorder = new MetricsRecorder();
