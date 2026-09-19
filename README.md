# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, xAI Grok, OpenAI Responses variants, Anthropic, OpenCode Zen/Go, and Command Code.

## Tools

### `web_search`

Search the web using your currently selected model. Automatically picks the right provider API:

| Provider | API |
|---|---|
| Google Gemini | Grounding with Google Search |
| xAI Grok | Responses API `web_search` |
| OpenAI | Responses API web search |
| Azure OpenAI | Responses API web search (`azure-openai-responses`) |
| OpenAI Codex | Codex Responses API web search (`openai-codex-responses`) |
| GitHub Copilot | OpenAI Responses API web search via Copilot credentials |
| Anthropic | Messages API web search |
| OpenCode Zen / Go | Responses API web search (models that use the `openai-responses` API) |
| Command Code | `POST {apiBase}/alpha/web-search` |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

OpenCode Zen and OpenCode Go Responses models (for example `opencode-go/gpt-5.6-luna` or `opencode-go/grok-4.6`) use the same Responses web search. OpenCode routes traffic per conversation, so `web_search` sends the `x-opencode-session` and `x-opencode-client` headers pi uses, keyed to the active session. Only models exposed through that Responses API are supported: OpenCode `chat/completions` models have no provider-native search tool, and the gateway's Anthropic Messages models are unverified.

Supports passing up to 20 additional URLs to analyze alongside the query. Successful `web_search` results are collapsed by default in pi; expand the tool call to inspect the full answer and source details.

### Command Code

`commandcode` models have no provider-native search tool, so `pi-web-search` calls the endpoint the Command Code CLI itself uses: `POST {apiBase}/alpha/web-search` with `{ query, numResults, allowedDomains?, blockedDomains? }`.

The request reuses the credentials `pi-commandcode-provider` already resolved — the `/login` OAuth credential, `--api-key`, the provider's `apiKey` in `models.json`, a key inlined in the model `baseUrl`, or `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY`. No second key and no extra provider are needed. `numResults` is clamped to Command Code's 1–10 range (default 5); other providers ignore that parameter and decide their own result count.

Unlike the native backends, this endpoint returns only result entries (`title`, `url`, `snippet`) with no model-written answer, so `web_search` hands those entries to the calling model to synthesize. The tool's `numResults` parameter maps directly onto it.

When a Command Code model is current, `web_search` can also serve the conversation from a Command Code model that is merely *configured*, not selected: this backend is an `apiBase`-level request rather than a billed chat completion, so falling back to it cannot cause a surprise model charge. An explicit `web-search.json` pin still takes priority, and an unsupported pin is still reported as an error rather than silently replaced.

### `url_context`

Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos.

| Provider | Backend |
|---|---|
| Google Gemini | Native URL Context retrieval with verified metadata |
| Command Code | `POST {apiBase}/alpha/web-fetch` per URL |

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding.

On Command Code, each URL is fetched independently (markdown by default) and its body is truncated to a share of the tool's output budget. Fetch results are raw page content, not an answer to `query` — the calling model reads them. Per-URL success and failure are reported through the same status table the Gemini backend uses; Command Code signals a total retrieval failure as HTTP 200 with `status: 0`, which is reported as a failed URL rather than as content.

## Install

```bash
pi install npm:pi-web-search
```

## Usage

No extra config needed. Select a supported current model in pi and the tools auto-detect the matching provider API.

`web_search` will not scan configured models and pick one automatically when the current model does not support native search. To use a dedicated search model, opt in explicitly with `web-search.json` in pi's agent directory (by default `~/.pi/agent/`; respects `PI_CODING_AGENT_DIR`):

```json
{
  "provider": "openai",
  "model": "gpt-5.1"
}
```

When this file exists, `web_search` uses the configured provider/model first. If it is missing, `web_search` uses the current conversation model. If the selected model does not support native search, the tool returns an error instead of falling back — except onto the Command Code backend described above, which carries no chat-completion cost.

For OpenAI Responses models (including Azure, Codex, and Copilot), `web_search` inherits the agent's current thinking level on each call. Enabled levels are clamped to the selected search model's supported levels and translated through its `thinkingLevelMap` using pi's model metadata. This also applies when `web-search.json` selects a dedicated search model. Higher effort can increase latency and cost.

When thinking is off or unavailable, or the search model is non-reasoning, the request omits `reasoning` and leaves the choice to the provider. Off does not force reasoning off: some models reject `reasoning.effort: "none"`. Google, Anthropic, and xAI behavior is unchanged.

`url_context` is automatically removed from active tools unless the current model is Gemini or Command Code.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT
