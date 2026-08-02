// myturn-video-pipeline/src/services/transcode.service.ts
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';
import { config } from '../config/env';
import { jobService } from './job.service';
import { metricsRecorder } from './metrics-recorder';
import { logger } from '../utils/logger';
import {
  downloadFileFromR2,
  IncrementalDirectoryUpload,
  startIncrementalDirectoryUpload,
  uploadDirectoryToR2,
  uploadFileToR2,
} from './r2.service';
import { sendWebhook } from './webook.service';
import { RecordingComposition } from '../types';

interface VideoMetadata {
  hasAudio: boolean;
  durationMs: number;
}

interface ImageDerivativePlanOptions {
  inputPath: string;
  thumbnailPath?: string;
  blurPath?: string;
  thumbnailTime: number;
  flipHorizontally: boolean;
}

export function buildImageDerivativePlan(options: ImageDerivativePlanOptions): string[] {
  if (!options.thumbnailPath && !options.blurPath) {
    throw new Error('At least one image derivative output is required');
  }

  const args = ['-y', '-ss', String(options.thumbnailTime), '-i', options.inputPath];
  if (options.thumbnailPath && options.blurPath) {
    const prefix = options.flipHorizontally ? 'hflip,' : '';
    args.push(
      '-filter_complex', `[0:v]${prefix}split=2[thumbnail][blur-source];[blur-source]scale=80:142[blur]`,
      '-map', '[thumbnail]', '-frames:v', '1', '-q:v', '2', options.thumbnailPath,
      '-map', '[blur]', '-frames:v', '1', '-q:v', '15', options.blurPath,
    );
    return args;
  }

  if (options.thumbnailPath) {
    if (options.flipHorizontally) args.push('-vf', 'hflip');
    args.push('-frames:v', '1', '-q:v', '2', options.thumbnailPath);
    return args;
  }

  const blurFilter = options.flipHorizontally ? 'hflip,scale=80:142' : 'scale=80:142';
  args.push('-vf', blurFilter, '-frames:v', '1', '-q:v', '15', options.blurPath!);
  return args;
}

export interface HlsTranscodePlan {
  pipeline: 'cuda-nvdec' | 'cuda-upload' | 'software';
  decode: 'nvdec' | 'software';
  inputOptions: string[];
  outputOptions: string[];
  filterComplex: string;
}

interface HlsTranscodePlanOptions {
  hasAudio: boolean;
  videoEncoder: 'libx264' | 'h264_nvenc';
  nvencPreset: string;
  nvencTune: string;
  cudaDevice: number;
  cudaDecodeMode: 'auto' | 'nvdec' | 'software';
}

async function runLoggedStage<T>(
  jobId: string,
  stage: string,
  operation: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = Date.now();
  logger.info(`Pipeline stage started: ${stage}`, { jobId, stage, ...context });
  try {
    const result = await operation();
    logger.info(`Pipeline stage completed: ${stage}`, {
      jobId,
      stage,
      durationMs: Date.now() - startedAt,
      ...context,
    });
    return result;
  } catch (error) {
    logger.error(`Pipeline stage failed: ${stage}`, {
      jobId,
      stage,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    });
    throw error;
  }
}

function parseTimemarkMs(timemark?: string): number | undefined {
  if (!timemark) return undefined;
  const parts = timemark.split(':').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return undefined;
  return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
}

