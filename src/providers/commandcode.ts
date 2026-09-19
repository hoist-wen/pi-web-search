/**
 * Command Code 的网络搜索与网页抓取后端。
 *
 * Command Code CLI 自带 `web_search` 工具，对应端点
 * `POST {apiBase}/alpha/web-search`；另有 `POST {apiBase}/alpha/web-fetch`
 * 用于读取单个 URL。两者都复用 Command Code provider 的同一把 API key
 * （`pi-commandcode-provider` 的凭据链：env → pi 凭据 → `~/.commandcode/auth.json`），
 * 因此使用 Command Code 模型时无需第二个 provider、也无需额外密钥。
 *
 * 参考 dsh 的 `dsh-commandcode-provider` web-search provider 实现，这里把它的
 * 做法适配到 pi 的 `StreamResult` 形状，好让 `format.ts` 用与其它后端一致的方式渲染。
 */

import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth } from "./auth.ts";
import { mergeStreamResults, pushNativeSearchEvent, pushUniqueSearchResult, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, StreamResult } from "./types.ts";

/** pi 中 Command Code provider 注册使用的 provider id。 */
export const COMMAND_CODE_PROVIDER = "commandcode";

/** Command Code 未显式配置 baseUrl 时的默认 API 根地址。 */
export const DEFAULT_COMMAND_CODE_API_BASE = "https://api.commandcode.ai";

/**
 * Command Code 的 `/alpha/*` 端点要求请求头带上 CLI 版本号与运行环境。
 * 服务端目前不校验具体版本（探测中 1.56.0 与空值均返回 200），这里取一个
 * 已知可用的 CLI 版本，并与 `pi-commandcode-provider` 的目录快照保持接近。
 */
export const COMMAND_CODE_CLI_VERSION = "1.58.0";

const SEARCH_ROUTE = "/alpha/web-search";
const FETCH_ROUTE = "/alpha/web-fetch";

/** Command Code `numResults` 的取值区间（与 CLI 的 web_search schema 一致）。 */
export const MIN_NUM_RESULTS = 1;
export const MAX_NUM_RESULTS = 10;
/** 调用方未指定结果条数时使用的默认值（同 CLI）。 */
export const DEFAULT_NUM_RESULTS = 5;

/** 抓取网页时的默认输出格式。 */
export type CommandCodeFetchFormat = "markdown" | "text" | "html";

/** 当前模型是否由 Command Code 承载。 */
export function isCommandCodeModel(model: Model<Api> | undefined): boolean {
    return model?.provider === COMMAND_CODE_PROVIDER;
}

/**
 * 由模型 baseUrl 推导 `/alpha/*` 端点的 API 根地址。
 *
 * provider 注册时 baseUrl 形如 `https://api.commandcode.ai/provider/v1`；Anthropic
 * 系模型还会再去掉末尾 `/v1`，变成 `https://api.commandcode.ai/provider`。而搜索
 * 端点挂在站点根上，因此这里统一剥掉 `/provider/v1` 或 `/provider` 以及尾部斜杠。
 * OAuth 登录时 pi 不提供 baseUrl，此时由调用方回退到
 * {@link DEFAULT_COMMAND_CODE_API_BASE}。
 */
export function resolveCommandCodeApiBase(baseUrl: string | undefined): string | undefined {
    const raw = (baseUrl ?? "").trim();
    if (raw === "") return undefined;
    const stripped = raw.replace(/\/+$/, "").replace(/\/provider(\/v1)?$/i, "");
    try {
        const parsed = new URL(stripped);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        return stripped;
    } catch {
        return undefined;
    }
}

/** 把结果条数夹到 Command Code 允许的 1–10 区间，未指定时用 5。 */
export function clampNumResults(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return DEFAULT_NUM_RESULTS;
    return Math.max(MIN_NUM_RESULTS, Math.min(MAX_NUM_RESULTS, Math.round(value)));
}

/**
 * baseUrl 里内联的凭据（`https://key@host/provider/v1`）。
 *
 * pi 允许把密钥写在 models.json 的 baseUrl 用户信息段里；这种 provider 的
 * `getApiKeyAndHeaders()` 只会返回剥离后的 baseUrl，所以搜索需要自己把它取回来。
 */
function credentialFromBaseUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) return undefined;
    try {
        const parsed = new URL(baseUrl);
        if (!parsed.username && !parsed.password) return undefined;
        return decodeURIComponent(parsed.username || parsed.password) || undefined;
    } catch {
        return undefined;
    }
}

/**
 * 解析 Command Code API key。
 *
 * 依次尝试 pi 的凭据解析（OAuth 登录、`--api-key`、models.json 的 apiKey）、
 * baseUrl 内联凭据，最后是环境变量。pi 的 `getEnvApiKey()` 没有 Command Code
 * 的映射表，所以环境变量只能在这里补。
 */
export async function resolveCommandCodeApiKey(
    ctx: ExtensionContext,
    model: Model<Api>,
): Promise<string | undefined> {
    const auth = await getAuth(ctx, model);
    if (auth.ok && auth.apiKey) return auth.apiKey;

    const inline = credentialFromBaseUrl(model.baseUrl);
    if (inline) return inline;

    return process.env.COMMAND_CODE_API_KEY || process.env.COMMANDCODE_API_KEY || undefined;
}

const MISSING_KEY_MESSAGE =
    "Command Code web search has no API key. Run /login for the Command Code provider, set COMMAND_CODE_API_KEY (or COMMANDCODE_API_KEY), or set the provider's apiKey in models.json.";

function requestHeaders(apiKey: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-command-code-version": COMMAND_CODE_CLI_VERSION,
        "x-cli-environment": "production",
        "User-Agent": "cli",
    };
}

/** 从 `{ success: false, error: { code, message } }` 里取出可读的错误说明。 */
export function extractCommandCodeError(payload: any): string | undefined {
    const error = payload?.error;
    if (typeof error === "string") return error || undefined;
    if (!error || typeof error !== "object") return undefined;
    const code = typeof error.code === "string" ? error.code : undefined;
    const message = typeof error.message === "string" ? error.message : undefined;
    if (code && message) return `${code} — ${message}`;
    return message ?? code;
}

/** 读取失败响应体，拼出带服务端说明的错误信息。 */
async function commandCodeFailureMessage(response: Response, what: string): Promise<string> {
    let message = `${what} failed (HTTP ${response.status})`;
    const text = (await response.text().catch(() => "")).trim();
    if (text !== "") {
        try {
            const detail = extractCommandCodeError(JSON.parse(text));
            message += `: ${detail ?? text.slice(0, 200)}`;
        } catch {
            message += `: ${text.slice(0, 200)}`;
        }
    }
    return message;
}

