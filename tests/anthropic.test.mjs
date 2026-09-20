import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

test('Anthropic stream exposes server web search, result URLs, and citation details', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 10 });
    assert.equal(body.tool_choice, undefined);
    return makeResponse([
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'OpenAI docs' } } } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', page_age: null, encrypted_content: 'x' }] } } },
      { data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'OpenAI docs explain web search.' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'OpenAI docs', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', encrypted_index: 'abc' } } } },
    ]);
  });

  const result = await callApiStream(mockCtx(), {
    id: 'claude-test',
    provider: 'proxy-provider',
    api: 'anthropic-messages',
    baseUrl: 'https://example.test/anthropic',
    maxTokens: 4096,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

  assert.equal(result.providerKind, 'anthropic');
  assert.equal(result.nativeSearchUsed, true);
  assert.deepEqual(result.nativeSearchEvents, [
    'anthropic.content_block_start.server_tool_use.web_search',
    'anthropic.content_block_start.web_search_tool_result',
  ]);
  assert.deepEqual(result.searchQueries, ['OpenAI docs']);
  assert.equal(result.nativeSearchCalls[0].id, 'srv_1');
  assert.equal(result.searchResults.some((item) => item.url === 'https://platform.openai.com/docs/guides/tools-web-search'), true);
  assert.equal(result.citations.some((item) => item.citedText === 'OpenAI docs'), true);
  assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
});

test('Anthropic stream falls back to env API key when resolved auth has no credential', async (t) => {
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-fallback-key';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-api-key'], 'env-fallback-key');
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fallback auth accepted' } } },
    ]);
  });

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'claude-test',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with fallback auth' }] }] });

    assert.equal(result.text, 'Fallback auth accepted');
  } finally {
    if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
  }
});

test('Anthropic stream does not replace existing auth headers with env API key fallback', async (t) => {
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-fallback-key';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-api-key'], 'header-key');
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Header auth accepted' } } },
    ]);
  });

  try {
    const result = await callApiStream(mockCtx(undefined, undefined, { 'x-api-key': 'header-key' }), {
      id: 'claude-test',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with header auth' }] }] });

    assert.equal(result.text, 'Header auth accepted');
  } finally {
    if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
  }
});

test('Anthropic stream sends the Claude Code system prompt for OAuth credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer sk-ant-oat01-test');
    // Anthropic rejects OAuth requests from a claude-cli older than 2.1.251
    // ("Claude Code 2.1.75 does not support this model"), so the default UA
    // has to keep up with that floor.
    const [, cliVersion] = /^claude-cli\/(\d+\.\d+\.\d+)$/.exec(init.headers['user-agent']) ?? [];
    assert.ok(cliVersion, `expected a claude-cli user-agent, got ${init.headers['user-agent']}`);
    const [major, minor, patch] = cliVersion.split('.').map(Number);
    const floor = [2, 1, 251];
    const meetsFloor = major !== floor[0] ? major > floor[0] : minor !== floor[1] ? minor > floor[1] : patch >= floor[2];
    assert.ok(meetsFloor, `claude-cli/${cliVersion} is below the 2.1.251 floor`);
    assert.deepEqual(body.system, [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ]);
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OAuth accepted' } } },
    ]);
  });

  const result = await callApiStream(mockCtx('sk-ant-oat01-test'), {
    id: 'claude-test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://example.test/anthropic',
    maxTokens: 4096,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with OAuth auth' }] }] });

  assert.equal(result.text, 'OAuth accepted');
});

test('Anthropic stream omits the system prompt for API key credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.headers['x-api-key'], 'sk-ant-api03-test');
    assert.equal(body.system, undefined);
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'API key accepted' } } },
    ]);
  });

  const result = await callApiStream(mockCtx('sk-ant-api03-test'), {
    id: 'claude-test',
    provider: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://example.test/anthropic',
    maxTokens: 4096,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with API key auth' }] }] });

  assert.equal(result.text, 'API key accepted');
});
