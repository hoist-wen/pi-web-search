# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, xAI Grok, OpenAI Responses variants, Anthropic, Ollama Cloud, OpenCode Zen/Go, and Command Code.

> **Fork note:** this is [`hoist-wen/pi-web-search`](https://github.com/hoist-wen/pi-web-search), a fork of
> [`ttttmr/pi-web-search`](https://github.com/ttttmr/pi-web-search) that adds the
> [Command Code](#command-code) backend. Everything else is upstream code; updates are pulled
> in by merging `upstream/main`.

## Command Code

Use [`commandcode`](https://commandcode.ai) models (for example `deepseek/deepseek-v4.1-flash`) for
both tools out of the box — **no second API key and no extra provider are needed**:

| Tool | Backend |
|---|---|
| `web_search` | `POST {apiBase}/alpha/web-search` — the same endpoint the Command Code CLI uses |
| `url_context` | `POST {apiBase}/alpha/web-fetch`, one request per URL |

`commandcode` models have no provider-native search tool, so these calls go straight to the
endpoints the Command Code CLI itself uses. Both reuse the credentials
[`pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) already resolved: the
`/login` OAuth credential, `--api-key`, the provider's `apiKey` in `models.json`, a key inlined in
the model `baseUrl`, or `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY`. Because no provider-native
capability is required, web search works on every model the provider exposes.

Three things differ from the native backends:

- **No model-written answer.** `/alpha/web-search` returns result entries only (`title`, `url`,
  `snippet`); the calling model synthesizes the answer from them. The optional `numResults`
  parameter (1–10, default 5) maps directly onto this backend, and is ignored elsewhere.
- **Falling back is safe.** Because this is an `apiBase`-level request rather than a billed chat
  completion, `web_search` may serve a request from a Command Code model that is merely
  *configured*, not selected — something it refuses to do for chat models in order to avoid
  surprise charges. An explicit `web-search.json` pin still takes priority, and an unsupported pin
  is still reported as an error rather than silently replaced.
- **Fetch failures are explicit.** Command Code signals a total retrieval failure as HTTP 200 with
  `status: 0`, which is reported as a failed URL rather than as content.

For `url_context`, each URL is fetched independently (markdown by default) and its body is
truncated to a share of the tool's output budget. Fetch results are raw page content, not an answer
to `query` — the calling model reads them. Per-URL success and failure are reported through the same
status table the Gemini backend uses.

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
| Ollama Cloud | Ollama web search API (`/api/web_search`, standalone REST) |
| OpenCode Zen / Go | Responses API web search (models that use the `openai-responses` API) |
| Command Code | `POST {apiBase}/alpha/web-search` |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

OpenCode Zen and OpenCode Go Responses models (for example `opencode-go/gpt-5.6-luna` or `opencode-go/grok-4.6`) use the same Responses web search. OpenCode routes traffic per conversation, so `web_search` sends the `x-opencode-session` and `x-opencode-client` headers pi uses, keyed to the active session. Only models exposed through that Responses API are supported: OpenCode `chat/completions` models have no provider-native search tool, and the gateway's Anthropic Messages models are unverified.

Ollama Cloud models (provider `ollama-cloud` or any model hosted on `ollama.com`) call Ollama's standalone web search API rather than a model tool. Auth is `OLLAMA_API_KEY` or `/login ollama-cloud`. Any `urls` are fetched through `web_fetch`. A local Ollama daemon is out of scope — the official `@ollama/pi-web-search` package covers its `/api/experimental/*` endpoints.

Supports passing up to 20 additional URLs to analyze alongside the query. Successful `web_search` results are collapsed by default in pi; expand the tool call to inspect the full answer and source details.

### `url_context`

Gemini, Ollama Cloud, and Command Code. Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos. Gemini uses native URL Context retrieval with verified metadata; Ollama uses its `web_fetch` endpoint (web pages and documents only); Command Code fetches each URL through its own backend.

| Provider | Backend |
|---|---|
| Google Gemini | Native URL Context retrieval with verified metadata |
| Ollama Cloud | `POST {root}/api/web_fetch` per URL |
| Command Code | `POST {apiBase}/alpha/web-fetch` per URL |

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding. See [Command Code](#command-code) for the Command Code backend.

## Install

This fork:

```bash
pi install git:github.com/hoist-wen/pi-web-search
```

Upstream (without the Command Code backend):

```bash
pi install npm:pi-web-search
```

Install only one of them: both register a `web_search` tool, and duplicate tool names conflict.

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

When thinking is off or unavailable, or the search model is non-reasoning, the request omits `reasoning` and leaves the choice to the provider. Off does not force reasoning off: some models reject `reasoning.effort: "none"`. Google, Anthropic, xAI, and Ollama behavior is unchanged.

`url_context` is automatically removed from active tools unless the current model is Gemini, Ollama Cloud, or Command Code.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT
