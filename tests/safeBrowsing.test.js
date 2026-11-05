'use strict';

const assert = require('node:assert/strict');
const { createSafeBrowsingChecker } = require('../backend/safeBrowsing');

async function main() {
  const disabledChecker = createSafeBrowsingChecker({
    apiKey: '',
    fetchImpl: () => assert.fail('Safe Browsing must not be called without an API key'),
  });
  assert.equal((await disabledChecker('https://example.com')).status, 'disabled');

  let fetchCount = 0;
  let requestUrl;
  let requestBody;
  const cleanChecker = createSafeBrowsingChecker({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      fetchCount++;
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal((await cleanChecker('See https://example.com')).status, 'clean');
  assert.equal((await cleanChecker('Again https://example.com')).status, 'clean');
  assert.equal(fetchCount, 1, 'Clean URL results should be cached');
  assert.equal(requestUrl.searchParams.get('key'), 'test-key');
  assert.deepEqual(requestBody.threatInfo.threatEntries, [{ url: 'https://example.com' }]);
  assert.ok(requestBody.threatInfo.threatTypes.includes('SOCIAL_ENGINEERING'));

  const threatChecker = createSafeBrowsingChecker({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        matches: [{
          threatType: 'SOCIAL_ENGINEERING',
          threat: { url: 'https://phishing.example/' },
        }],
      }),
    }),
  });
  const threat = await threatChecker('Visit https://phishing.example/');
  assert.equal(threat.status, 'threat');
  assert.deepEqual(threat.threatTypes, ['SOCIAL_ENGINEERING']);

  const overLimitText = Array.from(
    { length: 6 },
    (_, index) => `https://site${index}.example`,
  ).join(' ');
  const limitedChecker = createSafeBrowsingChecker({
    apiKey: 'test-key',
    fetchImpl: () => assert.fail('Over-limit messages must not call Safe Browsing'),
  });
  assert.equal((await limitedChecker(overLimitText)).status, 'limit_exceeded');

  const forbiddenChecker = createSafeBrowsingChecker({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'API key not authorized.' } }),
    }),
  });
  const originalConsoleError = console.error;
  let loggedError = '';
  console.error = (...args) => { loggedError = args.join(' '); };
  try {
    assert.equal((await forbiddenChecker('https://example.net')).status, 'unavailable');
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(loggedError, /HTTP 403: API key not authorized/u);

  process.stdout.write('Safe Browsing tests passed.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
