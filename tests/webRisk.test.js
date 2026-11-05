'use strict';

const assert = require('node:assert/strict');
const { createWebRiskChecker } = require('../backend/webRisk');

async function main() {
  const disabledChecker = createWebRiskChecker({ apiKey: '' });
  assert.deepEqual(await disabledChecker('https://example.com'), {
    status: 'disabled',
    checkedCount: 0,
    threatTypes: [],
  });

  let requestedUrl;
  const cleanChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.deepEqual(await cleanChecker('example.com'), {
    status: 'clean',
    checkedCount: 1,
    threatTypes: [],
    complete: true,
  });
  assert.equal(requestedUrl.searchParams.get('uri'), 'https://example.com');

  const threatChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        threat: {
          threatTypes: ['SOCIAL_ENGINEERING'],
        },
      }),
    }),
  });
  assert.equal((await threatChecker('https://unsafe.example')).status, 'threat');

  const unavailableChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal((await unavailableChecker('https://example.com')).status, 'unavailable');
  } finally {
    console.error = originalConsoleError;
  }

  let calls = 0;
  const limitedChecker = createWebRiskChecker({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal((await limitedChecker(
    'https://one.example https://two.example https://three.example https://four.example https://five.example https://six.example',
  )).status, 'limit_exceeded');
  assert.equal(calls, 0, 'Over-limit messages must not send partial URL checks');

  process.stdout.write('Web Risk tests passed.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
