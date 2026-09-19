import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelScopedToolManager } from '../src/index.ts';
import { urlContext } from '../src/url_context.ts';
import { webSearch } from '../src/web_search.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

test('url_context rejects non-Gemini providers with a clear error', async () => {
  const model = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };

  const result = await urlContext(
    'tool-1',
    { query: 'Summarize this URL', urls: ['https://example.com'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', model),
  );

  assert.match(result.content[0].text, /requires a provider with URL retrieval/i);
  assert.equal(result.details.error, 'unsupported_provider');
  assert.equal(result.details.providerKind, 'openai');
  assert.equal(result.details.grounded, false);
});

test('url_context warns when Gemini returns no verified URL context metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { candidates: [{ content: { parts: [{ text: 'Plain summary without metadata' }] } }] } },
  ]));

  const model = {
    id: 'gemini-test',
    provider: 'proxy-provider',
    api: 'google-generative-ai',
    baseUrl: 'https://example.test/gemini/v1beta',
    headers: {},
  };

  const result = await urlContext(
    'tool-2',
    { query: 'Summarize this URL', urls: ['https://example.com'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', model),
  );

  assert.match(result.content[0].text, /No verified URL context metadata/i);
  assert.equal(result.details.providerKind, 'google');
  assert.equal(result.details.grounded, false);
  assert.deepEqual(result.details.sources, []);
});

test('web_search does not add visible verification warning when native metadata is absent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Ungrounded answer without metadata.' } } },
  ]));

  const model = {
    id: 'claude-test',
    provider: 'proxy-provider',
    api: 'anthropic-messages',
    baseUrl: 'https://example.test/anthropic',
    maxTokens: 4096,
    headers: {},
  };

  const result = await webSearch(
    'tool-3',
    { query: 'Search something' },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', model),
  );

  assert.doesNotMatch(result.content[0].text, /Search Verification/i);
  assert.doesNotMatch(result.content[0].text, /No verified native search metadata/i);
  assert.equal(result.details.providerKind, 'anthropic');
  assert.equal(result.details.nativeSearchUsed, false);
  assert.equal(result.details.grounded, false);
});

test('model-scoped tool manager removes url_context for non-Gemini and restores it for Gemini', async () => {
  let activeTools = ['read', 'web_search', 'url_context'];
  const changes = [];
  const manager = createModelScopedToolManager({
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames) {
      activeTools = [...toolNames];
      changes.push([...toolNames]);
    },
  });

  manager.sync({ id: 'gpt-test', provider: 'proxy-provider', api: 'openai-responses' });
  assert.deepEqual(activeTools, ['read', 'web_search']);

  manager.sync({ id: 'gemini-test', provider: 'proxy-provider', api: 'google-generative-ai' });
  assert.deepEqual(activeTools, ['read', 'web_search', 'url_context']);
  assert.equal(changes.length >= 2, true);
});
