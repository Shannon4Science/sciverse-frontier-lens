export type NodeType = "paper" | "entity" | "reference" | "evidence";
export type EdgeType =
  | "internal_relation"
  | "citation"
  | "related_suggestion";

export interface PaperCard {
  schema_id: string;
  title: string;
  abstract?: string | null;
  authors: string[];
  venue?: string | null;
  year?: number | null;
  doi?: string | null;
  arxiv_id?: string | null;
  pdf_url?: string | null;
  external_url?: string | null;
  topics: string[];
  tasks: string[];
  research_problem?: string | null;
  central_contribution?: string | null;
  headline_result?: string | null;
  has_code?: boolean | null;
  has_data?: boolean | null;
}

export interface PaperReadingSource {
  requested_schema_id: string;
  active_schema_id: string;
  canonical_document: PaperCard;
  active_document: PaperCard;
  used_equivalent_version: boolean;
  active_reason:
    | "requested_full_text"
    | "equivalent_full_text"
    | "full_text_unavailable";
}

export interface SourceAnchor {
  paragraph_id?: string | null;
  marker_num?: number | null;
}

export interface GraphNode {
  id: string;
  node_type: NodeType;
  label: string;
  subtitle?: string | null;
  schema_id: string;
  entity_id?: string | null;
  entity_type?: string | null;
  entity_subtype?: string | null;
  section?: string | null;
  description?: string | null;
  anchors?: SourceAnchor[];
  paper?: PaperCard | null;
  status: "available" | "unresolved" | "partial";
}

export interface GraphEdge {
  id: string;
  edge_type: EdgeType;
  source: string;
  target: string;
  label: string;
  directed: boolean;
  relation_type?: string | null;
  citation_count?: number | null;
  score?: number | null;
  reasons: string[];
  provenance_count: number;
}

export interface GraphPayload {
  graph_id: string;
  title: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    paper_nodes: number;
    entity_nodes: number;
    reference_nodes: number;
    internal_relations: number;
    citations: number;
    suggestions: number;
  };
  warnings: string[];
  truncated: boolean;
}

export interface Capabilities {
  contract_version: string;
  mode: "unconfigured" | "production";
  coverage: {
    current_focus: string;
    paper_count: string;
    empty_result_message: string;
  };
  resources: string[];
  edge_types: EdgeType[];
  limits: Record<string, number>;
}

export interface CitationItem {
  relation_id: string;
  reference?: {
    entity_id?: string | null;
    title: string;
    authors: string[];
    year?: number | null;
    venue?: string | null;
    doi?: string | null;
  } | null;
  resolution: {
    status: "resolved" | "unresolved" | "target_unavailable";
    target_schema_id?: string | null;
    score?: number | null;
  };
  target_paper?: PaperCard | null;
}

export interface CitationList {
  schema_id: string;
  total: number;
  items: CitationItem[];
  truncated: boolean;
}

export interface EvidenceItem {
  schema_id: string;
  evidence_id: string;
  groups: string[];
  key?: string | null;
  path?: string | null;
  path_bucket?: string | null;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
  marker_nums: number[];
  paragraph_ids: string[];
}

export interface EvidenceSearchResult {
  items: EvidenceItem[];
  next_cursor?: string | null;
  fallback_recommended: boolean;
}

export interface ProvenanceResult {
  segments: Array<{
    schema_id: string;
    paragraph_id?: string | null;
    marker_num?: number | null;
    section?: string | null;
    section_path?: string | null;
    text: string;
    match_role?: "target" | "neighbor" | null;
  }>;
  returned: number;
  locator_method: "provenance" | "schema_local_search";
  query?: string | null;
}

export interface ParagraphPage {
  schema_id: string;
  source_schema_id?: string | null;
  source_document?: PaperCard | null;
  segments: ProvenanceResult["segments"];
  returned: number;
  next_marker?: number | null;
  complete: boolean;
}

export interface ReadingGuide {
  query: string;
  title: string;
  summary: string;
  items: Array<{
    order: number;
    schema_id: string;
    title: string;
    role: "seed" | "foundation" | "expansion";
    rationale: string;
  }>;
  scope_note: string;
  caveats: string[];
  generation_mode: "deterministic" | "model";
  model_warning?: string | null;
}

export interface PaperOverview {
  schema_id: string;
  language: "zh" | "en";
  summary: string;
  why_read: string;
  focus_points: string[];
  generation_mode: "deterministic" | "model";
  model_warning?: string | null;
}

export interface QueryPlan {
  original_query: string;
  search_queries: string[];
  keywords: string[];
  language: "zh" | "en" | "mixed" | "other";
  rewrite_source: "none" | "dictionary" | "model";
  warning?: string | null;
}

export interface TopicExploration {
  graph: GraphPayload;
  guide: ReadingGuide;
  query_plan: QueryPlan;
}

export type ProgressStatus = "waiting" | "running" | "completed" | "failed";

export interface TopicProgressEvent {
  type: "progress";
  step: "understand" | "keywords" | "papers" | "expansion" | "graph" | "guide";
  status: Exclude<ProgressStatus, "waiting" | "failed">;
  summary?: string | null;
  metrics: Record<string, number | string>;
  elapsed_ms: number;
}

export interface ModelConfigStatus {
  enabled: boolean;
  configured: boolean;
  base_url: string;
  model: string;
  api_key_set: boolean;
  api_key_hint?: string | null;
  timeout_seconds: number;
  allow_insecure_http?: boolean;
  storage: "local_project_json";
  storage_path: string;
}

export interface ModelConfigUpdate {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key?: string;
  clear_api_key?: boolean;
  timeout_seconds: number;
  allow_insecure_http?: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  model: string;
  latency_ms: number;
}

export interface SciverseConfigStatus {
  enabled: boolean;
  configured: boolean;
  mode: "unconfigured" | "production";
  base_url: string;
  api_key_set: boolean;
  api_key_hint?: string | null;
  timeout_seconds: number;
  storage: "local_project_json";
  storage_path: string;
}

export interface SciverseConfigUpdate {
  enabled: boolean;
  base_url: string;
  api_key?: string;
  clear_api_key?: boolean;
  timeout_seconds: number;
}

export interface SciverseTestResult {
  ok: boolean;
  mode: "production";
  latency_ms: number;
  contract_version?: string | null;
}
