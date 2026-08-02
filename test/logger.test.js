const assert = require('node:assert/strict');
const test = require('node:test');

const { Logger } = require('../dist/utils/logger.js');

test('plain console logs are newline-delimited for container log collectors', () => {
  const originalWrite = process.stdout.write;
  let output = '';

  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    const logger = new Logger({
      consoleLevel: 'info',
      fileLevel: 'fatal',
      colour: false,
    });
    logger.info('first message');
    logger.info('second message');
  } finally {
    process.stdout.write = originalWrite;
  }

  const lines = output.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /first message$/);
  assert.match(lines[1], /second message$/);
  assert.ok(output.endsWith('\n'));
});