function startGpuTelemetry(jobId: string): () => void {
  const intervalMs = Number.isFinite(config.GPU_TELEMETRY_INTERVAL_MS)
    ? Math.max(0, config.GPU_TELEMETRY_INTERVAL_MS)
    : 0;
  if (config.VIDEO_ENCODER !== 'h264_nvenc' || intervalMs <= 0) return () => {};

  let stopped = false;
  let queryInFlight = false;
  let warned = false;
  const sample = () => {
    if (stopped || queryInFlight) return;
    queryInFlight = true;
    execFile('nvidia-smi', [
      '-i', String(config.CUDA_DEVICE),
      '--query-gpu=index,name,utilization.gpu,utilization.memory,utilization.encoder,utilization.decoder,memory.used,memory.total,power.draw',
      '--format=csv,noheader,nounits',
    ], { timeout: 3000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      queryInFlight = false;
      if (stopped) return;
      if (error) {
        if (!warned) {
          warned = true;
          logger.warn('GPU telemetry is unavailable', {
            jobId,
            device: config.CUDA_DEVICE,
            error: stderr?.trim() || error.message,
          });
        }
        return;
      }

      const values = stdout.trim().split(',').map((value) => value.trim());
      logger.info('GPU telemetry sample', {
        jobId,
        device: values[0],
        name: values[1],
        gpuUtilizationPct: values[2],
        memoryUtilizationPct: values[3],
        encoderUtilizationPct: values[4],
        decoderUtilizationPct: values[5],
        memoryUsedMiB: values[6],
        memoryTotalMiB: values[7],
        powerDrawW: values[8],
      });
    });
  };

  sample();
  const timer = setInterval(sample, Math.max(1000, intervalMs));
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function buildHlsTranscodePlan(options: HlsTranscodePlanOptions): HlsTranscodePlan {
  const useCuda = options.videoEncoder === 'h264_nvenc';
  const useNvdec = useCuda && options.cudaDecodeMode !== 'software';
  const inputOptions = useNvdec
    ? [
        '-hwaccel', 'cuda',
        '-hwaccel_device', String(options.cudaDevice),
        '-hwaccel_output_format', 'cuda',
        '-threads', '1',
      ]
    : [];
  const filterComplex = useCuda
    ? [
        `${useNvdec ? '[0:v]' : `[0:v]format=yuv420p,hwupload_cuda=device=${options.cudaDevice},`}split=3[v1080src][v720src][v480src]`,
        '[v1080src]scale_cuda=w=-2:h=1920:format=yuv420p:interp_algo=bilinear:passthrough=0[v1080out]',
        '[v720src]scale_cuda=w=-2:h=1280:format=yuv420p:interp_algo=bilinear:passthrough=0[v720out]',
        '[v480src]scale_cuda=w=-2:h=854:format=yuv420p:interp_algo=bilinear:passthrough=0[v480out]',
      ].join(';')
    : [
        '[0:v]split=3[v1080src][v720src][v480src]',
        '[v1080src]scale=-2:1920[v1080out]',
        '[v720src]scale=-2:1280[v720out]',
        '[v480src]scale=-2:854[v480out]',
      ].join(';');

  const encoderOptions = (streamIndex: number): string[] => useCuda
    ? [
        `-preset:v:${streamIndex}`, options.nvencPreset,
        `-tune:v:${streamIndex}`, options.nvencTune,
        `-profile:v:${streamIndex}`, 'high',
        `-gpu:v:${streamIndex}`, String(options.cudaDevice),
        `-rc:v:${streamIndex}`, 'vbr',
        `-multipass:v:${streamIndex}`, 'disabled',
        `-spatial-aq:v:${streamIndex}`, '1',
        `-forced-idr:v:${streamIndex}`, '1',
      ]
    : [
        `-preset:v:${streamIndex}`, 'veryfast',
        `-profile:v:${streamIndex}`, 'high',
        `-pix_fmt:v:${streamIndex}`, 'yuv420p',
      ];

  const outputOptions: string[] = [
    '-threads', '0',
    '-vsync', '0',
    '-filter_complex', filterComplex,
    '-map', '[v1080out]', '-c:v:0', options.videoEncoder, ...encoderOptions(0), '-b:v:0', '4500k', '-maxrate:v:0', '5000k', '-bufsize:v:0', '9000k',
    '-map', '[v720out]', '-c:v:1', options.videoEncoder, ...encoderOptions(1), '-b:v:1', '2500k', '-maxrate:v:1', '2700k', '-bufsize:v:1', '5000k',
    '-map', '[v480out]', '-c:v:2', options.videoEncoder, ...encoderOptions(2), '-b:v:2', '1200k', '-maxrate:v:2', '1400k', '-bufsize:v:2', '2400k',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
  ];

  if (options.hasAudio) {
    outputOptions.push(
      '-map', '0:a', '-c:a:0', 'aac', '-b:a:0', '128k', '-ac', '2',
      '-map', '0:a', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',
      '-map', '0:a', '-c:a:2', 'aac', '-b:a:2', '128k', '-ac', '2',
    );
  }

  return {
    pipeline: useCuda ? (useNvdec ? 'cuda-nvdec' : 'cuda-upload') : 'software',
    decode: useNvdec ? 'nvdec' : 'software',
    inputOptions,
    outputOptions,
    filterComplex,
  };
}

const runFfmpeg = (args: string[], timeoutMs: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
};

const probeVideoMetadata = (inputPath: string): Promise<VideoMetadata> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const hasAudio = metadata.streams.some((stream) => stream.codec_type === 'audio');
      const durationSeconds = metadata.format.duration || 0;
      resolve({
        hasAudio,
        durationMs: Math.round(durationSeconds * 1000),
      });
    });
  });
};

