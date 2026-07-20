const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-composition-'));
process.env.UPLOAD_DIR = path.join(testRoot, 'uploads');
process.env.PROCESSED_DIR = path.join(testRoot, 'processed');
process.env.STATE_DIR = path.join(testRoot, 'state');

const { composeRecordingSegments } = require('../dist/services/transcode.service.js');
const { validateComposition } = require('../dist/utils/composition.js');
const { validateStorageBucket } = require('../dist/utils/storage.js');

function run(command, args) {
  return childProcess.execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function createFixture(outputPath, color, frequency) {
  run('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=180x320:d=1:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=1`,
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath,
  ]);
}

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('validates contiguous segment byte ranges', () => {
  assert.throws(() => validateComposition({
    version: 1,
    totalBytes: 20,
    totalSourceDurationMs: 2_000,
    segments: [
      { offset: 0, length: 10, durationMs: 1_000, speed: 1, facingMode: 'user' },
      { offset: 11, length: 10, durationMs: 1_000, speed: 2, facingMode: 'environment' },
    ],
  }), /invalid recording composition segment/i);
});

test('accepts a validated bucket from the incoming request', () => {
  assert.equal(validateStorageBucket('myturn-dev'), 'myturn-dev');
  assert.equal(validateStorageBucket('media.vlogs-2026'), 'media.vlogs-2026');
  assert.throws(() => validateStorageBucket('../myturn-dev'), /invalid storage bucket/i);
  assert.throws(() => validateStorageBucket('MyTurn-Dev'), /invalid storage bucket/i);
});

test('extracts, speeds, and concatenates mixed recording segments', async (t) => {
  try {
    run('ffmpeg', ['-version']);
    run('ffprobe', ['-version']);
  } catch {
    t.skip('FFmpeg is not installed in this environment.');
    return;
  }

  const firstPath = path.join(testRoot, 'first.mp4');
  const secondPath = path.join(testRoot, 'second.mp4');
  createFixture(firstPath, 'red', 440);
  createFixture(secondPath, 'blue', 880);

  const first = fs.readFileSync(firstPath);
  const second = fs.readFileSync(secondPath);
  const bundlePath = path.join(testRoot, 'bundle.mp4');
  fs.writeFileSync(bundlePath, Buffer.concat([first, second]));

  const outputPath = await composeRecordingSegments(bundlePath, {
    version: 1,
    totalBytes: first.length + second.length,
    totalSourceDurationMs: 2_000,
    segments: [
      { offset: 0, length: first.length, durationMs: 1_000, speed: 1, facingMode: 'environment' },
      { offset: first.length, length: second.length, durationMs: 1_000, speed: 2, facingMode: 'user' },
    ],
  }, path.join(testRoot, 'composition'));

  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', outputPath,
  ]));
  const duration = Number(probe.format.duration);
  assert.ok(duration >= 1.4 && duration <= 1.7, `expected ~1.5s output, received ${duration}s`);
  assert.deepEqual(new Set(probe.streams.map((stream) => stream.codec_type)), new Set(['video', 'audio']));

  const firstPixel = childProcess.execFileSync('ffmpeg', [
    '-loglevel', 'error', '-ss', '0.25', '-i', outputPath,
    '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  const secondPixel = childProcess.execFileSync('ffmpeg', [
    '-loglevel', 'error', '-ss', '1.25', '-i', outputPath,
    '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  assert.ok(firstPixel[0] > firstPixel[2], 'first segment should be red');
  assert.ok(secondPixel[2] > secondPixel[0], 'second segment should be blue');
});
