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
import { downloadFileFromR2, uploadDirectoryToR2, uploadFileToR2 } from './r2.service';
import { sendWebhook } from './webook.service';
import { RecordingComposition } from '../types';

interface VideoMetadata {
  hasAudio: boolean;
  durationMs: number;
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

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outputPath,
  );
  await runFfmpeg(args, 10 * 60_000);
  return outputPath;
}

export const processVideo = async (jobId: string, initialInputPath: string): Promise<void> => {
  const job = jobService.getJob(jobId);
  if (!job) return;

  const transcodeStartTime = Date.now();
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

  try {
    if (job.remotePayload) {
      jobService.updateJobStatus(jobId, 'DOWNLOADING', 0);
      const requestedExt = path.extname(job.remotePayload.sourceKey).toLowerCase();
      const ext = ['.mp4', '.mov', '.m4v', '.webm'].includes(requestedExt) ? requestedExt : '.mp4';
      activeInputPath = path.join(config.UPLOAD_DIR, `${jobId}${ext}`);
      
      await downloadFileFromR2(job.remotePayload.bucket, job.remotePayload.sourceKey, activeInputPath);
      downloadedSourcePath = activeInputPath;
    }

    if (composition) {
      jobService.updateJobStatus(jobId, 'PROCESSING', 0);
      activeInputPath = await composeRecordingSegments(activeInputPath, composition, compositionDir);
    }

    const metadata = await probeVideoMetadata(activeInputPath);
    const { hasAudio, durationMs } = metadata;

    if (generateThumbnail && job.remotePayload?.thumbnailKey) {
      logger.info(`[Transcoder] Extracting standard thumbnail frame at ${thumbnailTime}s for clip: ${jobId}`);
      localThumbPath = path.join(config.PROCESSED_DIR, `${jobId}-thumb.jpg`);
      
      const args = ['-y', '-i', activeInputPath, '-ss', String(thumbnailTime)];
      if (!composition && facingMode === 'user') args.push('-vf', 'hflip');
      args.push('-vframes', '1', '-q:v', '2', localThumbPath);
      await runFfmpeg(args, 15000);
    }

    if (generateBlur && job.remotePayload?.blurKey) {
      logger.info(`[Transcoder] Extracting blur placeholder at ${thumbnailTime}s for clip: ${jobId}`);
      localBlurPath = path.join(config.PROCESSED_DIR, `${jobId}-blur.jpg`);
      
      const filters = !composition && facingMode === 'user' ? 'scale=80:142,hflip' : 'scale=80:142';
      await runFfmpeg([
        '-y', '-i', activeInputPath, '-ss', String(thumbnailTime),
        '-vf', filters, '-vframes', '1', '-q:v', '15', localBlurPath,
      ], 15000);
    }

    if (generateHls) {
      jobService.updateJobStatus(jobId, 'PROCESSING', 0);
      
      if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
      fs.mkdirSync(outputDir, { recursive: true });
      ['stream_0', 'stream_1', 'stream_2'].forEach((dir) => {
        fs.mkdirSync(path.join(outputDir, dir), { recursive: true });
      });

      await new Promise<void>((resolve, reject) => {
        const filterComplex = [
          '[0:v]split=3[v1][v2][v3]',
          '[v1]scale=-2:1920[v1out]', 
          '[v2]scale=-2:1280[v2out]', 
          '[v3]scale=-2:854[v3out]'   
        ].join(';');

        const outputOptions: string[] = [
          '-threads', '0',
          '-preset', 'veryfast',
          '-filter_complex', filterComplex,
          
          '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '4500k', '-maxrate:v:0', '5000k', '-bufsize:v:0', '9000k',
          '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '2500k', '-maxrate:v:1', '2700k', '-bufsize:v:1', '5000k',
          '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '1200k', '-maxrate:v:2', '1400k', '-bufsize:v:2', '2400k',
        ];

        if (hasAudio) {
          outputOptions.push(
            '-map', '0:a', '-c:a:0', 'aac', '-b:a:0', '128k', '-ac', '2',
            '-map', '0:a', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',
            '-map', '0:a', '-c:a:2', 'aac', '-b:a:2', '128k', '-ac', '2'
          );
        }

        const varStreamMap = hasAudio ? 'v:0,a:0 v:1,a:1 v:2,a:2' : 'v:0 v:1 v:2';

        outputOptions.push(
          '-f', 'hls',
          '-hls_time', '4',
          '-hls_playlist_type', 'vod',
          '-hls_flags', 'independent_segments',
          '-hls_segment_type', 'mpegts',
          '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'data%03d.ts'),
          '-master_pl_name', 'master.m3u8',
          '-var_stream_map', varStreamMap
        );

        const masterPlaylistPath = path.join(outputDir, 'stream_%v', 'playlist.m3u8');

        ffmpeg(activeInputPath)
          .outputOptions(outputOptions)
          .output(masterPlaylistPath)
          .on('progress', (progress) => {
            if (progress.percent) {
              const roundedProgress = Math.min(Math.round(progress.percent), 99);
              jobService.updateJobStatus(jobId, 'PROCESSING', roundedProgress);
            }
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      const transcodeDurationMs = Date.now() - transcodeStartTime;
      metricsRecorder.record(
        jobId,
        originalFileName,
        activeInputPath,
        outputDir,
        durationMs,
        transcodeDurationMs,
        'COMPLETED'
      );
    }

    if (job.remotePayload) {
      jobService.updateJobStatus(jobId, 'UPLOADING', 0);
      
      if (generateHls && job.remotePayload.outputDirKey) {
        await uploadDirectoryToR2(job.remotePayload.bucket, job.remotePayload.outputDirKey, outputDir);
      }
      if (localThumbPath && fs.existsSync(localThumbPath)) {
        await uploadFileToR2(job.remotePayload.bucket, job.remotePayload.thumbnailKey!, localThumbPath, 'image/jpeg');
      }
      if (localBlurPath && fs.existsSync(localBlurPath)) {
        await uploadFileToR2(job.remotePayload.bucket, job.remotePayload.blurKey!, localBlurPath, 'image/jpeg');
      }
    }

    jobService.updateJobStatus(jobId, 'COMPLETED', 100, generateHls ? outputDir : undefined);

    if (job.remotePayload) {
      const hlsDir = job.remotePayload.outputDirKey;
      const hlsPath = hlsDir ? `${hlsDir}/master.m3u8` : null;

      await sendWebhook(job.remotePayload.webhookUrl, {
        jobId: jobId,
        event: 'Saved',
        payload: job.remotePayload.webhookPayload,
        data: {
          hlsUrl: generateHls ? hlsPath : null,
          thumbnailUrl: generateThumbnail ? job.remotePayload.thumbnailKey : null,
          thumbnailBlurUrl: generateBlur ? job.remotePayload.blurKey : null,
        }
      });
    }

  } catch (error: any) {
    logger.error(`Pipeline sequence failed for job ${jobId}`, { error: error.message });
    jobService.updateJobStatus(jobId, 'FAILED', undefined, undefined, error.message);
    
    if (job.remotePayload) {
      await sendWebhook(job.remotePayload.webhookUrl, {
        jobId: jobId,
        event: 'Error',
        payload: job.remotePayload.webhookPayload,
      });
    }
  } finally {
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
  }
};
