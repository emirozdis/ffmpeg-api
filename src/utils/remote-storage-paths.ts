import { AppError } from './AppError';

const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/;
const SOURCE_FILE = /^([a-zA-Z0-9_-]{8,128})-media\.(mp4|mov|m4v|webm)$/i;
const RESPONSE_FILE = /^([a-zA-Z0-9_-]{8,128})\.mp4$/i;

export function validateRemoteStoragePaths(input: {
  jobId: string;
  sourceKey: unknown;
  outputDirKey: unknown;
  thumbnailKey: unknown;
  blurKey: unknown;
  options: Record<string, unknown>;
}) {
  if (typeof input.sourceKey !== 'string' || input.sourceKey.length > 1024 ||
      input.sourceKey.startsWith('/') || input.sourceKey.includes('\\') ||
      input.sourceKey.includes('//') || /[\u0000-\u001f\u007f]/.test(input.sourceKey)) {
    throw new AppError('Invalid source storage key.', 400);
  }

  const parts = input.sourceKey.split('/');
  const namespaceParts = parts[0] === 'vlogs' ? parts.slice(1) : parts;
  const isResponse = namespaceParts.length === 4 && namespaceParts[2] === 'responses';
  const isClip = namespaceParts.length === 3;
  if (!isClip && !isResponse) {
    throw new AppError('Source storage key is outside the vlog namespace.', 400);
  }

  const [groupId, assignmentId] = namespaceParts;
  const fileName = namespaceParts[namespaceParts.length - 1];
  const sourceMatch = isResponse ? fileName.match(RESPONSE_FILE) : fileName.match(SOURCE_FILE);
  if (!SAFE_ID.test(groupId) || !SAFE_ID.test(assignmentId) || !sourceMatch) {
    throw new AppError('Source storage key is outside the vlog namespace.', 400);
  }

  const prefix = input.sourceKey.slice(0, input.sourceKey.length - fileName.length);
  const mediaId = sourceMatch[1];
  const generateHls = input.options.generateHls !== false;
  const generateThumbnail = input.options.generateThumbnail === true;
  const generateBlur = input.options.generateBlur === true;

  if (generateHls && input.outputDirKey !== `${prefix}${input.jobId}_hls`) {
    throw new AppError('Invalid HLS output storage key.', 400);
  }
  if (generateThumbnail && input.thumbnailKey !== `${prefix}${mediaId}-thumb.jpg`) {
    throw new AppError('Invalid thumbnail storage key.', 400);
  }
  if (generateBlur && input.blurKey !== `${prefix}${mediaId}-thumb-blur.jpg`) {
    throw new AppError('Invalid blur storage key.', 400);
  }
  if ((!generateHls && input.outputDirKey !== undefined) ||
      (!generateThumbnail && input.thumbnailKey !== undefined) ||
      (!generateBlur && input.blurKey !== undefined)) {
    throw new AppError('Unexpected output storage key.', 400);
  }
}
