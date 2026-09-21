import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth, type ResolvedAuth } from "./auth.ts";
import { titleFromUrl } from "./results.ts";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

/**
 * Ollama Cloud exposes search/fetch as standalone REST endpoints rather than
 * model tools, so this module talks to the API directly:
 *   POST {root}/api/web_search and POST {root}/api/web_fetch
 * Both require an Ollama API key (OLLAMA_API_KEY or /login ollama-cloud).
 * A local Ollama daemon is out of scope — it proxies these endpoints through
 * its own `ollama signin` session under /api/experimental/*, which the
 * official @ollama/pi-web-search package already covers.
 */

const MAX_RESULTS = 10;
const FETCH_CONTENT_LIMIT = 8000;

interface OllamaSearchResult {
    title?: string;
    url?: string;
    content?: string;
}

interface OllamaFetchResult {
    title?: string;
    content?: string;
    links?: string[];
}

/** Strip the OpenAI-compatible suffix so `/api/*` endpoints resolve. */
export function resolveOllamaApiRoot(model: Model<Api>, auth?: ResolvedAuth): string {
    const base = ((auth?.ok && auth.baseUrl) || model.baseUrl || "").replace(/\/+$/, "");
    return base.replace(/\/v\d+$/i, "");
}

async function ollamaPost<T>(
    root: string,
    path: string,
    body: unknown,
    apiKey: string,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(`${root}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 401) {
            throw new Error("Ollama API key missing or invalid — set OLLAMA_API_KEY or run /login ollama-cloud.");
        }
        throw new Error(`Ollama API error (${response.status}): ${text || response.statusText}`);
    }
    return (await response.json()) as T;
}

function truncateContent(text: string | undefined, limit = FETCH_CONTENT_LIMIT): string {
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

interface FetchedPage {
    url: string;
    title?: string;
    content?: string;
    ok: boolean;
    status?: string;
}

async function fetchPages(
    root: string,
    urls: string[],
    apiKey: string,
    signal?: AbortSignal,
): Promise<FetchedPage[]> {
    return Promise.all(
        urls.map(async (url): Promise<FetchedPage> => {
            try {
                const data = await ollamaPost<OllamaFetchResult>(root, "/api/web_fetch", { url }, apiKey, signal);
                return { url, title: data.title, content: data.content, ok: true };
            } catch (error) {
                return {
                    url,
                    ok: false,
                    status: error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
}

/** URL metadata in the same shape Gemini's url_context produces downstream. */
function toUrlContextMetadata(pages: FetchedPage[]) {
    return {
        urlMetadata: pages.map((page) => ({
            retrievedUrl: page.url,
            urlRetrievalStatus: page.ok ? "URL_RETRIEVAL_STATUS_SUCCESS" : "URL_RETRIEVAL_STATUS_ERROR",
        })),
    };
}

async function resolveOllamaTarget(
    ctx: ExtensionContext,
    model: Model<Api>,
): Promise<{ root: string; apiKey: string }> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) throw new Error(auth.error || "Failed to resolve Ollama credentials");
    const apiKey = auth.apiKey || process.env.OLLAMA_API_KEY;
    if (!apiKey) {
        throw new Error(
            "Ollama web search needs an API key — set OLLAMA_API_KEY or run /login ollama-cloud.",
        );
    }
    return { root: resolveOllamaApiRoot(model, auth), apiKey };
}

export async function callOllamaSearch(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    urls?: string[],
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const { root, apiKey } = await resolveOllamaTarget(ctx, model);

    onUpdate?.({
        content: [{ type: "text", text: `Searching the web with Ollama...` }],
        details: { streaming: true, searching: true },
    });

    const data = await ollamaPost<{ results?: OllamaSearchResult[] }>(
        root,
        "/api/web_search",
        { query, max_results: MAX_RESULTS },
        apiKey,
        signal,
    );
    const hits = (data.results ?? []).filter((r) => r && typeof r.url === "string");

    const searchResults: SearchResultDetail[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url,
        citedText: hit.content,
        source: "ollama.web_search",
        type: "search_result",
        query,
        raw: hit,
    }));
    const sources: Source[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url!,
    }));

    const lines = [`Search results for "${query}" via Ollama:`];
    if (hits.length === 0) lines.push("No results found.");
    hits.forEach((hit, i) => {
        lines.push(`\n${i + 1}. ${hit.title || hit.url}\n   ${hit.url}${hit.content ? `\n   ${hit.content}` : ""}`);
    });

    // Optional URL analysis through web_fetch (the fetch half of the API pair).
    let urlContextMetadata;
    if (urls?.length) {
        onUpdate?.({
            content: [{ type: "text", text: `Fetching ${urls.length} URL(s) with Ollama...` }],
            details: { streaming: true },
        });
        const pages = await fetchPages(root, urls, apiKey, signal);
        urlContextMetadata = toUrlContextMetadata(pages);
        for (const page of pages) {
            if (!page.ok) continue;
            lines.push(
                `\n## Fetched: ${page.title || page.url}\n${page.url}\n\n${truncateContent(page.content)}`,
            );
            if (!sources.some((s) => s.url === page.url)) {
                sources.push({ title: page.title || titleFromUrl(page.url), url: page.url });
            }
        }
    }

    return {
        text: lines.join("\n"),
        sources,
        providerKind: "ollama",
        nativeSearchUsed: true,
        searchQueries: [query],
        searchResults,
        urlContextMetadata,
    };
}

/** url_context for Ollama: fetch each URL through web_fetch, no model involved. */
export async function callOllamaUrlContext(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    urls: string[],
    signal?: AbortSignal,
): Promise<StreamResult> {
    const { root, apiKey } = await resolveOllamaTarget(ctx, model);
    const pages = await fetchPages(root, urls, apiKey, signal);

    const lines = [`URL contents for: ${query}`];
    const sources: Source[] = [];
    const searchResults: SearchResultDetail[] = [];
    for (const page of pages) {
        if (!page.ok) {
            lines.push(`\n## Failed: ${page.url}\n${page.status}`);
            continue;
        }
        lines.push(`\n## ${page.title || page.url}\n${page.url}\n\n${truncateContent(page.content)}`);
        sources.push({ title: page.title || titleFromUrl(page.url), url: page.url });
        searchResults.push({
            title: page.title,
            url: page.url,
            citedText: truncateContent(page.content),
            source: "ollama.web_fetch",
            type: "fetched_page",
            raw: page,
        });
    }

    return {
        text: lines.join("\n"),
        sources,
        providerKind: "ollama",
        nativeSearchUsed: false,
        searchResults,
        urlContextMetadata: toUrlContextMetadata(pages),
    };
}
