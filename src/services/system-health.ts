import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from '../config/env';
import { systemDetector } from './system-detector';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'critical';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export type OverallHealth = 'OK' | 'WARNING' | 'CRITICAL';

// ---------------------------------------------------------------------------
// HealthChecker class
// ---------------------------------------------------------------------------

export class HealthChecker {
  private checks: HealthCheck[] = [];

  constructor() {
    this.runChecks();
  }

  /** Run all health checks and return results. */
  runChecks(): HealthCheck[] {
    this.checks = [];

    this.checkFfmpeg();
    this.checkFfprobe();
    this.checkEnvironment();
    this.checkUploadDir();
    this.checkProcessedDir();
    this.checkStateDir();
    this.checkGpu();
    this.checkGpuPipeline();

    const counts = this.checks.reduce<Record<CheckStatus, number>>((summary, check) => {
      summary[check.status] += 1;
      return summary;
    }, { pass: 0, warn: 0, fail: 0, critical: 0 });

    for (const check of this.checks) {
      const context = {
        check: check.name,
        status: check.status,
        details: check.details,
      };
      if (check.status === 'critical' || check.status === 'fail') {
        logger.error(`Startup health check failed: ${check.name} — ${check.message}`, context);
      } else if (check.status === 'warn') {
        logger.warn(`Startup health check warning: ${check.name} — ${check.message}`, context);
      } else {
        logger.info(`Startup health check passed: ${check.name} — ${check.message}`, context);
      }
    }

    logger.info('Startup health checks completed', {
      total: this.checks.length,
      counts,
    });

    return this.checks;
  }

  /** Current health check results. */
  get checksResult(): HealthCheck[] {
    return this.checks;
  }

  /** Aggregated health status with message. */
  get health(): { status: OverallHealth; message: string } {
    const hasFail = this.checks.some((c) => c.status === 'fail' || c.status === 'critical');
    const hasWarn = this.checks.some((c) => c.status === 'warn');

    if (hasFail) {
      const failing = this.checks.filter((c) => c.status === 'fail' || c.status === 'critical');
      return {
        status: 'CRITICAL',
        message: `${failing.length} check(s) failed: ${failing.map((c) => c.name).join(', ')}`,
      };
    }
    if (hasWarn) {
      return { status: 'WARNING', message: 'All checks passed with warnings' };
    }
    return { status: 'OK', message: 'All systems operational' };
  }

  // --- individual checks ------------------------------------------------

  private checkFfmpeg(): void {
    try {
      const info = systemDetector.hardware.ffmpeg;
      if (!info.installed) {
        this.checks.push({ name: 'ffmpeg', status: 'fail', message: 'ffmpeg is not installed or not in PATH' });
        return;
      }
      this.checks.push({ name: 'ffmpeg', status: 'pass', message: `ffmpeg ${info.version}`, details: { version: info.version } });
    } catch {
      this.checks.push({ name: 'ffmpeg', status: 'fail', message: 'ffmpeg detection failed' });
    }
  }

  private checkFfprobe(): void {
    try {
      const info = systemDetector.hardware.ffmpeg;
      if (!info.ffprobeInstalled) {
        this.checks.push({ name: 'ffprobe', status: 'warn', message: 'ffprobe is not installed (required for video metadata probing)' });
        return;
      }
      this.checks.push({ name: 'ffprobe', status: 'pass', message: 'ffprobe is installed and working' });
    } catch {
      this.checks.push({ name: 'ffprobe', status: 'warn', message: 'ffprobe detection failed' });
    }
  }

  private checkEnvironment(): void {
    const issues: string[] = [];

    if (!config.UPLOAD_DIR) issues.push('UPLOAD_DIR not configured');
    if (!config.PROCESSED_DIR) issues.push('PROCESSED_DIR not configured');
    if (!config.STATE_DIR) issues.push('STATE_DIR not configured');
    if (!config.API_KEY) issues.push('API_KEY not configured');
    if (config.PORT < 1024 || config.PORT > 65535) issues.push(`PORT ${config.PORT} is out of valid range`);
    if (config.MAX_FILE_SIZE <= 0) issues.push('MAX_FILE_SIZE must be positive');
    if (!Number.isInteger(config.CUDA_DEVICE) || config.CUDA_DEVICE < 0) issues.push('CUDA_DEVICE must be a non-negative integer');
    if (!Number.isFinite(config.GPU_TELEMETRY_INTERVAL_MS) || config.GPU_TELEMETRY_INTERVAL_MS < 0) {
      issues.push('GPU_TELEMETRY_INTERVAL_MS must be zero or a positive integer');
    }

    if (issues.length > 0) {
      this.checks.push({ name: 'environment', status: 'warn', message: issues.join('; '), details: { issues } });
    } else {
      this.checks.push({ name: 'environment', status: 'pass', message: 'Environment configuration is valid', details: { port: config.PORT } });
    }
  }

