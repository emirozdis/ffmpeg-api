const assert = require('node:assert/strict');
const test = require('node:test');
const { webhookPayloadMatchesJob } = require('../dist/utils/webhook-payload');

test('accepts clip and photo response webhook payloads bound to the job', () => {
  const jobId = '6953a5a4-45e1-44dc-9557-d4c937d7a9eb';

  assert.equal(webhookPayloadMatchesJob(JSON.stringify({ clipId: jobId }), jobId), true);
  assert.equal(webhookPayloadMatchesJob(JSON.stringify({ photoResponseId: jobId }), jobId), true);
  assert.equal(webhookPayloadMatchesJob(JSON.stringify({ clipId: jobId, photoResponseId: jobId }), jobId), true);
});

test('rejects missing, malformed, or mismatched webhook entity IDs', () => {
  const jobId = '6953a5a4-45e1-44dc-9557-d4c937d7a9eb';

  assert.equal(webhookPayloadMatchesJob('{}', jobId), false);
  assert.equal(webhookPayloadMatchesJob('{', jobId), false);
  assert.equal(webhookPayloadMatchesJob(JSON.stringify({ clipId: 'different' }), jobId), false);
  assert.equal(webhookPayloadMatchesJob(JSON.stringify({ clipId: jobId, photoResponseId: 'different' }), jobId), false);
});
