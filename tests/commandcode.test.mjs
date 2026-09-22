import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearch } from '../src/web_search.ts';
import { urlContext } from '../src/url_context.ts';
import {
  COMMAND_CODE_CLI_VERSION,
  clampNumResults,
  commandCodeUrlFetch,
  commandCodeWebSearch,
  extractCommandCodeError,
  isCommandCodeModel,
  resolveCommandCodeApiBase,
} from '../src/providers/commandcode.ts';
import { getProviderKind } from '../src/providers/config.ts';
import { resolveWebSearchModel } from '../src/utils.ts';
import { createMockCtx as mockCtx, withWebSearchConfig } from './helpers.mjs';

/** A Command Code model shaped like the one pi-commandcode-provider registers. */
function commandCodeModel(overrides = {}) {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    provider: 'commandcode',
    api: 'commandcode-custom',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    headers: {},
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Command Code models are classified as the commandcode provider kind', () => {
  assert.equal(getProviderKind(commandCodeModel()), 'commandcode');
  assert.equal(isCommandCodeModel(commandCodeModel()), true);
  // 官方 @commandcode/pi-commandcode-provider 注册的 provider id 是 `command-code`，
  // 旧版 patlux/pi-commandcode-provider 用的是 `commandcode`，两者都要识别。
  assert.equal(getProviderKind(commandCodeModel({ provider: 'command-code', api: 'openai-completions' })), 'commandcode');
  assert.equal(isCommandCodeModel({ provider: 'command-code', api: 'openai-completions' }), true);
  assert.equal(isCommandCodeModel({ provider: 'anthropic', api: 'anthropic-messages' }), false);
});

test('resolveCommandCodeApiBase strips the provider path and keeps the origin', () => {
  assert.equal(resolveCommandCodeApiBase('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai');
  assert.equal(resolveCommandCodeApiBase('https://api.commandcode.ai/provider/v1/'), 'https://api.commandcode.ai');
  // Anthropic-family models get the trailing /v1 removed, so only /provider remains.
  assert.equal(resolveCommandCodeApiBase('https://api.commandcode.ai/provider'), 'https://api.commandcode.ai');
  assert.equal(resolveCommandCodeApiBase('https://staging.example.test'), 'https://staging.example.test');
  assert.equal(resolveCommandCodeApiBase(undefined), undefined);
  assert.equal(resolveCommandCodeApiBase(''), undefined);
  assert.equal(resolveCommandCodeApiBase('not a url'), undefined);
  assert.equal(resolveCommandCodeApiBase('ftp://api.commandcode.ai/provider/v1'), undefined);
});

test('clampNumResults applies Command Code bounds and the CLI default', () => {
  assert.equal(clampNumResults(undefined), 5);
  assert.equal(clampNumResults(1), 1);
  assert.equal(clampNumResults(10), 10);
  assert.equal(clampNumResults(0), 1);
  assert.equal(clampNumResults(99), 10);
  assert.equal(clampNumResults(3.6), 4);
  assert.equal(clampNumResults(Number.NaN), 5);
});

test('extractCommandCodeError reads both string and structured error shapes', () => {
  assert.equal(extractCommandCodeError({ error: 'boom' }), 'boom');
  assert.equal(
    extractCommandCodeError({ error: { code: 'BAD_REQUEST', message: 'query must not be empty' } }),
    'BAD_REQUEST — query must not be empty',
  );
  assert.equal(extractCommandCodeError({ error: { message: 'only message' } }), 'only message');
  assert.equal(extractCommandCodeError({}), undefined);
  assert.equal(extractCommandCodeError(null), undefined);
});

test('web_search on a Command Code model posts to /alpha/web-search and renders snippets', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({
      query: 'pi coding agent',
      results: [
        { title: 'Pi', url: 'https://pi.dev/', snippet: 'A coding agent.' },
        { title: 'Pi packages', url: 'https://pi.dev/packages', snippet: 'Browse packages.' },
      ],
    });
  });

  const result = await commandCodeWebSearch(
    mockCtx('cc-key', commandCodeModel()),
    commandCodeModel(),
    'pi coding agent',
    { numResults: 2 },
  );

  assert.equal(request.url, 'https://api.commandcode.ai/alpha/web-search');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer cc-key');
  assert.match(request.init.headers['x-command-code-version'], /^\d+\.\d+\.\d+$/);
  // Pinned to pi-commandcode-provider's COMMAND_CODE_CLI_VERSION so the two clients
  // sharing one /alpha/* API key cannot drift apart silently.
  assert.equal(request.init.headers['x-command-code-version'], COMMAND_CODE_CLI_VERSION);
  assert.equal(request.init.headers['x-cli-environment'], 'production');
  assert.deepEqual(request.body, { query: 'pi coding agent', numResults: 2 });

  assert.equal(result.providerKind, 'commandcode');
  assert.equal(result.nativeSearchUsed, true);
  assert.equal(result.searchResults.length, 2);
  assert.deepEqual(result.searchQueries, ['pi coding agent']);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://pi.dev/', 'https://pi.dev/packages']);
  assert.match(result.text, /Search results for "pi coding agent":/);
  assert.match(result.text, /1\. Pi\n {3}https:\/\/pi\.dev\/\n {3}A coding agent\./);
});