async function extractCompositionSources(
  bundlePath: string,
  composition: RecordingComposition,
  workDir: string,
): Promise<string[]> {
  const bundleSize = fs.statSync(bundlePath).size;
  if (bundleSize !== composition.totalBytes) {
    throw new Error(`Composition bundle size mismatch: expected ${composition.totalBytes}, received ${bundleSize}`);
  }

  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < composition.segments.length; index += 1) {
    const segment = composition.segments[index];
    const segmentPath = path.join(workDir, `segment-${String(index).padStart(3, '0')}.mp4`);
    await pipeline(
      fs.createReadStream(bundlePath, { start: segment.offset, end: segment.offset + segment.length - 1 }),
      fs.createWriteStream(segmentPath, { flags: 'wx', mode: 0o600 }),
    );
    if (fs.statSync(segmentPath).size !== segment.length) {
      throw new Error(`Composition segment ${index} could not be extracted completely`);
    }
    paths.push(segmentPath);
  }
  return paths;
}

export async function composeRecordingSegments(
  bundlePath: string,
  composition: RecordingComposition,
  workDir: string,
): Promise<string> {
  const segmentPaths = await extractCompositionSources(bundlePath, composition, workDir);
  const segmentMetadata = await Promise.all(segmentPaths.map(probeVideoMetadata));
  const probedDurationMs = segmentMetadata.reduce((sum, metadata) => sum + metadata.durationMs, 0);
  const durationToleranceMs = 2_000 + composition.segments.length * 250;
  if (probedDurationMs <= 0 || probedDurationMs > composition.totalSourceDurationMs + durationToleranceMs) {
    throw new Error('Composition media duration exceeds its validated manifest');
  }
  const outputPath = path.join(workDir, 'composed.mp4');
  const args: string[] = ['-y'];
  segmentPaths.forEach((segmentPath) => args.push('-i', segmentPath));

  const filters: string[] = [];
  composition.segments.forEach((segment, index) => {
    const flip = segment.facingMode === 'user' ? ',hflip' : '';
    filters.push(
      `[${index}:v]setpts=(PTS-STARTPTS)/${segment.speed}${flip},` +
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[v${index}]`,
    );
    if (segmentMetadata[index].hasAudio) {
      filters.push(
        `[${index}:a]aresample=48000,atempo=${segment.speed},asetpts=N/SR/TB[a${index}]`,
      );
    } else {
      const outputDuration = Math.max(0.001, segmentMetadata[index].durationMs / 1000 / segment.speed);
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${outputDuration.toFixed(3)},asetpts=N/SR/TB[a${index}]`,
      );
    }
  });
  const concatInputs = composition.segments.map((_, index) => `[v${index}][a${index}]`).join('');
  filters.push(`${concatInputs}concat=n=${composition.segments.length}:v=1:a=1[vout][aout]`);

  const compositionVideoEncoder = config.VIDEO_ENCODER === 'h264_nvenc'
    ? [
        '-c:v', 'h264_nvenc',
        '-gpu', String(config.CUDA_DEVICE),
        '-preset', config.NVENC_PRESET,
        '-tune', config.NVENC_TUNE,
        '-multipass', 'disabled',
        '-spatial-aq', '1',
        '-pix_fmt', 'yuv420p',
      ]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...compositionVideoEncoder,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outputPath,
  );
  await runFfmpeg(args, 10 * 60_000);
  return outputPath;
}

