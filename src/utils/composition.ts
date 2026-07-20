import { RecordingComposition } from '../types';
import { AppError } from './AppError';

const MAX_SEGMENTS = 64;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_SOURCE_DURATION_MS = 125_000;

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateComposition(value: unknown): RecordingComposition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('Invalid recording composition.', 400);
  }

  const composition = value as RecordingComposition;
  if (composition.version !== 1 ||
      !isSafePositiveInteger(composition.totalBytes) || composition.totalBytes > MAX_TOTAL_BYTES ||
      !isSafePositiveInteger(composition.totalSourceDurationMs) || composition.totalSourceDurationMs > MAX_SOURCE_DURATION_MS ||
      !Array.isArray(composition.segments) || composition.segments.length < 1 || composition.segments.length > MAX_SEGMENTS) {
    throw new AppError('Invalid recording composition.', 400);
  }

  let expectedOffset = 0;
  let durationTotal = 0;
  for (const segment of composition.segments) {
    if (!segment || typeof segment !== 'object' ||
        !Number.isSafeInteger(segment.offset) || segment.offset !== expectedOffset ||
        !isSafePositiveInteger(segment.length) ||
        !isSafePositiveInteger(segment.durationMs) ||
        ![1, 2].includes(segment.speed) ||
        !['user', 'environment'].includes(segment.facingMode)) {
      throw new AppError('Invalid recording composition segment.', 400);
    }
    expectedOffset += segment.length;
    durationTotal += segment.durationMs;
  }

  if (expectedOffset !== composition.totalBytes || durationTotal !== composition.totalSourceDurationMs) {
    throw new AppError('Recording composition totals do not match.', 400);
  }

  return {
    version: 1,
    totalBytes: composition.totalBytes,
    totalSourceDurationMs: composition.totalSourceDurationMs,
    segments: composition.segments.map((segment) => ({ ...segment })),
  };
}
