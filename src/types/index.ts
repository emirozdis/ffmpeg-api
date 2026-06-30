// ─── Existing types ───────────────────────────────────────────────────────

export interface AppConfig {
  PORT: number;
  API_KEY: string;
  UPLOAD_DIR: string;
  PROCESSED_DIR: string;
  MAX_FILE_SIZE: number;
  MAX_CONCURRENT_JOBS: number;
  METRICS_BUFFER_SIZE: number;
  MONITOR_INTERVAL_MS: number;
  AUTO_SCALE_CONCURRENCY: boolean;
  MIN_CONCURRENT_JOBS: number;
  MAX_CONCURRENT_JOBS_CAP: number;
  
  // Cloudflare R2 Integration
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export type JobStatus = 'PENDING' | 'DOWNLOADING' | 'PROCESSING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';

export interface RemoteProcessOptions {
  generateHls?: boolean;
  generateThumbnail?: boolean;
  generateBlur?: boolean;
  facingMode?: 'user' | 'environment';
  thumbnailTime?: number;
}

export interface RemoteProcessPayload {
  bucket: string;
  sourceKey: string;
  outputDirKey?: string;
  thumbnailKey?: string;
  blurKey?: string;
  webhookUrl: string;
  webhookPayload?: string;
  options?: RemoteProcessOptions;
}

export interface TranscodeJob {
  id: string;
  status: JobStatus;
  progress: number;
  originalFileName: string;
  inputPath: string;
  outputPath: string | null;
  error: string | null;
  remotePayload?: RemoteProcessPayload;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Hardware & health types ─────────────────────────────────────────────

export type HealthStatus = 'OK' | 'WARNING' | 'CRITICAL';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

export interface CpuInfo {
  model: string;
  logicalCores: number;
  physicalCores: number;
  speedMhz: number;
}

export interface RamInfo {
  total: number;
  available: number;
  totalGigabytes: number;
  availableGigabytes: number;
}

export type GpuType = 'videotoolbox' | 'nvenc' | 'vaapi' | 'qsv' | 'none';

export interface GpuInfo {
  type: GpuType;
  available: boolean;
  h264Encoders: string[];
  hevcEncoders: string[];
  aacEncoders: string[];
}

export interface FfmpegInfo {
  version: string;
  ffprobeVersion: string;
  installed: boolean;
  ffprobeInstalled: boolean;
}

export interface SystemHardware {
  cpu: CpuInfo;
  ram: RamInfo;
  gpu: GpuInfo;
  ffmpeg: FfmpegInfo;
  platform: {
    os: string;
    arch: string;
    nodeVersion: string;
    uptimeSeconds: number;
  };
}

// ─── Metrics types ───────────────────────────────────────────────────────

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
}