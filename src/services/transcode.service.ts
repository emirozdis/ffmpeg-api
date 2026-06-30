import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { config } from '../config/env';
import { jobService } from './job.service';
import { metricsRecorder } from './metrics-recorder';
import { logger } from '../utils/logger';
import { downloadFileFromR2, uploadDirectoryToR2, uploadFileToR2 } from './r2.service';
import { sendWebhook } from './webook.service';

interface VideoMetadata {
  hasAudio: boolean;
  durationMs: number;
}

const runCommand = (cmd: string, timeoutMs: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
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

export const processVideo = async (jobId: string, initialInputPath: string): Promise<void> => {
  const job = jobService.getJob(jobId);
  if (!job) return;

  const transcodeStartTime = Date.now();
  let activeInputPath = initialInputPath;
  const outputDir = path.join(config.PROCESSED_DIR, jobId);
  const originalFileName = job ? job.originalFileName : 'unknown';

  // Extract flag instructions
  const options = job.remotePayload?.options || {};
  const generateHls = options.generateHls !== false; // defaults to true
  const generateThumbnail = !!options.generateThumbnail;
  const generateBlur = !!options.generateBlur;
  const facingMode = options.facingMode || 'user';
  const thumbnailTime = options.thumbnailTime ?? 0.5;

  let localThumbPath = '';
  let localBlurPath = '';

  try {
    // 1. DOWNLOAD PHASE (Remote Jobs Only)
    if (job.remotePayload) {
      jobService.updateJobStatus(jobId, 'DOWNLOADING', 0);
      const ext = path.extname(job.remotePayload.sourceKey) || '.mp4';
      activeInputPath = path.join(config.UPLOAD_DIR, `${jobId}${ext}`);
      
      await downloadFileFromR2(job.remotePayload.bucket, job.remotePayload.sourceKey, activeInputPath);
    }

    const metadata = await probeVideoMetadata(activeInputPath);
    const { hasAudio, durationMs } = metadata;

    // 2. EXTRACTION PHASE (Thumbnails)
    if (generateThumbnail && job.remotePayload?.thumbnailKey) {
      logger.info(`[Transcoder] Extracting standard thumbnail frame at ${thumbnailTime}s for clip: ${jobId}`);
      localThumbPath = path.join(config.PROCESSED_DIR, `${jobId}-thumb.jpg`);
      
      const flipFilter = facingMode === 'user' ? '-vf hflip' : '';
      const cmd = `ffmpeg -y -i "${activeInputPath}" -ss ${thumbnailTime} ${flipFilter} -vframes 1 -q:v 2 "${localThumbPath}"`;
      
      await runCommand(cmd, 15000);
    }

    if (generateBlur && job.remotePayload?.blurKey) {
      logger.info(`[Transcoder] Extracting blur placeholder at ${thumbnailTime}s for clip: ${jobId}`);
      localBlurPath = path.join(config.PROCESSED_DIR, `${jobId}-blur.jpg`);
      
      const filters = facingMode === 'user' ? 'scale=80:142,hflip' : 'scale=80:142';
      const cmd = `ffmpeg -y -i "${activeInputPath}" -ss ${thumbnailTime} -vf "${filters}" -vframes 1 -q:v 15 "${localBlurPath}"`;
      
      await runCommand(cmd, 15000);
    }

    // 3. TRANSCODE PHASE (HLS Ladder)
    if (generateHls) {
      jobService.updateJobStatus(jobId, 'PROCESSING', 0);
      
      fs.mkdirSync(outputDir, { recursive: true });
      ['stream_0', 'stream_1', 'stream_2'].forEach((dir) => {
        fs.mkdirSync(path.join(outputDir, dir), { recursive: true });
      });

      await new Promise<void>((resolve, reject) => {
        const filterComplex = [
          '[0:v]split=3[v1][v2][v3]',
          '[v1]scale=-2:1920[v1out]', // 1080p
          '[v2]scale=-2:1280[v2out]', // 720p
          '[v3]scale=-2:854[v3out]'   // 480p
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

    // 4. UPLOAD PHASE (Remote Jobs Only)
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

    // 5. FINALIZE & WEBHOOK CALLBACK
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
    
    // Notify Next.js server of remote failure
    if (job.remotePayload) {
      await sendWebhook(job.remotePayload.webhookUrl, {
        jobId: jobId,
        event: 'Error',
        payload: job.remotePayload.webhookPayload,
      });
    }
  } finally {
    // 6. SECURE GARBAGE COLLECTION
    if (activeInputPath && fs.existsSync(activeInputPath)) {
      fs.unlink(activeInputPath, () => {});
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
  }
};