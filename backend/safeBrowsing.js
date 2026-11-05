'use strict';

const crypto = require('crypto');
const { extractUrls } = require('./linkSafety');

const API_ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'];
const MAX_URLS_PER_MESSAGE = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const REQUEST_TIMEOUT_MS = 3000;

function createSafeBrowsingChecker({
  apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();

  return async function checkMessageLinks(text) {
    const urls = [...new Set(extractUrls(text))];
    if (urls.length === 0) {
      return { status: 'not_applicable', checkedCount: 0, threatTypes: [] };
    }
    if (!apiKey) {
      return { status: 'disabled', checkedCount: 0, threatTypes: [] };
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('This Node.js runtime does not provide fetch().');
    }
    if (urls.length > MAX_URLS_PER_MESSAGE) {
      return {
        status: 'limit_exceeded',
        checkedCount: 0,
        threatTypes: [],
        complete: false,
      };
    }

    const threatTypes = new Set();
    const urlsToCheck = [];
    for (const url of urls) {
      const key = crypto.createHash('sha256').update(url).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        for (const threatType of cached.threatTypes) threatTypes.add(threatType);
      } else {
        if (cached) cache.delete(key);
        urlsToCheck.push({ url, key });
      }
    }

    if (urlsToCheck.length > 0) {
      const endpoint = new URL(API_ENDPOINT);
      endpoint.searchParams.set('key', apiKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: {
              clientId: 'chatmatch',
              clientVersion: '1.0',
            },
            threatInfo: {
              threatTypes: THREAT_TYPES,
              platformTypes: ['ANY_PLATFORM'],
              threatEntryTypes: ['URL'],
              threatEntries: urlsToCheck.map(({ url }) => ({ url })),
            },
          }),
        });

        if (!response.ok) {
          let detail = '';
          try {
            const body = await response.json();
            detail = typeof body.error?.message === 'string' ? body.error.message : '';
          } catch {
            detail = '';
          }
          throw new Error(
            `Safe Browsing returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
          );
        }

        const result = await response.json();
        const matches = Array.isArray(result.matches) ? result.matches : [];
        for (const match of matches) {
          if (typeof match.threatType === 'string') threatTypes.add(match.threatType);
        }

        const threatUrls = new Map();
        for (const match of matches) {
          const matchedUrl = match.threat?.url;
          if (typeof matchedUrl !== 'string') continue;
          const matchedTypes = threatUrls.get(matchedUrl) || new Set();
          if (typeof match.threatType === 'string') matchedTypes.add(match.threatType);
          threatUrls.set(matchedUrl, matchedTypes);
        }

        for (const { url, key } of urlsToCheck) {
          const matchedTypes = threatUrls.get(url) || new Set();
          cache.set(key, { threatTypes: [...matchedTypes], expiresAt: now() + CACHE_TTL_MS });
        }
        while (cache.size > MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value);
        }
      } catch (error) {
        console.error('[SafeBrowsing] URL lookup failed:', error.message);
        return {
          status: 'unavailable',
          checkedCount: urls.length - urlsToCheck.length,
          threatTypes: [...threatTypes],
          complete: false,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      status: threatTypes.size > 0 ? 'threat' : 'clean',
      checkedCount: urls.length,
      threatTypes: [...threatTypes],
      complete: true,
    };
  };
}

const checkMessageLinks = createSafeBrowsingChecker();

module.exports = { checkMessageLinks, createSafeBrowsingChecker };
