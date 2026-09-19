import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { callApiStream, getConfig } from "./api.ts";
import { formatWebSearchResult } from "./format.ts";
import { commandCodeSearchAndFetch, commandCodeWebSearch, MAX_NUM_RESULTS, MIN_NUM_RESULTS } from "./providers/commandcode.ts";import { errorResult, missingWebSearchConfigResult, resolveWebSearchModel } from "./utils.ts";

export const WebSearchSchema = Type.Object({
    query: Type.String({ description: "The search query or question to answer" }),
    urls: Type.Optional(Type.Array(Type.String(), { 
        description: "Additional URLs to analyze along with search (up to 20)",
        maxItems: 20
    })),
    numResults: Type.Optional(Type.Integer({
        description: `How many search results to request (${MIN_NUM_RESULTS}-${MAX_NUM_RESULTS}). Currently only honoured by the Command Code backend; other providers return whatever their native search decides.`,
        minimum: MIN_NUM_RESULTS,
        maximum: MAX_NUM_RESULTS
    })),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

export async function webSearch(
    id: string, 
    params: WebSearchInput, 
    signal: AbortSignal,
    onUpdate: AgentToolUpdateCallback | undefined, 
    ctx: ExtensionContext,
    thinkingLevel?: ModelThinkingLevel
) {
    const model = await resolveWebSearchModel(ctx);
    if (!model) return missingWebSearchConfigResult(ctx);

    const hasUrls = params.urls && params.urls.length > 0;
    const urlCount = hasUrls ? params.urls!.length : 0;
    
    onUpdate?.({ 
        content: [{ 
            type: "text", 
            text: hasUrls 
                ? `Searching and analyzing ${urlCount} URL(s)...` 
                : `Searching for "${params.query}"...`
        }], 
        details: {} 
    });

    try {
        const config = getConfig(model);
        
        // Build prompt: include URLs if provided
        const prompt = hasUrls
            ? `${params.query}\n\nAlso analyze these URLs:\n${params.urls!.join("\n")}`
            : params.query;

        // Command Code has no native search tool, so it never reaches the
        // streaming path: its backend hits /alpha/web-search directly and the
        // caller-supplied URLs would just be ignored there. When URLs are
        // present, go through the fetch backend instead, which searches and
        // reads the extra URLs in one call.
        if (config.kind === "commandcode") {
            const result = hasUrls
                ? await commandCodeSearchAndFetch(ctx, model, params, signal)
                : await commandCodeWebSearch(ctx, model, params.query, { numResults: params.numResults }, onUpdate, signal);
            return formatWebSearchResult(result, { modelId: model.id });
        }

        // Enable provider-native search tools. Google needs explicit Gemini tool names;
        // OpenAI/Anthropic are handled inside callApiStream based on the current model.
        const tools = config.kind === "google"
            ? (hasUrls
                ? [{ [config.searchTool!]: {} }, { [config.urlContextTool!]: {} }]
                : [{ [config.searchTool!]: {} }])
            : undefined;

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            ...(tools ? { tools } : {})
        }, onUpdate, signal, thinkingLevel);

        return formatWebSearchResult(result, { modelId: model.id });
    } catch (e: any) {
        return errorResult(e);
    }
}
