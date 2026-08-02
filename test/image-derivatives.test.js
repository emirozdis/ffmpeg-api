const assert = require('node:assert/strict');
const test = require('node:test');

const { buildImageDerivativePlan } = require('../dist/services/transcode.service.js');

test('generates thumbnail and blur from one decoded video frame', () => {
  const args = buildImageDerivativePlan({
    inputPath: '/tmp/input.mp4',
    thumbnailPath: '/tmp/thumb.jpg',
    blurPath: '/tmp/blur.jpg',
    thumbnailTime: 0.5,
    flipHorizontally: true,
  });

  assert.equal(args.filter((value) => value === '-i').length, 1);
  assert.equal(args.filter((value) => value === '/tmp/input.mp4').length, 1);
  assert.match(args[args.indexOf('-filter_complex') + 1], /hflip,split=2/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /scale=80:142/);
  assert.equal(args.includes('/tmp/thumb.jpg'), true);
  assert.equal(args.includes('/tmp/blur.jpg'), true);
});

test('generates a blur image without requiring a thumbnail output', () => {
  const args = buildImageDerivativePlan({
    inputPath: '/tmp/input.mp4',
    blurPath: '/tmp/blur.jpg',
    thumbnailTime: 1,
    flipHorizontally: false,
  });

  assert.equal(args.includes('-filter_complex'), false);
  assert.equal(args[args.indexOf('-vf') + 1], 'scale=80:142');
  assert.equal(args.includes('/tmp/blur.jpg'), true);
});