async function commandCodePost(
    ctx: ExtensionContext,
    model: Model<Api>,
    route: string,
    body: unknown,
    what: string,
    signal?: AbortSignal,
): Promise<any> {
    const apiKey = await resolveCommandCodeApiKey(ctx, model);
    if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);

    const apiBase = resolveCommandCodeApiBase(model.baseUrl) ?? DEFAULT_COMMAND_CODE_API_BASE;

    let response: Response;
    try {
        response = await fetch(`${apiBase}${route}`, {
            method: "POST",
            headers: requestHeaders(apiKey),
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`${what} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) throw new Error(await commandCodeFailureMessage(response, what));

    try {
        return await response.json();
    } catch {
        throw new Error(`${what} returned an unparseable response body`);
    }
}

/** 一条服务端搜索结果，转成 pi 的 `SearchResultDetail`。 */
function toSearchResult(raw: any, query: string): { url: string; title: string; snippet?: string } | undefined {
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (url === "") return undefined;
    const title = typeof raw?.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : titleFromUrl(url);
    const snippet = typeof raw?.snippet === "string" && raw.snippet.trim() !== "" ? raw.snippet.trim() : undefined;
    return { url, title, snippet };
}

/** 把搜索结果渲染成给模型看的文本（Command Code 只返回条目，没有成文答案）。 */
export function formatCommandCodeResults(results: Array<{ url: string; title: string; snippet?: string }>, query: string): string {
    if (results.length === 0) {
        return `No search results were returned for "${query}".`;
    }
    const blocks = results.map((result, index) => {
        const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
        if (result.snippet) lines.push(`   ${result.snippet}`);
        return lines.join("\n");
    });
    return `Search results for "${query}":\n\n${blocks.join("\n\n")}`;
}

export interface CommandCodeSearchOptions {
    /** 期望的结果条数，会被夹到 1–10。 */
    numResults?: number;
    /** 只在这些域名内搜索（服务端支持）。 */
    allowedDomains?: string[];
    /** 排除这些域名（服务端支持）。 */
    blockedDomains?: string[];
}

/**
 * 通过 Command Code 的 `/alpha/web-search` 执行一次搜索。
 *
 * 与其它后端不同，这个端点只返回结果条目（title/url/snippet），没有模型生成的
 * 成文答案，因此 `text` 由这些条目拼装而成，交给调用方模型自己综合。
 */
export async function commandCodeWebSearch(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    options: CommandCodeSearchOptions = {},
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const trimmedQuery = query.trim();
    if (trimmedQuery === "") throw new Error("Command Code web search requires a non-empty query.");

    onUpdate?.({
        content: [{ type: "text", text: `Searching the web with Command Code for "${trimmedQuery}"...` }],
        details: { streaming: true, searching: true },
    });

    const payload = await commandCodePost(ctx, model, SEARCH_ROUTE, {
        query: trimmedQuery,
        numResults: clampNumResults(options.numResults),
        ...(options.allowedDomains?.length ? { allowedDomains: options.allowedDomains } : {}),
        ...(options.blockedDomains?.length ? { blockedDomains: options.blockedDomains } : {}),
    }, "Command Code web search", signal);

    const rawResults = payload?.results;
    if (!Array.isArray(rawResults)) {
        throw new Error("Command Code web search returned no results array (the server may have rejected the query)");
    }

    const results: Array<{ url: string; title: string; snippet?: string }> = [];
    const searchResults: SearchResultDetail[] = [];
    const seen = new Set<string>();
    for (const raw of rawResults) {
        const result = toSearchResult(raw, trimmedQuery);
        if (!result || seen.has(result.url)) continue;
        seen.add(result.url);
        results.push(result);
        pushUniqueSearchResult(searchResults, {
            title: result.title,
            url: result.url,
            query: trimmedQuery,
            source: "commandcode.web_search",
            type: "web_search_result",
            raw,
        });
    }

    const sanitized = sanitizeSearchResults(searchResults);
    const nativeSearchEvents: string[] = [];
    pushNativeSearchEvent(nativeSearchEvents, "commandcode.web_search");

    return {
        text: formatCommandCodeResults(results, trimmedQuery),
        sources: sanitized.map((item) => ({ title: item.title || titleFromUrl(item.url || ""), url: item.url || "" })),
        providerKind: COMMAND_CODE_PROVIDER,
        nativeSearchUsed: true,
        nativeSearchEvents,
        nativeSearchCalls: [{
            provider: COMMAND_CODE_PROVIDER,
            status: "completed",
            actionType: "web_search",
            queries: [trimmedQuery],
            urls: sanitized.map((item) => item.url || "").filter(Boolean),
        }],
        searchQueries: [trimmedQuery],
        searchResults: sanitized,
    };
}

/** `/alpha/web-fetch` 的单次抓取结果。 */
export interface CommandCodeFetchOutcome {
    url: string;
    /** 抓取成功时的正文；失败时为空。 */
    content?: string;
    /** 抓取失败原因；成功时为 undefined。 */
    error?: string;
}

/** 抓取单个 URL 的正文；失败时返回原因而不是抛错，便于逐个 URL 汇总。 */
export async function commandCodeFetchUrl(
    ctx: ExtensionContext,
    model: Model<Api>,
    url: string,
    format: CommandCodeFetchFormat = "markdown",
    signal?: AbortSignal,
): Promise<CommandCodeFetchOutcome> {
    try {
        const payload = await commandCodePost(ctx, model, FETCH_ROUTE, { url, format }, `Command Code web fetch (${url})`, signal);
        const content = typeof payload?.content === "string" ? payload.content : "";
        const status = typeof payload?.status === "number" ? payload.status : undefined;
        // The endpoint answers 200 with a generic apology and `status: 0` when the
        // page could not be retrieved at all (unreachable host, DNS failure), so
        // that is a failure rather than content. Non-zero statuses are kept: a 404
        // page still carries a real error page the model can read.
        if (status === 0) {
            return { url, error: content.trim() || "the page could not be retrieved" };
        }
        if (content.trim() === "") {
            return { url, error: `empty content (server reported status ${status ?? "unknown"})` };
        }
        return { url, content };
    } catch (error) {
        return { url, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * 通过 Command Code 的 `/alpha/web-fetch` 读取一批 URL。
 *
 * 返回的 `StreamResult` 复用 Gemini URL Context 的元数据形状
 * （`urlContextMetadata.urlMetadata`），这样 `format.ts` 里的
 * `extractUrlContextStatus()` 能原样渲染每个 URL 的成败。
 *
 * 抓取结果是原始正文，不是对 `query` 的回答：调用方模型需要自己从正文里找答案。
 */
export async function commandCodeUrlFetch(
    ctx: ExtensionContext,
    model: Model<Api>,
    urls: string[],
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const perUrlMaxBytes = Math.max(4096, Math.floor(DEFAULT_MAX_BYTES / urls.length));
    const perUrlMaxLines = Math.max(50, Math.floor(DEFAULT_MAX_LINES / urls.length));

    onUpdate?.({
        content: [{ type: "text", text: `Fetching ${urls.length} URL(s) with Command Code...` }],
        details: { streaming: true, searching: true },
    });

    // 逐个抓取，保持 URL 顺序，便于错误信息与结果一一对应。
    const outcomes: CommandCodeFetchOutcome[] = [];
    for (const url of urls) {
        outcomes.push(await commandCodeFetchUrl(ctx, model, url, "markdown", signal));
    }

    const urlMetadata: any[] = [];
    const sources: Array<{ title: string; url: string }> = [];
    const blocks: string[] = [];

    for (const outcome of outcomes) {
        if (outcome.error !== undefined) {
            urlMetadata.push({ retrievedUrl: outcome.url, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" });
            blocks.push(`## ${outcome.url}\n\nFailed to fetch: ${outcome.error}`);
            continue;
        }
        urlMetadata.push({ retrievedUrl: outcome.url, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" });
        sources.push({ title: titleFromUrl(outcome.url), url: outcome.url });
        const { content } = truncateHead(outcome.content ?? "", { maxLines: perUrlMaxLines, maxBytes: perUrlMaxBytes });
        blocks.push(`## ${outcome.url}\n\n${content}`);
    }

    const retrieved = outcomes.filter((outcome) => outcome.error === undefined).length;
    const header = retrieved === outcomes.length
        ? `Fetched ${outcomes.length} URL(s) with Command Code:`
        : `Fetched ${retrieved}/${outcomes.length} URL(s) with Command Code:`;

    return {
        text: `${header}\n\n${blocks.join("\n\n")}`,
        sources,
        providerKind: COMMAND_CODE_PROVIDER,
        nativeSearchUsed: false,
        urlContextMetadata: { urlMetadata },
    };
}

/**
 * Run a Command Code search and, in the same tool call, fetch every URL the
 * caller passed alongside the query.
 *
 * The native providers receive those URLs as part of the prompt, but Command
 * Code's `/alpha/web-search` has no notion of them, so the two backend calls are
 * merged into one `StreamResult` for the shared formatter.
 */
export async function commandCodeSearchAndFetch(
    ctx: ExtensionContext,
    model: Model<Api>,
    params: { query: string; urls?: string[]; numResults?: number },
    signal?: AbortSignal,
): Promise<StreamResult> {
    const search = await commandCodeWebSearch(ctx, model, params.query, { numResults: params.numResults }, undefined, signal);
    const fetched = await commandCodeUrlFetch(ctx, model, params.urls ?? [], undefined, signal);
    return mergeStreamResults(search, fetched);
}
