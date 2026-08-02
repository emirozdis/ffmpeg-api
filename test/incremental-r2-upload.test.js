const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for incremental upload');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('uploads completed HLS segments during encoding and manifests only at finish', async () => {
  process.env.R2_UPLOAD_POLL_MS = '50';
  const sdk = require('@aws-sdk/client-s3');
  const originalSend = sdk.S3Client.prototype.send;
  const uploadedKeys = [];
  sdk.S3Client.prototype.send = async function send(command) {
    if (command.input.Body && command.input.Body[Symbol.asyncIterator]) {
      for await (const _chunk of command.input.Body) {
        // Consume the stream like the SDK transport would.
      }
    }
    uploadedKeys.push(command.input.Key);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {};
  };

  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myturn-r2-'));
  const streamDir = path.join(testDir, 'stream_0');
  await fs.promises.mkdir(streamDir);
  await fs.promises.writeFile(path.join(streamDir, 'data000.ts'), 'segment-0');
  await fs.promises.writeFile(path.join(streamDir, 'data001.ts.tmp'), 'segment-1');
  await fs.promises.writeFile(path.join(streamDir, 'playlist.m3u8'), '#EXTM3U');

  try {
    const { startIncrementalDirectoryUpload } = require('../dist/services/r2.service.js');
    const uploader = startIncrementalDirectoryUpload('bucket', 'jobs/123', testDir, 2);

    await waitFor(() => uploadedKeys.includes('jobs/123/stream_0/data000.ts'));
    assert.equal(uploadedKeys.some((key) => key.endsWith('.m3u8')), false);
    assert.equal(uploadedKeys.some((key) => key.endsWith('.tmp')), false);

    await fs.promises.rename(
      path.join(streamDir, 'data001.ts.tmp'),
      path.join(streamDir, 'data001.ts'),
    );
    await waitFor(() => uploadedKeys.includes('jobs/123/stream_0/data001.ts'));
    assert.equal(uploadedKeys.some((key) => key.endsWith('.m3u8')), false);

    await uploader.finish();
    assert.equal(uploadedKeys.includes('jobs/123/stream_0/playlist.m3u8'), true);
    assert.equal(
      uploadedKeys.indexOf('jobs/123/stream_0/playlist.m3u8') >
        uploadedKeys.indexOf('jobs/123/stream_0/data001.ts'),
      true,
    );
    assert.equal(new Set(uploadedKeys).size, uploadedKeys.length);
  } finally {
    sdk.S3Client.prototype.send = originalSend;
    await fs.promises.rm(testDir, { recursive: true, force: true });
  }
});