  private checkUploadDir(): void {
    try {
      fs.accessSync(config.UPLOAD_DIR, fs.constants.W_OK);
      this.checks.push({ name: 'upload-dir', status: 'pass', message: `Upload directory is writable: ${config.UPLOAD_DIR}` });
    } catch {
      this.checks.push({ name: 'upload-dir', status: 'fail', message: `Upload directory is not writable: ${config.UPLOAD_DIR}` });
    }
  }

  private checkProcessedDir(): void {
    try {
      fs.accessSync(config.PROCESSED_DIR, fs.constants.W_OK);
      this.checks.push({ name: 'processed-dir', status: 'pass', message: `Processed directory is writable: ${config.PROCESSED_DIR}` });
    } catch {
      this.checks.push({ name: 'processed-dir', status: 'fail', message: `Processed directory is not writable: ${config.PROCESSED_DIR}` });
    }
  }

  private checkStateDir(): void {
    try {
      fs.accessSync(config.STATE_DIR, fs.constants.W_OK);
      this.checks.push({ name: 'state-dir', status: 'pass', message: `State directory is writable: ${config.STATE_DIR}` });
    } catch {
      this.checks.push({ name: 'state-dir', status: 'fail', message: `State directory is not writable: ${config.STATE_DIR}` });
    }
  }

  private checkGpu(): void {
    const gpu = systemDetector.hardware.gpu;
    if (!gpu.available) {
      this.checks.push({
        name: 'gpu',
        status: 'warn',
        message: `No GPU accelerator detected (using CPU-only encoding with ${gpu.h264Encoders.join(', ')})`,
      });
    } else {
      this.checks.push({
        name: 'gpu',
        status: 'pass',
        message: `GPU accelerator available: ${gpu.type} (h264: ${gpu.h264Encoders.join(', ')})`,
        details: { type: gpu.type, encoders: gpu.h264Encoders },
      });
    }
  }

  private checkGpuPipeline(): void {
    if (config.VIDEO_ENCODER !== 'h264_nvenc') {
      this.checks.push({
        name: 'gpu-pipeline',
        status: config.REQUIRE_CUDA_PIPELINE ? 'fail' : 'pass',
        message: config.REQUIRE_CUDA_PIPELINE
          ? 'REQUIRE_CUDA_PIPELINE requires VIDEO_ENCODER=h264_nvenc'
          : 'CUDA pipeline is disabled for the configured software encoder',
      });
      return;
    }

    try {
      const hwaccels = execSync('ffmpeg -hide_banner -hwaccels 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const filters = execSync('ffmpeg -hide_banner -filters 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const encoders = execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const missing = [
        !/^cuda$/m.test(hwaccels) ? 'cuda hwaccel' : '',
        !/\bscale_cuda\b/.test(filters) ? 'scale_cuda filter' : '',
        !/\bh264_nvenc\b/.test(encoders) ? 'h264_nvenc encoder' : '',
      ].filter(Boolean);

      if (missing.length > 0) {
        this.checks.push({
          name: 'gpu-pipeline',
          status: config.REQUIRE_CUDA_PIPELINE ? 'fail' : 'warn',
          message: `Missing FFmpeg GPU capabilities: ${missing.join(', ')}`,
          details: { missing, device: config.CUDA_DEVICE },
        });
        return;
      }

      this.checks.push({
        name: 'gpu-pipeline',
        status: 'pass',
        message: `${config.CUDA_DECODE_MODE === 'software' ? 'Software-decode/CUDA-upload' : 'NVDEC'}/CUDA/NVENC pipeline is available on CUDA device ${config.CUDA_DEVICE}`,
        details: {
          device: config.CUDA_DEVICE,
          decode: config.CUDA_DECODE_MODE === 'software' ? 'software decode with hwupload_cuda' : 'NVDEC via -hwaccel cuda',
          scale: 'scale_cuda',
          encode: 'h264_nvenc',
        },
      });
    } catch (error) {
      this.checks.push({
        name: 'gpu-pipeline',
        status: config.REQUIRE_CUDA_PIPELINE ? 'fail' : 'warn',
        message: `Unable to inspect FFmpeg GPU capabilities: ${error instanceof Error ? error.message : String(error)}`,
        details: { device: config.CUDA_DEVICE },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const healthChecker = new HealthChecker();
