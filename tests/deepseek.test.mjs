import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream, getProviderKind } from '../src/api.ts';
import { resolveDeepSeekBaseUrl } from '../src/providers/anthropic.ts';
import { webSearch } from '../src/web_search.ts';
import { getWebSearchModel } from '../src/utils.ts';
import { createMockCtx, withWebSearchConfig } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

const model = {
  id: 'deepseek-v4-flash', provider: 'deepseek', api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com', maxTokens: 8192, headers: {},
};
const body = { contents: [{ parts: [{ text: 'Search DeepSeek docs' }] }] };
const answer = () => makeResponse([
  { data: { type: 'content_block_start', content_block: { type: 'server_tool_use', id: 'search_1', name: 'web_search', input: { query: 'DeepSeek docs' } } } },
  { data: { type: 'content_block_start', content_block: { type: 'web_search_tool_result', tool_use_id: 'search_1', content: [{ type: 'web_search_result', title: 'DeepSeek docs', url: 'https://api-docs.deepseek.com/', page_age: '2026-05-26' }] } } },
  { data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'DeepSeek supports search.' } } },
  { data: { type: 'content_block_delta', delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'DeepSeek', title: 'DeepSeek docs', url: 'https://api-docs.deepseek.com/' } } } },
]);

test('DeepSeek detection is provider-specific and supports both API dialects', () => {
  assert.equal(getProviderKind(model), 'deepseek');
  assert.equal(getProviderKind({ ...model, api: 'anthropic-messages' }), 'deepseek');
  assert.equal(getProviderKind({ ...model, provider: 'other' }), 'unsupported');
});

test('DeepSeek routes standard and proxy base URLs without duplicating paths', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/anthropic', '/anthropic/v1/']) {
    const actual = resolveDeepSeekBaseUrl(`https://proxy.test/deepseek${suffix}`);
    assert.ok(['https://proxy.test/deepseek/anthropic', 'https://proxy.test/deepseek/anthropic/v1'].includes(actual));
  }
});

test('DeepSeek search sends native tool and exposes streaming results and citations', async (t) => {
  const controller = new AbortController();
  const updates = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const request = JSON.parse(init.body);
    assert.equal(request.model, model.id);
    assert.equal(request.stream, true);
    assert.deepEqual(request.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10, allowed_callers: ['direct'] }]);
    assert.equal(request.messages[0].content, 'Search DeepSeek docs');
    assert.equal(request.system, undefined);
    assert.equal(init.signal, controller.signal);
    assert.equal(init.signal.aborted, false);
    return answer();
  });
  const result = await callApiStream(createMockCtx('test-key'), model,
    body,
    (update) => updates.push(update), controller.signal);
  assert.equal(result.providerKind, 'deepseek');
  assert.equal(result.nativeSearchUsed, true);
  assert.equal(result.nativeSearchCalls[0].provider, 'deepseek');
  assert.equal(result.nativeSearchCalls[0].status, 'completed');
  assert.deepEqual(result.searchQueries, ['DeepSeek docs']);
  assert.equal(result.searchResults[0].pageAge, '2026-05-26');
  assert.match(result.text, /DeepSeek\[1\]/);
  assert.equal(result.sources[0].url, 'https://api-docs.deepseek.com/');
  assert.ok(result.nativeSearchEvents.every((event) => event.startsWith('deepseek.')));
  assert.ok(updates.some((update) => update.details.searching));
});

test('explicit DeepSeek model works with another conversation model and formats sources', async (t) => {
  const current = { ...model, id: 'local', provider: 'local' };
  const ctx = createMockCtx('key', current, undefined, undefined, { models: [current, model] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.model, model.id);
    assert.match(request.messages[0].content, /https:\/\/deepseek.com/);
    return answer();
  });
  await withWebSearchConfig({ provider: 'deepseek', model: model.id }, async () => {
    assert.equal(await getWebSearchModel(ctx), model);
    const result = await webSearch('test', { query: 'Search docs', urls: ['https://deepseek.com'] }, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.providerKind, 'deepseek');
    assert.match(result.content[0].text, /https:\/\/api-docs.deepseek.com/);
  });
});

test('DeepSeek env credentials and registry endpoint overrides are respected', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'env-key';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://proxy.test/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], 'env-key');
    return answer();
  });
  await callApiStream(createMockCtx(undefined, model, undefined, 'https://proxy.test/v1'), model, body);
});

test('DeepSeek preserves explicit auth headers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer header-key');
    return answer();
  });
  await callApiStream(createMockCtx(undefined, model, { Authorization: 'Bearer header-key' }), model, body);
});

test('DeepSeek rejects missing credentials before fetching', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; });
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('must not fetch'));
  await assert.rejects(callApiStream(createMockCtx(undefined), model, body), /No DeepSeek API key/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('DeepSeek propagates HTTP, stream, and search tool errors', async (t) => {
  const responses = [
    new Response('invalid API key', { status: 401 }),
    makeResponse([{ data: { type: 'error', error: { message: 'stream failed' } } }]),
    makeResponse([{ data: { type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } } }]),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (const pattern of [/DeepSeek API error \(401\)/, /stream failed/, /DeepSeek web search failed: max_uses_exceeded/]) {
    await assert.rejects(callApiStream(createMockCtx(), model, body), pattern);
  }
});

test('DeepSeek request cancellation reaches fetch', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    controller.abort();
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
  });
  await assert.rejects(callApiStream(createMockCtx(), model, body, undefined, controller.signal), { name: 'AbortError' });
});