export const processVideo = async (jobId: string, initialInputPath: string): Promise<void> => {
  const job = jobService.getJob(jobId);
  if (!job) return;

  const pipelineStartedAt = Date.now();
  let activeInputPath = initialInputPath;
  let downloadedSourcePath = '';
  const outputDir = path.join(config.PROCESSED_DIR, jobId);
  const compositionDir = path.join(config.PROCESSED_DIR, `${jobId}-composition`);
  const originalFileName = job ? job.originalFileName : 'unknown';

  const options = job.remotePayload?.options || {};
  const generateHls = options.generateHls !== false; 
  const generateThumbnail = !!options.generateThumbnail;
  const generateBlur = !!options.generateBlur;
  const facingMode = options.facingMode || 'user';
  const thumbnailTime = options.thumbnailTime ?? 0.5;
  const composition = options.composition;

  let localThumbPath = '';
  let localBlurPath = '';
  let incrementalHlsUpload: IncrementalDirectoryUpload | undefined;

  logger.info('Video pipeline started', {
    jobId,
    originalFileName,
    remote: !!job.remotePayload,
    encoder: config.VIDEO_ENCODER,
    pipeline: config.VIDEO_ENCODER === 'h264_nvenc'
      ? (config.CUDA_DECODE_MODE === 'software' ? 'software-cuda-nvenc' : 'nvdec-cuda-nvenc')
      : 'software',
    cudaDecodeMode: config.VIDEO_ENCODER === 'h264_nvenc' ? config.CUDA_DECODE_MODE : undefined,
    cudaDevice: config.VIDEO_ENCODER === 'h264_nvenc' ? config.CUDA_DEVICE : undefined,
    preset: config.VIDEO_ENCODER === 'h264_nvenc' ? config.NVENC_PRESET : undefined,
    tune: config.VIDEO_ENCODER === 'h264_nvenc' ? config.NVENC_TUNE : undefined,
    generateHls,
    generateThumbnail,
    generateBlur,
    hasComposition: !!composition,
  });

  try {
    if (job.remotePayload) {
      jobService.updateJobStatus(jobId, 'DOWNLOADING', 0);
      const requestedExt = path.extname(job.remotePayload.sourceKey).toLowerCase();
      const ext = ['.mp4', '.mov', '.m4v', '.webm'].includes(requestedExt) ? requestedExt : '.mp4';
      activeInputPath = path.join(config.UPLOAD_DIR, `${jobId}${ext}`);

      await runLoggedStage(jobId, 'r2-download', () =>
        downloadFileFromR2(job.remotePayload!.bucket, job.remotePayload!.sourceKey, activeInputPath), {
        bucket: job.remotePayload.bucket,
        sourceKey: job.remotePayload.sourceKey,
      });
      downloadedSourcePath = activeInputPath;
    }

    if (composition) {
      jobService.updateJobStatus(jobId, 'PROCESSING', 0);
      activeInputPath = await runLoggedStage(jobId, 'composition', () =>
        composeRecordingSegments(activeInputPath, composition, compositionDir), {
        segmentCount: composition.segments.length,
        implementation: 'software-required-filters',
      });
    }

    const metadata = await runLoggedStage(jobId, 'probe', () => probeVideoMetadata(activeInputPath));
    const { hasAudio, durationMs } = metadata;
    logger.info('Input media inspected', {
      jobId,
      durationMs,
      hasAudio,
      inputFileSizeBytes: fs.statSync(activeInputPath).size,
    });

    if (generateThumbnail && job.remotePayload?.thumbnailKey) {
      localThumbPath = path.join(config.PROCESSED_DIR, `${jobId}-thumb.jpg`);
    }

    if (generateBlur && job.remotePayload?.blurKey) {
      localBlurPath = path.join(config.PROCESSED_DIR, `${jobId}-blur.jpg`);
    }

    if (localThumbPath || localBlurPath) {
      const derivativeArgs = buildImageDerivativePlan({
        inputPath: activeInputPath,
        thumbnailPath: localThumbPath || undefined,
        blurPath: localBlurPath || undefined,
        thumbnailTime,
        flipHorizontally: !composition && facingMode === 'user',
      });
      await runLoggedStage(jobId, 'image-derivatives', () => runFfmpeg(derivativeArgs, 15000), {
        thumbnailTime,
        generateThumbnail: !!localThumbPath,
        generateBlur: !!localBlurPath,
        videoDecodeCount: 1,
      });
    }

    if (generateHls) {
      jobService.updateJobStatus(jobId, 'PROCESSING', 0);
      
      if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
      fs.mkdirSync(outputDir, { recursive: true });
      ['stream_0', 'stream_1', 'stream_2'].forEach((dir) => {
        fs.mkdirSync(path.join(outputDir, dir), { recursive: true });
      });

      const plan = buildHlsTranscodePlan({
        hasAudio,
        videoEncoder: config.VIDEO_ENCODER,
        nvencPreset: config.NVENC_PRESET,
        nvencTune: config.NVENC_TUNE,
        cudaDevice: config.CUDA_DEVICE,
        cudaDecodeMode: config.CUDA_DECODE_MODE,
      });
      const varStreamMap = hasAudio ? 'v:0,a:0 v:1,a:1 v:2,a:2' : 'v:0 v:1 v:2';
      plan.outputOptions.push(
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'data%03d.ts'),
        '-master_pl_name', 'master.m3u8',
        '-var_stream_map', varStreamMap,
      );

      if (job.remotePayload?.outputDirKey) {
        incrementalHlsUpload = startIncrementalDirectoryUpload(
          job.remotePayload.bucket,
          job.remotePayload.outputDirKey,
          outputDir,
        );
      }

      logger.info('HLS transcode plan selected', {
        jobId,
        pipeline: plan.pipeline,
        decode: plan.decode === 'nvdec' ? 'NVDEC (-hwaccel cuda)' : 'software',
        scale: plan.pipeline !== 'software' ? 'scale_cuda (bilinear)' : 'scale',
        encode: config.VIDEO_ENCODER,
        renditions: ['1080p@4500k', '720p@2500k', '480p@1200k'],
        audio: hasAudio ? 'AAC 128k x3' : 'none',
        preset: config.VIDEO_ENCODER === 'h264_nvenc' ? config.NVENC_PRESET : 'veryfast',
        tune: config.VIDEO_ENCODER === 'h264_nvenc' ? config.NVENC_TUNE : undefined,
        cudaDevice: plan.pipeline !== 'software' ? config.CUDA_DEVICE : undefined,
      });

      const hlsStartedAt = Date.now();
      await runLoggedStage(jobId, 'hls-transcode', () => new Promise<void>((resolve, reject) => {
        const masterPlaylistPath = path.join(outputDir, 'stream_%v', 'playlist.m3u8');
        const stderrTail: string[] = [];
        let lastLoggedPercent = -10;
        let lastLoggedAt = 0;
        const stopTelemetry = startGpuTelemetry(jobId);
        const command = ffmpeg(activeInputPath)
          .inputOptions(plan.inputOptions)
          .outputOptions(plan.outputOptions)
          .output(masterPlaylistPath)
          .on('start', (commandLine) => {
            logger.info('FFmpeg HLS process started', {
              jobId,
              pipeline: plan.pipeline,
              command: commandLine,
            });
          })
          .on('stderr', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            stderrTail.push(trimmed);
            if (stderrTail.length > 40) stderrTail.shift();
            logger.debug('FFmpeg output', { jobId, line: trimmed });
          })
          .on('progress', (progress) => {
            const timemarkMs = parseTimemarkMs(progress.timemark);
            const calculatedPercent = durationMs > 0 && timemarkMs !== undefined
              ? timemarkMs / durationMs * 100
              : progress.percent;
            if (calculatedPercent === undefined || !Number.isFinite(calculatedPercent)) return;

            const roundedProgress = Math.max(0, Math.min(Math.round(calculatedPercent), 99));
            jobService.updateJobStatus(jobId, 'PROCESSING', roundedProgress);
            const now = Date.now();
            if (roundedProgress >= lastLoggedPercent + 10 || now - lastLoggedAt >= 5000) {
              lastLoggedPercent = roundedProgress;
              lastLoggedAt = now;
              logger.info('FFmpeg HLS progress', {
                jobId,
                progressPct: roundedProgress,
                timemark: progress.timemark,
                currentFps: progress.currentFps,
                currentKbps: progress.currentKbps,
                targetSizeKiB: progress.targetSize,
              });
            }
          })
          .on('end', () => {
            stopTelemetry();
            logger.info('FFmpeg HLS process exited successfully', { jobId, pipeline: plan.pipeline });
            resolve();
          })
          .on('error', (error, _stdout, stderr) => {
            stopTelemetry();
            const diagnostic = (stderr || stderrTail.join('\n')).trim().slice(-12_000);
            logger.error('FFmpeg HLS process exited with an error', {
              jobId,
              pipeline: plan.pipeline,
              error: error.message,
              stderr: diagnostic,
            });
            reject(new Error(diagnostic || error.message));
          });
        command.run();
      }), { pipeline: plan.pipeline, durationMs });

      const transcodeDurationMs = Date.now() - hlsStartedAt;
      metricsRecorder.record(
        jobId,
        originalFileName,
        activeInputPath,
        outputDir,
        durationMs,
        transcodeDurationMs,
        'COMPLETED'
      );
      logger.info('HLS renditions generated', {
        jobId,
        pipeline: plan.pipeline,
        transcodeDurationMs,
        videoDurationMs: durationMs,
        speedRatio: durationMs > 0 ? transcodeDurationMs / durationMs : 0,
      });
    }

    if (job.remotePayload) {
      jobService.updateJobStatus(jobId, 'UPLOADING', 0);
      const uploadTasks: Promise<unknown>[] = [];
      if (generateHls && job.remotePayload.outputDirKey) {
        if (incrementalHlsUpload) {
          const uploader = incrementalHlsUpload;
          uploadTasks.push(runLoggedStage(jobId, 'r2-upload-hls-finalize', async () => {
            await uploader.finish();
            incrementalHlsUpload = undefined;
          }, {
            bucket: job.remotePayload.bucket,
            outputDirKey: job.remotePayload.outputDirKey,
            mode: 'incremental-during-transcode',
          }));
        } else {
          uploadTasks.push(runLoggedStage(jobId, 'r2-upload-hls', () =>
            uploadDirectoryToR2(job.remotePayload!.bucket, job.remotePayload!.outputDirKey!, outputDir), {
            bucket: job.remotePayload.bucket,
            outputDirKey: job.remotePayload.outputDirKey,
          }));
        }
      }
      if (localThumbPath && fs.existsSync(localThumbPath)) {
        uploadTasks.push(runLoggedStage(jobId, 'r2-upload-thumbnail', () =>
          uploadFileToR2(job.remotePayload!.bucket, job.remotePayload!.thumbnailKey!, localThumbPath, 'image/jpeg'), {
          bucket: job.remotePayload.bucket,
          thumbnailKey: job.remotePayload.thumbnailKey,
        }));
      }
      if (localBlurPath && fs.existsSync(localBlurPath)) {
        uploadTasks.push(runLoggedStage(jobId, 'r2-upload-blur', () =>
          uploadFileToR2(job.remotePayload!.bucket, job.remotePayload!.blurKey!, localBlurPath, 'image/jpeg'), {
          bucket: job.remotePayload.bucket,
          blurKey: job.remotePayload.blurKey,
        }));
      }
      await Promise.all(uploadTasks);
    }

    jobService.updateJobStatus(jobId, 'COMPLETED', 100, generateHls ? outputDir : undefined);

    if (job.remotePayload) {
      const hlsDir = job.remotePayload.outputDirKey;
      const hlsPath = hlsDir ? `${hlsDir}/master.m3u8` : null;

      await runLoggedStage(jobId, 'completion-webhook', () => sendWebhook(job.remotePayload!.webhookUrl, {
          jobId: jobId,
          event: 'Saved',
          payload: job.remotePayload!.webhookPayload,
          data: {
            hlsUrl: generateHls ? hlsPath : null,
            thumbnailUrl: generateThumbnail ? job.remotePayload!.thumbnailKey : null,
            thumbnailBlurUrl: generateBlur ? job.remotePayload!.blurKey : null,
          },
        }), { event: 'Saved' });
    }

    logger.info('Video pipeline completed', {
      jobId,
      totalDurationMs: Date.now() - pipelineStartedAt,
      outputDirKey: job.remotePayload?.outputDirKey,
      thumbnailKey: job.remotePayload?.thumbnailKey,
      blurKey: job.remotePayload?.blurKey,
    });

  } catch (error: any) {
    logger.error(`Pipeline sequence failed for job ${jobId}`, {
      jobId,
      totalDurationMs: Date.now() - pipelineStartedAt,
      error: error.message,
      stack: error.stack,
    });
    jobService.updateJobStatus(jobId, 'FAILED', undefined, undefined, error.message);
    
    if (job.remotePayload) {
      await runLoggedStage(jobId, 'error-webhook', () => sendWebhook(job.remotePayload!.webhookUrl, {
          jobId: jobId,
          event: 'Error',
          payload: job.remotePayload!.webhookPayload,
        }), { event: 'Error' });
    }
  } finally {
    logger.info('Pipeline cleanup started', { jobId });
    if (incrementalHlsUpload) {
      await incrementalHlsUpload.abort();
      incrementalHlsUpload = undefined;
    }
    if (activeInputPath && fs.existsSync(activeInputPath)) {
      fs.unlink(activeInputPath, () => {});
    }
    if (downloadedSourcePath && downloadedSourcePath !== activeInputPath && fs.existsSync(downloadedSourcePath)) {
      fs.unlink(downloadedSourcePath, () => {});
    }
    if (localThumbPath && fs.existsSync(localThumbPath)) {
      fs.unlink(localThumbPath, () => {});
    }
    if (localBlurPath && fs.existsSync(localBlurPath)) {
      fs.unlink(localBlurPath, () => {});
    }
    if (fs.existsSync(outputDir)) {
      fs.rm(outputDir, { recursive: true, force: true }, () => {});
    }
    if (fs.existsSync(compositionDir)) {
      fs.rm(compositionDir, { recursive: true, force: true }, () => {});
    }
    logger.info('Pipeline cleanup scheduled', {
      jobId,
      totalDurationMs: Date.now() - pipelineStartedAt,
    });
  }
};
