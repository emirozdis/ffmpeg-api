import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { AppConfig } from '../types';

dotenv.config();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './storage/uploads');
const PROCESSED_DIR = path.resolve(process.env.PROCESSED_DIR || './storage/processed');

// Ensure storage directories exist immediately
[UPLOAD_DIR, PROCESSED_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export const config: AppConfig = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  API_KEY: process.env.API_KEY || 'myturn-super-secret-api-key', // Set securely in production
  UPLOAD_DIR,
  PROCESSED_DIR,
  MAX_FILE_SIZE: 500 * 1024 * 1024, // 500 MB limit for vlogs
  MAX_CONCURRENT_JOBS: parseInt(process.env.MAX_CONCURRENT_JOBS || '0', 10),
  METRICS_BUFFER_SIZE: parseInt(process.env.METRICS_BUFFER_SIZE || '100', 10),
  MONITOR_INTERVAL_MS: parseInt(process.env.MONITOR_INTERVAL_MS || '5000', 10),
  AUTO_SCALE_CONCURRENCY: process.env.AUTO_SCALE_CONCURRENCY !== 'false',
  MIN_CONCURRENT_JOBS: parseInt(process.env.MIN_CONCURRENT_JOBS || '1', 10),
  MAX_CONCURRENT_JOBS_CAP: parseInt(process.env.MAX_CONCURRENT_JOBS_CAP || '8', 10),

  // R2 Credentials
  R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
};