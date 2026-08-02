# MyTurn Video Pipeline Service

The MyTurn Video Pipeline Service is a robust, dynamic video ingestion, transcoding, and optimization microservice designed specifically for video uploads and short-form content. Built with Express, TypeScript, and fluent-ffmpeg, the service processes local video uploads as well as remote pipeline requests directly integrated with Cloudflare R2 storage.

---

## Architecture & Features

- **HLS Adaptive Bitrate Streaming Ladder**: Automatically segments video inputs into standard HLS adaptive streams (multi-variant playlists at 1080p, 720p, and 480p) optimized for dynamic mobile and web playback.
- **Adaptive NVIDIA Pipeline**: The GPU image prefers NVDEC, then safely falls back to software decode plus CUDA upload when NVDEC is unavailable. Scaling and all three encodes remain GPU-resident, with an exact startup probe and live telemetry.
- **Single-Decode Asset Extraction**: Produces the poster thumbnail and blur placeholder from one decoded video frame, including intelligent camera mirroring correction (`facingMode` support).
- **Dynamic Load balancing and Concurrency Control**: Monitors logical CPU usage, memory thresholds, and load averages to continuously scale worker concurrency counts up or down to avoid runtime bottlenecks.
- **Incremental Cloudflare R2 Pipeline**: Uploads atomically completed HLS segments while FFmpeg is still encoding, publishes playlists only after completion, and enforces bounded upload concurrency.
- **Automated Webhook Notifications**: Dispatches rich event payloads (`Saved`, `Error`) to configurable target endpoints upon job completion or execution failures.
- **Self-Diagnostic Health Monitoring**: Real-time evaluation of underlying hardware parameters, GPU encoder availability (NVENC, VideoToolbox, VAAPI, QSV), and read/write directories.

---

## Prerequisites

Before starting the server, ensure your hosting environment has the following system dependencies installed and available in your global environment PATH:

1. **Node.js** (v22.x or later recommended)
2. **FFmpeg** (v7.1+ with `h264_cuvid`, `h264_nvenc`, `scale_cuda`, `hwupload_cuda`, `libx264`, and `aac`)
3. **FFprobe** (packaged typically alongside standard FFmpeg installations)

---

## Quick Start

For an ordinary always-on Vast instance, use [`Dockerfile.gpu`](Dockerfile.gpu)
and follow [`docs/vast-ai.md`](docs/vast-ai.md). This is the same authenticated
HTTP worker contract used by a persistent Coolify deployment and does not need
`REPORT_ADDR` or any other PyWorker metadata.

For Vast scale-to-zero only, use [`Dockerfile.serverless`](Dockerfile.serverless)
and [`docs/vast-serverless.md`](docs/vast-serverless.md).

### 1. Installation

Clone the repository and install dependency components:

```bash
npm install
```

### 2. Configuration

Create a `.env` file in the root of your application based on the following configurations:

```env
PORT=3000
API_KEY=your-secure-shared-api-key

# Storage Directories
UPLOAD_DIR=./storage/uploads
PROCESSED_DIR=./storage/processed
# Mount this directory on a persistent volume in production.
STATE_DIR=./storage/state

# Job Configuration and Load Tuning
MAX_CONCURRENT_JOBS=0
MIN_CONCURRENT_JOBS=1
MAX_CONCURRENT_JOBS_CAP=8
AUTO_SCALE_CONCURRENCY=true
MONITOR_INTERVAL_MS=5000
METRICS_BUFFER_SIZE=100

# NVIDIA GPU image. p3 provides a fast, phone-friendly quality balance.
VIDEO_ENCODER=h264_nvenc
NVENC_PRESET=p3
NVENC_TUNE=hq
REQUIRE_CUDA_PIPELINE=true
CUDA_DEVICE=0
CUDA_DECODE_MODE=auto
GPU_TELEMETRY_INTERVAL_MS=5000

# Cloudflare R2 Storage Credentials
CLOUDFLARE_R2_ACCOUNT_ID=your-r2-account-id
CLOUDFLARE_R2_ACCESS_KEY_ID=your-r2-access-key-id
CLOUDFLARE_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
CLOUDFLARE_R2_BUCKET_NAME=vlogs
R2_UPLOAD_CONCURRENCY=10
R2_UPLOAD_POLL_MS=250

# Logging Levels (silly, debug, http, info, warn, error, fatal)
LOG_LEVEL=info
LOG_FILE_LEVEL=debug
LOG_FILE_PATH=./storage/logs/app.log
```

### 3. Execution

#### Development Mode (with hot reloading)
```bash
npm run dev
```

