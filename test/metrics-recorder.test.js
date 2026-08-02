const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MetricsRecorder } = require('../dist/services/metrics-recorder.js');

test('records recursive output directory size', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoder-metrics-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputDir = path.join(workDir, 'output');
  fs.mkdirSync(path.join(outputDir, 'stream_0'), { recursive: true });
  fs.writeFileSync(inputPath, Buffer.alloc(100));
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), Buffer.alloc(20));
  fs.writeFileSync(path.join(outputDir, 'stream_0', 'data000.ts'), Buffer.alloc(80));

  try {
    const recorder = new MetricsRecorder();
    recorder.record('job-12345678', 'input.mp4', inputPath, outputDir, 10_000, 1_000, 'COMPLETED');
    const [job] = recorder.getMetrics().recentJobs;
    assert.equal(job.inputFileSizeBytes, 100);
    assert.equal(job.outputDirectorySizeBytes, 100);
    assert.equal(job.sizeRatio, 1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