test('web_search clamps numResults and passes domain filters through', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ results: [] });
  });

  await commandCodeWebSearch(
    mockCtx('cc-key', commandCodeModel()),
    commandCodeModel(),
    'typescript 6',
    { numResults: 99, allowedDomains: ['typescriptlang.org'], blockedDomains: ['example.com'] },
  );

  assert.deepEqual(body, {
    query: 'typescript 6',
    numResults: 10,
    allowedDomains: ['typescriptlang.org'],
    blockedDomains: ['example.com'],
  });
});

test('web_search drops result entries without a usable URL and dedupes repeats', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    results: [
      { title: 'Kept', url: 'https://kept.example/page', snippet: 'first' },
      { title: 'No URL', snippet: 'ignored' },
      { title: 'Duplicate', url: 'https://kept.example/page' },
      null,
    ],
  }));

  const result = await commandCodeWebSearch(
    mockCtx('cc-key', commandCodeModel()),
    commandCodeModel(),
    'anything',
  );

  assert.equal(result.searchResults.length, 1);
  assert.equal(result.searchResults[0].url, 'https://kept.example/page');
  assert.match(result.text, /1\. Kept/);
  assert.doesNotMatch(result.text, /No URL|Duplicate/);
});

test('web_search reports an empty result set when the server returns none', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ results: [] }));

  const result = await commandCodeWebSearch(
    mockCtx('cc-key', commandCodeModel()),
    commandCodeModel(),
    'nothing matches this',
  );

  assert.equal(result.searchResults.length, 0);
  assert.deepEqual(result.sources, []);
  assert.match(result.text, /No search results were returned/);
});

test('web_search surfaces Command Code error payloads verbatim', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    success: false,
    error: { code: 'BAD_REQUEST', message: 'Invalid request: query must not be empty' },
  }, 400));

  await assert.rejects(
    () => commandCodeWebSearch(mockCtx('cc-key', commandCodeModel()), commandCodeModel(), 'x'),
    /Command Code web search failed \(HTTP 400\): BAD_REQUEST — Invalid request: query must not be empty/,
  );
});

test('web_search rejects a blank query before issuing a request', async (t) => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; return jsonResponse({ results: [] }); });

  await assert.rejects(
    () => commandCodeWebSearch(mockCtx('cc-key', commandCodeModel()), commandCodeModel(), '   '),
    /requires a non-empty query/,
  );
  assert.equal(called, false);
});

test('web_search gets the key from the model base URL when the credential store is empty', async (t) => {
  let headers;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    headers = init.headers;
    return jsonResponse({ results: [] });
  });

  const model = commandCodeModel({ baseUrl: 'https://inline-key@api.commandcode.ai/provider/v1' });
  await commandCodeWebSearch(
    mockCtx('', model, undefined, undefined, { models: [model] }),
    model,
    'query',
  );

  assert.equal(headers.Authorization, 'Bearer inline-key');
});

test('web_search explains how to configure a key when none is resolvable', async () => {
  const model = commandCodeModel();
  const ctx = { model, modelRegistry: { async getApiKeyAndHeaders() { return { ok: true }; }, getAvailable() { return [model]; }, find() { return undefined; } } };

  await assert.rejects(
    () => commandCodeWebSearch(ctx, model, 'query'),
    /has no API key/,
  );
});

test('url_context on a Command Code model fetches each URL and reports per-URL status', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    requested.push({ url, body });
    if (body.url === 'https://broken.example/') {
      return jsonResponse({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Request timed out fetching the URL.' } }, 504);
    }
    return jsonResponse({ content: `# ${body.url}\n\nBody text.`, url: body.url, status: 200 });
  });

  const result = await commandCodeUrlFetch(
    mockCtx('cc-key', commandCodeModel()),
    commandCodeModel(),
    ['https://ok.example/', 'https://broken.example/'],
  );

  assert.deepEqual(requested.map((entry) => entry.url), [
    'https://api.commandcode.ai/alpha/web-fetch',
    'https://api.commandcode.ai/alpha/web-fetch',
  ]);
  assert.deepEqual(requested.map((entry) => entry.body), [
    { url: 'https://ok.example/', format: 'markdown' },
    { url: 'https://broken.example/', format: 'markdown' },
  ]);

  assert.deepEqual(
    result.urlContextMetadata.urlMetadata,
    [
      { retrievedUrl: 'https://ok.example/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
      { retrievedUrl: 'https://broken.example/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' },
    ],
  );
  assert.match(result.text, /Fetched 1\/2 URL\(s\) with Command Code:/);
  assert.match(result.text, /Failed to fetch: Command Code web fetch \(https:\/\/broken\.example\/\) failed \(HTTP 504\)/);
});

