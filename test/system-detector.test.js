const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyFfmpegEncoders } = require('../dist/services/system-detector.js');

test('classifies NVENC by codec without mixing HEVC or audio encoders', () => {
  const detected = classifyFfmpegEncoders(`
 V..... h264_vaapi           H.264 VAAPI
 V..... hevc_vaapi           H.265 VAAPI
 V..... h264_nvenc           NVIDIA NVENC H.264
 V..... hevc_nvenc           NVIDIA NVENC hevc
 A..... aac                  AAC
  `);

  assert.equal(detected.type, 'nvenc');
  assert.deepEqual(detected.h264Encoders, ['h264_vaapi', 'h264_nvenc']);
  assert.deepEqual(detected.hevcEncoders, ['hevc_vaapi', 'hevc_nvenc']);
  assert.deepEqual(detected.aacEncoders, ['aac']);
});