#### Production Build & Run
```bash
npm run build
npm start
```

---

## API Documentation

All routes (with the exception of `/health`) require authentication using the `x-api-key` header matching your configured `API_KEY`.

### 1. Video Endpoints

#### `POST /api/v1/videos/upload`
Accepts a physical video file upload through standard multipart/form-data.

- **Header**: `x-api-key: <API_KEY>`
- **Payload**: `video` (file stream, maximum default limit of 500MB)
- **Response**:
```json
{
  "status": "success",
  "message": "Video upload accepted. Processing queued.",
  "data": {
    "jobId": "48b3c437-0df7-4b78-b196-8096245d8b85",
    "status": "PENDING"
  }
}
```

#### `POST /api/v1/videos/process-remote`
Triggers an automated processing task for a video already resident on a Cloudflare R2 bucket.

- **Header**: `x-api-key: <API_KEY>`
- **JSON Payload Example**:
```json
{
  "bucket": "myturn-media-bucket",
  "sourceKey": "uploads/raw-vlog-123.mp4",
  "outputDirKey": "processed/vlog-123/hls",
  "thumbnailKey": "processed/vlog-123/thumbnail.jpg",
  "blurKey": "processed/vlog-123/blur.jpg",
  "webhookUrl": "https://api.myturn.app/webhooks/video-processed",
  "webhookPayload": "{\"userId\":\"usr_92834\",\"clipId\":\"clp_58204\"}",
  "options": {
    "generateHls": true,
    "generateThumbnail": true,
    "generateBlur": true,
    "facingMode": "user",
    "thumbnailTime": 1.2
  }
}
```
- **Response**:
```json
{
  "status": "success",
  "message": "Remote processing job queued successfully.",
  "data": {
    "jobId": "b1b1c3a6-b52e-4cb8-9907-f27be6395b11",
    "status": "PENDING"
  }
}
```

#### `GET /api/v1/videos/status/:jobId`
Returns status, progress tracking value, and eventual results or error state for a video processing job.

- **Header**: `x-api-key: <API_KEY>`
- **Response**:
```json
{
  "status": "success",
  "data": {
    "jobId": "b1b1c3a6-b52e-4cb8-9907-f27be6395b11",
    "status": "PROCESSING",
    "progress": 42,
    "outputPath": null,
    "error": null
  }
}
```

---

### 2. System Monitoring Endpoints

#### `GET /api/v1/system/health`
Performs comprehensive integration checks and hardware evaluations of FFmpeg, FFprobe, and writable file system permissions. Returns a status code of `503` if critical checks fail.

- **Header**: `x-api-key: <API_KEY>`
- **Response**:
```json
{
  "status": "ok",
  "message": "All systems operational",
  "checks": [
    { "name": "ffmpeg", "status": "pass", "message": "ffmpeg 6.0" },
    { "name": "ffprobe", "status": "pass", "message": "ffprobe is installed and working" },
    { "name": "environment", "status": "pass", "message": "Environment configuration is valid" },
    { "name": "upload-dir", "status": "pass", "message": "Upload directory is writable" },
    { "name": "processed-dir", "status": "pass", "message": "Processed directory is writable" }
  ],
  "timestamp": "2024-03-31T20:15:30.123Z"
}
```

#### `GET /api/v1/system`
Queries diagnostic system statistics including resource utilization ratios, detected hardware capacity, GPU encoder availability, and internal scaling parameters.

- **Header**: `x-api-key: <API_KEY>`

#### `GET /api/v1/system/metrics`
Collects operational metrics of historically executed jobs, average conversion times, performance throughput ratios, and active/completed job statistics.

- **Header**: `x-api-key: <API_KEY>`

---

## Webhook Payloads

Upon completion, the remote pipeline posts an event to the requested callback URL specified in the job definition.

### Success Webhook Payload Example
```json
{
  "jobId": "b1b1c3a6-b52e-4cb8-9907-f27be6395b11",
  "event": "Saved",
  "payload": "{\"userId\":\"usr_92834\",\"clipId\":\"clp_58204\"}",
  "data": {
    "hlsUrl": "processed/vlog-123/hls/master.m3u8",
    "thumbnailUrl": "processed/vlog-123/thumbnail.jpg",
    "thumbnailBlurUrl": "processed/vlog-123/blur.jpg"
  }
}
```

### Failure Webhook Payload Example
```json
{
  "jobId": "b1b1c3a6-b52e-4cb8-9907-f27be6395b11",
  "event": "Error",
  "payload": "{\"userId\":\"usr_92834\",\"clipId\":\"clp_58204\"}",
  "error": "Pipeline execution timeout during download phase."
}
```
