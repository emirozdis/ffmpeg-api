const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRemoteStoragePaths } = require('../dist/utils/remote-storage-paths');

const groupId = 'bd31c05f-506c-460e-9dde-0b3629238f95';
const assignmentId = '2f523722-16dd-49e7-88bf-cfb6194a782f';
const jobId = '70ad37f9-d771-4739-9a7a-5a66466271a9';

test('accepts snippet-response sources inside the responses namespace', () => {
  assert.doesNotThrow(() => validateRemoteStoragePaths({
    jobId,
    sourceKey: `vlogs/${groupId}/${assignmentId}/responses/7b103ad9-d8c6-4f54-980e-b21c41f8bb39.mp4`,
    outputDirKey: `vlogs/${groupId}/${assignmentId}/responses/${jobId}_hls`,
    thumbnailKey: `vlogs/${groupId}/${assignmentId}/responses/7b103ad9-d8c6-4f54-980e-b21c41f8bb39-thumb.jpg`,
    blurKey: `vlogs/${groupId}/${assignmentId}/responses/7b103ad9-d8c6-4f54-980e-b21c41f8bb39-thumb-blur.jpg`,
    options: { generateHls: true, generateThumbnail: true, generateBlur: true },
  }));
});

test('rejects snippet-response thumbnails outside the source namespace', () => {
  assert.throws(() => validateRemoteStoragePaths({
    jobId,
    sourceKey: `vlogs/${groupId}/${assignmentId}/responses/7b103ad9-d8c6-4f54-980e-b21c41f8bb39.mp4`,
    outputDirKey: `vlogs/${groupId}/${assignmentId}/responses/${jobId}_hls`,
    thumbnailKey: `vlogs/${groupId}/${assignmentId}/responses/${jobId}-thumb.jpg`,
    blurKey: `vlogs/${groupId}/${assignmentId}/responses/${jobId}-thumb-blur.jpg`,
    options: { generateHls: true, generateThumbnail: true, generateBlur: true },
  }), /Invalid thumbnail storage key/);
});

test('rejects response sources outside the responses namespace', () => {
  assert.throws(() => validateRemoteStoragePaths({
    jobId,
    sourceKey: `vlogs/${groupId}/${assignmentId}/other/7b103ad9-d8c6-4f54-980e-b21c41f8bb39.mp4`,
    outputDirKey: `vlogs/${groupId}/${assignmentId}/other/${jobId}_hls`,
    thumbnailKey: undefined,
    blurKey: undefined,
    options: { generateHls: true },
  }), /outside the vlog namespace/);
});
