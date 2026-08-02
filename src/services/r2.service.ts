import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/env';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { logger } from '../utils/logger';
import { mapWithConcurrency } from '../utils/async-pool';

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});

export const downloadFileFromR2 = async (bucket: string, key: string, destPath: string): Promise<void> => {
  logger.info(`[R2] Downloading s3://${bucket}/${key}`);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await r2Client.send(command);
  
  if (!response.Body) {
    throw new Error('Empty response body from R2');
  }
  
  await pipeline(response.Body as NodeJS.ReadableStream, fs.createWriteStream(destPath));
};

async function getFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const res = path.resolve(dir, entry.name);
      return entry.isDirectory() ? getFilesRecursively(res) : [res];
    })
  );
  return Array.prototype.concat(...files);
}

async function uploadLocalFile(bucket: string, key: string, file: string, contentType?: string): Promise<void> {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file),
      ContentType: contentType || mime.lookup(file) || 'application/octet-stream',
    }),
  );
}

function getUploadTarget(prefixKey: string, localDirPath: string, file: string): string {
  const relativePath = path.relative(localDirPath, file).replace(/\\/g, '/');
  return `${prefixKey}/${relativePath}`;
}

export const uploadDirectoryToR2 = async (bucket: string, prefixKey: string, localDirPath: string): Promise<void> => {
  logger.info(`[R2] Uploading directory ${localDirPath} to s3://${bucket}/${prefixKey}`);
  const files = await getFilesRecursively(localDirPath);
  await mapWithConcurrency(files, config.R2_UPLOAD_CONCURRENCY, async (file) => {
    await uploadLocalFile(bucket, getUploadTarget(prefixKey, localDirPath, file), file);
  });
  
  logger.info(`[R2] Finished uploading ${files.length} files to s3://${bucket}/${prefixKey}`);
};

export interface IncrementalDirectoryUpload {
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export const startIncrementalDirectoryUpload = (
  bucket: string,
  prefixKey: string,
  localDirPath: string,
  concurrency = config.R2_UPLOAD_CONCURRENCY,
): IncrementalDirectoryUpload => {
  const uploaded = new Set<string>();
  let stopping = false;
  let failure: Error | undefined;
  let finishPromise: Promise<void> | undefined;

  const uploadAvailableFiles = async (includeManifests: boolean): Promise<void> => {
    const files = await getFilesRecursively(localDirPath);
    const candidates = files.filter((file) =>
      !uploaded.has(file) &&
      !file.endsWith('.tmp') &&
      (includeManifests || /\.(?:ts|m4s)$/i.test(file)),
    );
    await mapWithConcurrency(candidates, concurrency, async (file) => {
      const key = getUploadTarget(prefixKey, localDirPath, file);
      await uploadLocalFile(bucket, key, file);
      uploaded.add(file);
      logger.debug('[R2] Incremental HLS object uploaded', { bucket, key });
    });
  };

  logger.info('[R2] Incremental HLS upload started', {
    bucket,
    prefixKey,
    concurrency,
    pollIntervalMs: config.R2_UPLOAD_POLL_MS,
  });

  const loopPromise = (async () => {
    while (!stopping) {
      await uploadAvailableFiles(false);
      if (!stopping) {
        await new Promise((resolve) => setTimeout(resolve, config.R2_UPLOAD_POLL_MS));
      }
    }
  })().catch((error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    stopping = true;
  });

  return {
    finish(): Promise<void> {
      if (!finishPromise) {
        finishPromise = (async () => {
          stopping = true;
          await loopPromise;
          if (failure) throw failure;
          // Complete every media object before publishing playlists that refer to them.
          await uploadAvailableFiles(false);
          await uploadAvailableFiles(true);
          logger.info('[R2] Incremental HLS upload completed', {
            bucket,
            prefixKey,
            uploadedObjects: uploaded.size,
          });
        })();
      }
      return finishPromise;
    },
    async abort(): Promise<void> {
      stopping = true;
      await loopPromise;
      logger.warn('[R2] Incremental HLS upload aborted', {
        bucket,
        prefixKey,
        uploadedObjects: uploaded.size,
        error: failure?.message,
      });
    },
  };
};

export const uploadFileToR2 = async (bucket: string, key: string, localPath: string, contentType: string): Promise<void> => {
  logger.info(`[R2] Uploading file ${localPath} to s3://${bucket}/${key}`);
  await uploadLocalFile(bucket, key, localPath, contentType);
};
