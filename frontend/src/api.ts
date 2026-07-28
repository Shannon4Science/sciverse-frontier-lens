import type {
  Capabilities,
  CitationList,
  EvidenceSearchResult,
  GraphPayload,
  ModelConfigStatus,
  ModelConfigUpdate,
  ModelTestResult,
  PaperCard,
  PaperOverview,
  PaperReadingSource,
  ParagraphPage,
  ProvenanceResult,
  ReadingGuide,
  SciverseConfigStatus,
  SciverseConfigUpdate,
  SciverseTestResult,
  TopicExploration,
  TopicProgressEvent,
} from "./types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return (await response.json()) as T;
}

async function throwResponseError(response: Response): Promise<never> {
  const requestId = response.headers.get("x-request-id");
  let detail = "";
  try {
    const payload = await response.json() as {
      detail?: unknown;
      error?: { message?: string };
    };
    detail = formatErrorDetail(payload.detail) || payload.error?.message || "";
  } catch {
    detail = "";
  }
  throw new Error(
    `${detail || `Request failed (${response.status})`}${requestId ? ` · ${requestId}` : ""}`,
  );
}

function formatErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const entry = item as { loc?: unknown[]; msg?: unknown };
        const field = Array.isArray(entry.loc)
          ? entry.loc.filter((part) => part !== "body").join(".")
          : "";
        const message = typeof entry.msg === "string" ? entry.msg : "配置无效";
        const normalized = formatErrorDetail(message);
        return field ? `${field}: ${normalized}` : normalized;
      })
      .filter(Boolean)
      .join("；");
  }
  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      return "配置无效";
    }
  }
  return "";
}

export function getCapabilities(): Promise<Capabilities> {
  return requestJson<Capabilities>("/api/capabilities");
}

export function getDiscoveryMap(): Promise<GraphPayload> {
  return requestJson<GraphPayload>("/api/discovery-map");
}

export function exploreTopic(
  query: string,
  responseLanguage: "zh" | "en",
  signal?: AbortSignal,
): Promise<TopicExploration> {
  return requestJson<TopicExploration>("/api/topic-explore", {
    method: "POST",
    signal,
    body: JSON.stringify({
      query,
      size: 20,
      seed_count: 5,
      related_per_seed: 5,
      entities_per_seed: 30,
      relations_per_seed: 60,
      signals: ["term", "entity", "citation"],
      response_language: responseLanguage,
    }),
  });
}

export async function exploreTopicStream(
  query: string,
  responseLanguage: "zh" | "en",
  onProgress: (event: TopicProgressEvent) => void,
  signal?: AbortSignal,
): Promise<TopicExploration> {
  const response = await fetch("/api/topic-explore/stream", {
    method: "POST",
    signal,
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      size: 20,
      seed_count: 5,
      related_per_seed: 5,
      entities_per_seed: 30,
      relations_per_seed: 60,
      signals: ["term", "entity", "citation"],
      response_language: responseLanguage,
    }),
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  if (!response.body) {
    throw new Error("The exploration progress stream is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TopicExploration | null = null;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), {
      stream: !chunk.done,
    });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as
        | TopicProgressEvent
        | { type: "result"; result: TopicExploration }
        | { type: "error"; step?: string; message: string };
      if (event.type === "progress") {
        onProgress(event);
      } else if (event.type === "result") {
        result = event.result;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
    if (chunk.done) break;
  }
  if (!result) {
    throw new Error("The exploration task ended without a result.");
  }
  return result;
}

export function buildTopicGraph(
  query: string,
  responseLanguage: "zh" | "en" = "en",
  signal?: AbortSignal,
): Promise<GraphPayload> {
  return exploreTopic(query, responseLanguage, signal).then((result) => result.graph);
}

export function buildTopicGuide(
  query: string,
  responseLanguage: "zh" | "en" = "en",
): Promise<ReadingGuide> {
  return requestJson<ReadingGuide>("/api/topic-guide", {
    method: "POST",
    body: JSON.stringify({
      query,
      size: 20,
      seed_count: 5,
      related_per_seed: 5,
      entities_per_seed: 30,
      relations_per_seed: 60,
      signals: ["term", "entity", "citation"],
      response_language: responseLanguage,
    }),
  });
}

