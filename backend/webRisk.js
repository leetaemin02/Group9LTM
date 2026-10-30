'use strict';

const crypto = require('crypto');
const { extractUrls } = require('./linkSafety');

const WEB_RISK_ENDPOINT = 'https://webrisk.googleapis.com/v1/uris:search';
const THREAT_TYPES = Object.freeze([
  'SOCIAL_ENGINEERING',
  'MALWARE',
  'UNWANTED_SOFTWARE',
  'SOCIAL_ENGINEERING_EXTENDED_COVERAGE',
]);
const MAX_URLS_PER_MESSAGE = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const REQUEST_TIMEOUT_MS = 3000;

function createWebRiskChecker({
  apiKey = process.env.GOOGLE_WEB_RISK_API_KEY,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();

  async function lookup(url) {
    const cacheKey = crypto.createHash('sha256').update(url).digest('hex');
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.threatTypes;
    if (cached) cache.delete(cacheKey);

    const endpoint = new URL(WEB_RISK_ENDPOINT);
    endpoint.searchParams.set('uri', url);
    endpoint.searchParams.set('key', apiKey);
    for (const threatType of THREAT_TYPES) {
      endpoint.searchParams.append('threatTypes', threatType);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(endpoint, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Web Risk returned HTTP ${response.status}.`);
    }

    const result = await response.json();
    const threat = result.threat;
    const threatTypes = threat && Array.isArray(threat.threatTypes)
      ? threat.threatTypes
      : [];
    const cacheExpiry = threat && threat.expireTime
      ? Math.min(now() + CACHE_TTL_MS, Date.parse(threat.expireTime))
      : now() + CACHE_TTL_MS;
    if (Number.isFinite(cacheExpiry) && cacheExpiry > now()) {
      cache.set(cacheKey, { threatTypes, expiresAt: cacheExpiry });
    }
    if (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
    return threatTypes;
  }

  return async function checkMessageLinks(text) {
    const urls = extractUrls(text);
    if (urls.length === 0) {
      return { status: 'not_applicable', checkedCount: 0, threatTypes: [] };
    }
    if (!apiKey) {
      return { status: 'disabled', checkedCount: 0, threatTypes: [] };
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('This Node.js runtime does not provide fetch().');
    }

    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length > MAX_URLS_PER_MESSAGE) {
      return {
        status: 'limit_exceeded',
        checkedCount: 0,
        threatTypes: [],
        complete: false,
      };
    }

    const urlsToCheck = uniqueUrls.slice(0, MAX_URLS_PER_MESSAGE);
    const results = await Promise.allSettled(urlsToCheck.map(lookup));
    const threatTypes = new Set();
    let failedLookups = 0;

    for (const result of results) {
      if (result.status === 'rejected') {
        failedLookups++;
        console.error('[WebRisk] URL reputation lookup failed:', result.reason.message);
      } else {
        for (const threatType of result.value) threatTypes.add(threatType);
      }
    }

    if (threatTypes.size > 0) {
      return {
        status: 'threat',
        checkedCount: urlsToCheck.length,
        threatTypes: [...threatTypes],
        complete: uniqueUrls.length <= MAX_URLS_PER_MESSAGE && failedLookups === 0,
      };
    }
    if (failedLookups > 0) {
      return {
        status: 'unavailable',
        checkedCount: urlsToCheck.length - failedLookups,
        threatTypes: [],
        complete: false,
      };
    }
    return {
      status: 'clean',
      checkedCount: urlsToCheck.length,
      threatTypes: [],
      complete: true,
    };
  };
}

const checkMessageLinks = createWebRiskChecker();

module.exports = { checkMessageLinks, createWebRiskChecker };
