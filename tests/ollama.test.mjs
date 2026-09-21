import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderKind } from '../src/providers/config.ts';
import { resolveOllamaApiRoot } from '../src/providers/ollama.ts';
import { urlContext } from '../src/url_context.ts';
import { webSearch } from '../src/web_search.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';

const CLOUD_MODEL = {
  id: 'gpt-oss:120b',
  provider: 'ollama-cloud',
  api: 'openai-completions',
  baseUrl: 'https://ollama.com/v1',
  headers: {},
};

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function searchPayload() {
  return {
    results: [
      { title: 'Pi coding agent', url: 'https://example.com/pi', content: 'An agent harness.' },
      { title: 'Docs', url: 'https://example.com/docs', content: 'Documentation.' },
    ],
  };
}

test('getProviderKind detects ollama by provider id, host, and daemon port', () => {
  assert.equal(getProviderKind(CLOUD_MODEL), 'ollama');
  assert.equal(getProviderKind({
    ...CLOUD_MODEL, provider: 'my-ollama', baseUrl: 'https://ollama.com/v1',
  }), 'ollama');
  assert.equal(getProviderKind({
    ...CLOUD_MODEL, provider: 'ollama', baseUrl: 'http://localhost:11434/v1',
  }), 'unsupported');
  assert.equal(getProviderKind({
    ...CLOUD_MODEL, provider: 'other', baseUrl: 'https://example.test/v1',
  }), 'unsupported');
});

test('resolveOllamaApiRoot strips the OpenAI-compatible suffix', () => {
  assert.equal(resolveOllamaApiRoot(CLOUD_MODEL), 'https://ollama.com');
});

test('web_search calls the cloud search endpoint and formats results', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(searchPayload());
  });

  const result = await webSearch(
    'tool-1',
    { query: 'pi agent' },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', CLOUD_MODEL),
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ollama.com/api/web_search');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), { query: 'pi agent', max_results: 10 });
  assert.equal(result.details.providerKind, 'ollama');
  assert.equal(result.details.grounded, true);
  assert.equal(result.details.sources.length, 2);
  assert.match(result.content[0].text, /Pi coding agent/);
});

test('web_search fetches supplied URLs through web_fetch', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    if (String(url).endsWith('/api/web_fetch')) {
      return jsonResponse({ title: 'Fetched page', content: 'Page body.', links: [] });
    }
    return jsonResponse(searchPayload());
  });

  const result = await webSearch(
    'tool-2',
    { query: 'pi agent', urls: ['https://example.com/a'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', CLOUD_MODEL),
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.url), [
    'https://ollama.com/api/web_search',
    'https://ollama.com/api/web_fetch',
  ]);
  assert.match(result.content[0].text, /Fetched: Fetched page/);
  assert.deepEqual(result.details.retrieved, ['https://example.com/a']);
  assert.ok(!result.details.failed || result.details.failed.length === 0);
});

test('web_search errors clearly when the cloud key is missing', async () => {
  const previous = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    const result = await webSearch(
      'tool-4',
      { query: 'pi agent' },
      new AbortController().signal,
      undefined,
      mockCtx(undefined, CLOUD_MODEL),
    );
    assert.match(result.content[0].text, /OLLAMA_API_KEY|\/login ollama/);
  } finally {
    if (previous !== undefined) process.env.OLLAMA_API_KEY = previous;
  }
});

test('url_context fetches each URL through web_fetch', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ title: `Page ${requests.length}`, content: 'Body.', links: [] });
  });

  const result = await urlContext(
    'tool-5',
    { query: 'Summarize', urls: ['https://example.com/a', 'https://example.com/b'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', CLOUD_MODEL),
  );

  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.url === 'https://ollama.com/api/web_fetch'));
  assert.equal(result.details.providerKind, 'ollama');
  assert.equal(result.details.sources.length, 2);
  assert.deepEqual(result.details.retrieved, ['https://example.com/a', 'https://example.com/b']);
});

test('url_context reports per-URL fetch failures', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n += 1;
    if (n === 1) return jsonResponse({ title: 'Page 1', content: 'Body.', links: [] });
    return new Response('not found', { status: 404 });
  });

  const result = await urlContext(
    'tool-6',
    { query: 'Summarize', urls: ['https://example.com/a', 'https://example.com/b'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', CLOUD_MODEL),
  );

  assert.equal(result.details.retrieved.length, 1);
  assert.equal(result.details.failed.length, 1);
});