export function getPaperGraph(
  schemaId: string,
  signal?: AbortSignal,
): Promise<GraphPayload> {
  return requestJson<GraphPayload>(
    `/api/papers/${encodeURIComponent(schemaId)}/graph`,
    { signal },
  );
}

export function getPaperDetail(
  schemaId: string,
  signal?: AbortSignal,
): Promise<PaperCard> {
  return requestJson<PaperCard>(
    `/api/papers/${encodeURIComponent(schemaId)}`,
    { signal },
  );
}

export function getPaperReadingSource(
  schemaId: string,
  signal?: AbortSignal,
): Promise<PaperReadingSource> {
  return requestJson<PaperReadingSource>(
    `/api/papers/${encodeURIComponent(schemaId)}/reading-source`,
    { signal },
  );
}

export function getPaperOverview(
  schemaId: string,
  responseLanguage: "zh" | "en",
  signal?: AbortSignal,
): Promise<PaperOverview> {
  const params = new URLSearchParams({
    response_language: responseLanguage,
  });
  return requestJson<PaperOverview>(
    `/api/papers/${encodeURIComponent(schemaId)}/overview?${params}`,
    { signal },
  );
}

export function getPaperParagraphs(
  schemaId: string,
  startMarker: number,
  signal?: AbortSignal,
): Promise<ParagraphPage> {
  const params = new URLSearchParams({
    start_marker: String(startMarker),
    size: "100",
  });
  return requestJson<ParagraphPage>(
    `/api/papers/${encodeURIComponent(schemaId)}/paragraphs?${params}`,
    { signal },
  );
}

export function getCitationGraph(schemaId: string): Promise<GraphPayload> {
  return requestJson<GraphPayload>(
    `/api/papers/${encodeURIComponent(schemaId)}/citation-graph`,
  );
}

export function getCitations(
  schemaId: string,
  signal?: AbortSignal,
): Promise<CitationList> {
  return requestJson<CitationList>(
    `/api/papers/${encodeURIComponent(schemaId)}/citations`,
    { signal },
  );
}

export function searchEvidence(
  schemaId: string,
  signal?: AbortSignal,
): Promise<EvidenceSearchResult> {
  return requestJson<EvidenceSearchResult>("/api/evidence/search", {
    method: "POST",
    signal,
    body: JSON.stringify({
      groups: [
        "resource",
        "formula",
        "citation_signal",
        "reference_semantics",
        "table_evidence",
        "comparison_detail",
      ].slice(0, 5),
      schema_ids: [schemaId],
      size: 20,
    }),
  });
}

export function getModelConfig(): Promise<ModelConfigStatus> {
  return requestJson<ModelConfigStatus>("/api/settings/model");
}

export function updateModelConfig(
  config: ModelConfigUpdate,
): Promise<ModelConfigStatus> {
  return requestJson<ModelConfigStatus>("/api/settings/model", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export function testModelConfig(
  config: ModelConfigUpdate,
): Promise<ModelTestResult> {
  return requestJson<ModelTestResult>("/api/settings/model/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function getSciverseConfig(): Promise<SciverseConfigStatus> {
  return requestJson<SciverseConfigStatus>("/api/settings/sciverse");
}

export function updateSciverseConfig(
  config: SciverseConfigUpdate,
): Promise<SciverseConfigStatus> {
  return requestJson<SciverseConfigStatus>("/api/settings/sciverse", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export function testSciverseConfig(
  config: SciverseConfigUpdate,
): Promise<SciverseTestResult> {
  return requestJson<SciverseTestResult>("/api/settings/sciverse/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function resolveEvidence(
  schemaId: string,
  markerNums: number[],
  paragraphIds: string[],
  signal?: AbortSignal,
): Promise<ProvenanceResult> {
  const locator = paragraphIds.length
    ? { paragraph_ids: paragraphIds }
    : { schema_id: schemaId, marker_nums: markerNums };
  return requestJson<ProvenanceResult>("/api/provenance", {
    method: "POST",
    signal,
    body: JSON.stringify({
      ...locator,
      window: 1,
      max_segments: 12,
    }),
  });
}

export function searchPaperContext(
  schemaId: string,
  query: string,
  signal?: AbortSignal,
): Promise<ProvenanceResult> {
  return requestJson<ProvenanceResult>(
    `/api/papers/${encodeURIComponent(schemaId)}/context-search`,
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        query,
        top_k: 5,
        window: 1,
      }),
    },
  );
}
