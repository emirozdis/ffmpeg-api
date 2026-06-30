import os from 'os';
import { config } from '../config/env';
import { systemDetector } from './system-detector';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// LoadMonitor class
// ---------------------------------------------------------------------------

export class LoadMonitor {
  private currentConcurrency: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cpuCores: number;

  constructor() {
    this.cpuCores = systemDetector.hardware.cpu.logicalCores;

    // Initial concurrency: use env value if explicitly set (>0), otherwise auto-detect
    if (config.MAX_CONCURRENT_JOBS > 0) {
      this.currentConcurrency = Math.min(config.MAX_CONCURRENT_JOBS, config.MAX_CONCURRENT_JOBS_CAP);
      logger.info(`Concurrency set from env: ${this.currentConcurrency} jobs`, { concurrency: this.currentConcurrency });
    } else {
      // Auto-detect: 2x cores, capped at MAX_CONCURRENT_JOBS_CAP
      this.currentConcurrency = Math.min(this.cpuCores * 2, config.MAX_CONCURRENT_JOBS_CAP);
      this.currentConcurrency = Math.max(this.currentConcurrency, config.MIN_CONCURRENT_JOBS);
      logger.info(`Auto-detected concurrency: ${this.currentConcurrency} jobs (${this.cpuCores} CPU cores)`, { concurrency: this.currentConcurrency, cpuCores: this.cpuCores });
    }
  }

  /** Current concurrency value (adjusted for load). */
  getConcurrency(): number {
    return this.currentConcurrency;
  }

  /** Set concurrency directly (e.g., for testing or admin). */
  setConcurrency(value: number): void {
    this.currentConcurrency = Math.max(config.MIN_CONCURRENT_JOBS, Math.min(value, config.MAX_CONCURRENT_JOBS_CAP));
  }

  /** Adjust concurrency based on current system load. */
  adjustForLoad(cpuUsagePct: number, freeMemoryBytes: number, loadAvg: [number, number, number]): void {
    if (!config.AUTO_SCALE_CONCURRENCY) return;

    const totalMemory = os.totalmem();
    let adjusted = this.currentConcurrency;

    // Scale down under heavy load
    const loadAvgRatio = loadAvg[0] / this.cpuCores;
    if (loadAvgRatio > 0.8) {
      adjusted = Math.max(config.MIN_CONCURRENT_JOBS, Math.floor(adjusted * 0.7));
    }
    if (cpuUsagePct > 85) {
      adjusted = Math.max(config.MIN_CONCURRENT_JOBS, Math.floor(adjusted * 0.7));
    }
    if (freeMemoryBytes < totalMemory * 0.1) {
      adjusted = Math.max(config.MIN_CONCURRENT_JOBS, Math.floor(adjusted * 0.5));
    }

    // Scale up when load is light
    if (loadAvgRatio < 0.2) {
      adjusted = Math.min(config.MAX_CONCURRENT_JOBS_CAP, Math.ceil(adjusted * 1.2));
    }
    if (cpuUsagePct < 20) {
      adjusted = Math.min(config.MAX_CONCURRENT_JOBS_CAP, Math.ceil(adjusted * 1.1));
    }

    adjusted = Math.max(config.MIN_CONCURRENT_JOBS, Math.min(adjusted, config.MAX_CONCURRENT_JOBS_CAP));

    if (adjusted !== this.currentConcurrency) {
      this.currentConcurrency = adjusted;
      logger.info(`Concurrency adjusted: ${this.currentConcurrency} (load=${loadAvgRatio.toFixed(2)}, cpu=${cpuUsagePct.toFixed(0)}%, mem=${((1 - freeMemoryBytes / totalMemory) * 100).toFixed(0)}%)`, {
        concurrency: adjusted,
        loadAvg,
        cpuUsagePct,
        freeMemoryBytes,
      });
    }
  }

  /** Periodic auto-adjustment. Call every N seconds via setInterval. */
  autoAdjust(): void {
    const loadAvg = os.loadavg();
    const freeMemory = os.freemem();
    const cpuUsage = (loadAvg[0] / this.cpuCores) * 100;
    this.adjustForLoad(cpuUsage, freeMemory, loadAvg as [number, number, number]);
  }

  /** Start periodic monitoring. */
  start(): void {
    if (this.timer) return;
    if (!config.AUTO_SCALE_CONCURRENCY) {
      logger.debug('Auto-scaling is disabled, monitor will not run');
      return;
    }
    this.timer = setInterval(() => {
      this.autoAdjust();
    }, config.MONITOR_INTERVAL_MS);
    logger.info(`Load monitor started (${config.MONITOR_INTERVAL_MS / 1000}s interval)`, { intervalMs: config.MONITOR_INTERVAL_MS });
  }

  /** Stop periodic monitoring. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Load monitor stopped');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const loadMonitor = new LoadMonitor();