test('url_context treats a status-0 fetch as a failure, not as page content', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.url === 'https://unreachable.example/') {
      return jsonResponse({
        content: 'Failed to fetch content from https://unreachable.example/. The page may be inaccessible, protected, or temporarily unavailable.',
        url: body.url,
        status: 0,
      });
    }
    return jsonResponse({ content: 'Real body.', url: body.url, status: 200 });
  });

  const model = commandCodeModel();
  const result = await commandCodeUrlFetch(
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
    model,
    ['https://unreachable.example/', 'https://ok.example/'],
  );

  assert.deepEqual(
    result.urlContextMetadata.urlMetadata,
    [
      { retrievedUrl: 'https://unreachable.example/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' },
      { retrievedUrl: 'https://ok.example/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
    ],
  );
  assert.match(result.text, /Failed to fetch: Failed to fetch content from https:\/\/unreachable\.example\//);
  assert.doesNotMatch(result.content?.[0]?.text ?? '', /inaccessible/);
});

test('url_context keeps real content served with a non-2xx status', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ content: '**404.** That’s an error.', url: body.url, status: 404 });
  });

  const model = commandCodeModel();
  const result = await commandCodeUrlFetch(
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
    model,
    ['https://site.example/missing'],
  );

  assert.deepEqual(
    result.urlContextMetadata.urlMetadata,
    [{ retrievedUrl: 'https://site.example/missing', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }],
  );
  assert.match(result.text, /That’s an error\./);
});

test('url_context on a Command Code model renders statuses through the shared formatter', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ content: `# ${body.url}`, url: body.url, status: 200 });
  });

  const model = commandCodeModel();
  const result = await urlContext(
    'tool-1',
    { query: 'Summarize', urls: ['https://example.com/'] },
    new AbortController().signal,
    undefined,
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
  );

  assert.equal(result.details.providerKind, 'commandcode');
  assert.equal(result.details.grounded, true);
  assert.deepEqual(result.details.retrieved, ['https://example.com/']);
  assert.match(result.content[0].text, /## Sources/);
});

test('web_search falls back to a Command Code model when the current model has no native search', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
    headers: {},
  };
  const fallback = commandCodeModel();
  const ctx = mockCtx('cc-key', currentModel, undefined, undefined, { models: [currentModel, fallback] });

  await withWebSearchConfig(null, async () => {
    assert.equal(await resolveWebSearchModel(ctx), fallback);
  });
});

test('an explicit web-search.json pin still wins over the Command Code fallback', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
    headers: {},
  };
  const pinned = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };
  const ctx = mockCtx('test-key', currentModel, undefined, undefined, { models: [currentModel, pinned, commandCodeModel()] });

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test' }, async () => {
    assert.equal(await resolveWebSearchModel(ctx), pinned);
  });
});

test('an unsupported explicit pin is not silently replaced by the Command Code fallback', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
    headers: {},
  };
  const ctx = mockCtx('test-key', currentModel, undefined, undefined, { models: [currentModel, commandCodeModel()] });

  await withWebSearchConfig({ provider: 'local-provider', model: 'local-test' }, async () => {
    assert.equal(await resolveWebSearchModel(ctx), undefined);
  });
});

test('a Command Code model is still preferred over the fallback when it is the current model', async (t) => {
  const model = commandCodeModel();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ results: [{ title: 'R', url: 'https://r.example/' }] }));

  const result = await webSearch(
    'tool-1',
    { query: 'query' },
    new AbortController().signal,
    undefined,
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
  );

  assert.equal(result.details.error, undefined);
  assert.equal(result.details.providerKind, 'commandcode');
  assert.equal(result.details.model, model.id);
});

test('web_search threads numResults through the registered tool', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ results: [] });
  });

  const model = commandCodeModel();
  await webSearch(
    'tool-1',
    { query: 'query', numResults: 3 },
    new AbortController().signal,
    undefined,
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
  );

  assert.equal(body.numResults, 3);
});

test('web_search with urls on a Command Code model searches and fetches in one call', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/alpha/web-search')) {
      return jsonResponse({ results: [{ title: 'Hit', url: 'https://hit.example/', snippet: 'snippet' }] });
    }
    return jsonResponse({ content: 'Fetched body.', url: body.url, status: 200 });
  });

  const model = commandCodeModel();
  const result = await webSearch(
    'tool-1',
    { query: 'query', urls: ['https://extra.example/'] },
    new AbortController().signal,
    undefined,
    mockCtx('cc-key', model, undefined, undefined, { models: [model] }),
  );

  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.commandcode.ai/alpha/web-search',
    'https://api.commandcode.ai/alpha/web-fetch',
  ]);
  assert.equal(result.details.error, undefined);
  assert.match(result.content[0].text, /Search results for "query":/);
  assert.match(result.content[0].text, /Fetched body\./);
  assert.deepEqual(result.details.sources.map((source) => source.url), [
    'https://hit.example/',
    'https://extra.example/',
  ]);
  assert.deepEqual(result.details.retrieved, ['https://extra.example/']);
});
