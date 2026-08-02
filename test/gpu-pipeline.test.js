const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHlsTranscodePlan } = require('../dist/services/transcode.service.js');

test('builds a GPU-resident NVDEC, CUDA scale, and NVENC HLS plan', () => {
  const plan = buildHlsTranscodePlan({
    hasAudio: true,
    videoEncoder: 'h264_nvenc',
    nvencPreset: 'p1',
    nvencTune: 'hq',
    cudaDevice: 0,
  });

  assert.equal(plan.pipeline, 'cuda');
  assert.deepEqual(plan.inputOptions, [
    '-hwaccel', 'cuda',
    '-hwaccel_device', '0',
    '-hwaccel_output_format', 'cuda',
    '-extra_hw_frames', '16',
  ]);
  assert.equal((plan.filterComplex.match(/scale_cuda=/g) || []).length, 3);
  assert.match(plan.filterComplex, /h=1920/);
  assert.match(plan.filterComplex, /h=1280/);
  assert.match(plan.filterComplex, /h=854/);
  assert.equal(plan.outputOptions.filter((value) => value === 'h264_nvenc').length, 3);
  assert.equal(plan.outputOptions.filter((value) => value === 'disabled').length, 3);
  assert.equal(plan.outputOptions.filter((value) => value === '0:a').length, 3);
});

test('keeps the software plan available outside the GPU image', () => {
  const plan = buildHlsTranscodePlan({
    hasAudio: false,
    videoEncoder: 'libx264',
    nvencPreset: 'p1',
    nvencTune: 'hq',
    cudaDevice: 0,
  });

  assert.equal(plan.pipeline, 'software');
  assert.deepEqual(plan.inputOptions, []);
  assert.equal((plan.filterComplex.match(/scale=/g) || []).length, 3);
  assert.doesNotMatch(plan.filterComplex, /scale_cuda/);
  assert.equal(plan.outputOptions.filter((value) => value === 'libx264').length, 3);
  assert.equal(plan.outputOptions.includes('0:a'), false);
});
