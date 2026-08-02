import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { AppConfig } from '../types';

dotenv.config();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './storage/uploads');
const PROCESSED_DIR = path.resolve(process.env.PROCESSED_DIR || './storage/processed');
const STATE_DIR = path.resolve(process.env.STATE_DIR || './storage/state');
const configuredWebhookOrigins = (process.env.TRANSCODER_ALLOWED_WEBHOOK_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOWED_WEBHOOK_ORIGINS = configuredWebhookOrigins.length > 0
  ? configuredWebhookOrigins
  : process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:3000'];

const configuredVideoEncoder = process.env.VIDEO_ENCODER || 'libx264';
if (!['libx264', 'h264_nvenc'].includes(configuredVideoEncoder)) {
  throw new Error('VIDEO_ENCODER must be either libx264 or h264_nvenc');
}
const configuredCudaDecodeMode = process.env.CUDA_DECODE_MODE || 'auto';
if (!['auto', 'nvdec', 'software'].includes(configuredCudaDecodeMode)) {
  throw new Error('CUDA_DECODE_MODE must be auto, nvdec, or software');
}

// Ensure storage directories exist immediately
[UPLOAD_DIR, PROCESSED_DIR, STATE_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export const config: AppConfig = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ENABLE_VAST_SERVERLESS: process.env.ENABLE_VAST_SERVERLESS === 'true',
  // Fail closed when credentials are absent; never ship a shared fallback key.
  API_KEY: process.env.API_KEY || '',
  WEBHOOK_SECRET: process.env.TRANSCODER_WEBHOOK_SECRET || '',
  UPLOAD_DIR,
  PROCESSED_DIR,
  STATE_DIR,
  MAX_FILE_SIZE: 500 * 1024 * 1024, // 500 MB limit for vlogs
  MAX_CONCURRENT_JOBS: parseInt(process.env.MAX_CONCURRENT_JOBS || '0', 10),
  METRICS_BUFFER_SIZE: parseInt(process.env.METRICS_BUFFER_SIZE || '100', 10),
  MONITOR_INTERVAL_MS: parseInt(process.env.MONITOR_INTERVAL_MS || '5000', 10),
  AUTO_SCALE_CONCURRENCY: process.env.AUTO_SCALE_CONCURRENCY !== 'false',
  MIN_CONCURRENT_JOBS: parseInt(process.env.MIN_CONCURRENT_JOBS || '1', 10),
  MAX_CONCURRENT_JOBS_CAP: parseInt(process.env.MAX_CONCURRENT_JOBS_CAP || '8', 10),
  VIDEO_ENCODER: configuredVideoEncoder as 'libx264' | 'h264_nvenc',
  NVENC_PRESET: process.env.NVENC_PRESET || 'p3',
  NVENC_TUNE: process.env.NVENC_TUNE || 'hq',
  CUDA_DEVICE: parseInt(process.env.CUDA_DEVICE || '0', 10),
  CUDA_DECODE_MODE: configuredCudaDecodeMode as 'auto' | 'nvdec' | 'software',
  REQUIRE_CUDA_PIPELINE: process.env.REQUIRE_CUDA_PIPELINE === 'true',
  GPU_TELEMETRY_INTERVAL_MS: parseInt(process.env.GPU_TELEMETRY_INTERVAL_MS || '5000', 10),

  // R2 Credentials
  R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET_NAME: process.env.CLOUDFLARE_R2_BUCKET_NAME || 'vlogs',
  ALLOWED_WEBHOOK_ORIGINS,
};
