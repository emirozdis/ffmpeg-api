import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/env';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { logger } from '../utils/logger';

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

export const uploadDirectoryToR2 = async (bucket: string, prefixKey: string, localDirPath: string): Promise<void> => {
  logger.info(`[R2] Uploading directory ${localDirPath} to s3://${bucket}/${prefixKey}`);
  const files = await getFilesRecursively(localDirPath);
  
  const uploadPromises = files.map(async (file) => {
    const relativePath = path.relative(localDirPath, file).replace(/\\/g, '/');
    const r2Key = `${prefixKey}/${relativePath}`;
    const contentType = mime.lookup(file) || 'application/octet-stream';
    
    const fileStream = fs.createReadStream(file);
    
    await r2Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        Body: fileStream,
        ContentType: contentType,
      })
    );
  });

  for (let i = 0; i < uploadPromises.length; i += 10) {
    await Promise.all(uploadPromises.slice(i, i + 10));
  }
  
  logger.info(`[R2] Finished uploading ${files.length} files to s3://${bucket}/${prefixKey}`);
};

export const uploadFileToR2 = async (bucket: string, key: string, localPath: string, contentType: string): Promise<void> => {
  logger.info(`[R2] Uploading file ${localPath} to s3://${bucket}/${key}`);
  const fileStream = fs.createReadStream(localPath);
  
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    })
  );
};