import {
  ArrowLeft,
  BookOpen,
  BookOpenText,
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  ExternalLink,
  FileSearch,
  Filter,
  Focus,
  Globe,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  TestTube2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  exploreTopicStream,
  getCapabilities,
  getCitations,
  getDiscoveryMap,
  getModelConfig,
  getPaperGraph,
  getPaperOverview,
  getPaperParagraphs,
  getPaperReadingSource,
  getSciverseConfig,
  resolveEvidence,
  searchEvidence,
  searchPaperContext,
  testModelConfig,
  testSciverseConfig,
  updateModelConfig,
  updateSciverseConfig,
} from "./api";
import { filterGraphByVisibility } from "./graph";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import { DiscoveryBoard, RoadmapBoard, StructureBoard } from "./GuidedBoards";
import { useI18n } from "./i18n";
import { inlineScientificText, normalizeScientificMarkdown } from "./text";
import type {
  Capabilities,
  CitationList,
  EdgeType,
  EvidenceItem,
  GraphEdge,
  GraphNode,
  GraphPayload,
  ModelConfigStatus,
  PaperCard,
  PaperOverview,
  ProgressStatus,
  ProvenanceResult,
  QueryPlan,
  ReadingGuide,
  SciverseConfigStatus,
} from "./types";
import "katex/dist/katex.min.css";
import "./styles.css";

type AppMode = "overview" | "research" | "paper" | "settings";
type OverviewView = "cards" | "graph";
type ResearchView = "roadmap" | "subgraph";
type PaperView = "structure" | "internal";

interface NavigationSnapshot {
  activePaper: PaperCard | null;
  canonicalPaper: PaperCard | null;
  paperOverview: PaperOverview | null;
  citations: CitationList | null;
  evidence: EvidenceItem[];
  graph: GraphPayload | null;
  inspectorOpen: boolean;
  mode: Exclude<AppMode, "settings">;
  overviewView: OverviewView;
  paperPanel: "guide" | "citations" | "evidence";
  paperView: PaperView;
  provenance: ProvenanceResult | null;
  researchView: ResearchView;
  selectedEdge: GraphEdge | null;
  selectedEvidence: EvidenceItem | null;
  selectedNode: GraphNode | null;
}

type ProgressTaskKind = "exploration" | "paper";

interface ProgressStepState {
  id: string;
  status: ProgressStatus;
  summary?: string;
  startedAt?: number;
  elapsedMs?: number;
}

interface ProgressTaskState {
  kind: ProgressTaskKind;
  subject: string;
  startedAt: number;
  steps: ProgressStepState[];
  error?: string;
}

interface ReaderSource {
  kind: "entity" | "evidence";
  label: string;
  displayId: string;
  schemaId: string;
}

const EXAMPLES = {
  zh: [
    "LLM 的 in-context learning 和传统机器学习训练有什么不同？",
    "目前有哪些提高 Transformer 模型推理速度的方法？",
    "知识图谱在 LLM 时代有哪些应用？",
    "持续学习中，应该如何缓解 catastrophic forgetting？",
  ],
  en: [
    "How does in-context learning differ from conventional model training?",
    "Which methods improve Transformer inference speed?",
    "How are knowledge graphs used in the LLM era?",
    "How can catastrophic forgetting be mitigated in continual learning?",
  ],
};

const ENTITY_TYPES = [
  { key: "Paper", zh: "论文", en: "Paper", color: "#2f6fec" },
  { key: "Problem", zh: "研究问题", en: "Problem", color: "#bc5c14" },
  { key: "Contribution", zh: "研究贡献", en: "Contribution", color: "#0f8a83" },
  { key: "Component", zh: "方法组件", en: "Component", color: "#7442db" },
  { key: "ExperimentSetup", zh: "实验设置", en: "Experiment Setup", color: "#c53b2c" },
  { key: "Finding", zh: "研究发现", en: "Finding", color: "#0b8656" },
  { key: "Dataset", zh: "数据集", en: "Dataset", color: "#d43b2f" },
  { key: "Task", zh: "任务", en: "Task", color: "#d43b2f" },
  { key: "Measure", zh: "评价指标", en: "Measure", color: "#56657a" },
  { key: "Resource", zh: "资源", en: "Resource", color: "#0f8a83" },
] as const;

const EDGE_TYPES: Array<{
  key: EdgeType;
  zh: string;
  en: string;
  dotClass: string;
}> = [
  {
    key: "internal_relation",
    zh: "文内关系",
    en: "Internal Relation",
    dotClass: "relation-dot",
  },
  {
    key: "citation",
    zh: "论文引用",
    en: "Citation",
    dotClass: "citation-dot",
  },
  {
    key: "related_suggestion",
    zh: "相关建议",
    en: "Related Suggestion",
    dotClass: "suggestion-dot",
  },
];

function initialNodeVisibility(): Record<string, boolean> {
  return Object.fromEntries(ENTITY_TYPES.map((item) => [item.key, true]));
}

function initialEdgeVisibility(): Record<EdgeType, boolean> {
  return Object.fromEntries(
    EDGE_TYPES.map((item) => [item.key, true]),
  ) as Record<EdgeType, boolean>;
}

const DEFAULT_OVERVIEW_SIDEBAR_WIDTH = 306;
const MIN_OVERVIEW_SIDEBAR_WIDTH = 260;
const MAX_OVERVIEW_SIDEBAR_WIDTH = 480;
const DEFAULT_RESEARCH_GUIDE_WIDTH = 520;
const MIN_RESEARCH_GUIDE_WIDTH = 340;
const MAX_RESEARCH_GUIDE_WIDTH = 820;
const DEFAULT_PAPER_GUIDE_WIDTH = 440;
const MIN_PAPER_GUIDE_WIDTH = 300;
const MAX_PAPER_GUIDE_WIDTH = 600;
const DEFAULT_EVIDENCE_READER_WIDTH = 440;
const MIN_EVIDENCE_READER_WIDTH = 340;
const MAX_EVIDENCE_READER_WIDTH = 680;

const EXPLORATION_STEP_IDS = [
  "understand",
  "keywords",
  "papers",
  "expansion",
  "graph",
  "guide",
] as const;

const PAPER_STEP_IDS = [
  "metadata",
  "overview",
  "structure",
  "fulltext",
  "citations",
  "evidence",
  "prepare",
] as const;

function clampOverviewSidebarWidth(width: number) {
  const viewportMax = Math.max(
    MIN_OVERVIEW_SIDEBAR_WIDTH,
    window.innerWidth - 520,
  );
  return Math.round(Math.min(
    Math.max(width, MIN_OVERVIEW_SIDEBAR_WIDTH),
    Math.min(MAX_OVERVIEW_SIDEBAR_WIDTH, viewportMax),
  ));
}

function clampPaperGuideWidth(width: number) {
  const viewportMax = Math.max(
    MIN_PAPER_GUIDE_WIDTH,
    window.innerWidth - 620,
  );
  return Math.round(Math.min(
    Math.max(width, MIN_PAPER_GUIDE_WIDTH),
    Math.min(MAX_PAPER_GUIDE_WIDTH, viewportMax),
  ));
}

function clampResearchGuideWidth(width: number) {
  const viewportMax = Math.max(
    MIN_RESEARCH_GUIDE_WIDTH,
    window.innerWidth - 560,
  );
  return Math.round(Math.min(
    Math.max(width, MIN_RESEARCH_GUIDE_WIDTH),
    Math.min(MAX_RESEARCH_GUIDE_WIDTH, viewportMax),
  ));
}

function clampEvidenceReaderWidth(width: number) {
  const viewportMax = Math.max(
    MIN_EVIDENCE_READER_WIDTH,
    window.innerWidth - 680,
  );
  return Math.round(Math.min(
    Math.max(width, MIN_EVIDENCE_READER_WIDTH),
    Math.min(MAX_EVIDENCE_READER_WIDTH, viewportMax),
  ));
}

function createProgressTask(
  kind: ProgressTaskKind,
  subject: string,
): ProgressTaskState {
  const ids = kind === "exploration" ? EXPLORATION_STEP_IDS : PAPER_STEP_IDS;
  return {
    kind,
    subject,
    startedAt: Date.now(),
    steps: ids.map((id, index) => ({
      id,
      status: index === 0 ? "running" : "waiting",
      ...(index === 0 ? { startedAt: Date.now() } : {}),
    })),
  };
}

function summarizeExplorationProgress(
  step: string,
  status: string,
  metrics: Record<string, number | string>,
  tr: (zh: string, en: string) => string,
): string | undefined {
  if (status === "running") {
    const messages: Record<string, string> = {
      keywords: tr("正在生成简短英文检索词", "Generating concise English search queries"),
      papers: tr("正在查询 Sciverse 论文", "Searching Sciverse papers"),
      expansion: tr("正在扩展种子论文结构", "Expanding seed-paper structure"),
      graph: tr("正在组装主题图谱", "Assembling the topic graph"),
      guide: tr("正在生成研究导读", "Generating the research guide"),
    };
    return messages[step];
  }
  if (step === "keywords" && metrics.keywords) {
    return tr(`检索词：${metrics.keywords}`, `Queries: ${metrics.keywords}`);
  }
  if (step === "papers") {
    return tr(`已找到 ${metrics.papers || 0} 篇种子论文`, `${metrics.papers || 0} seed papers found`);
  }
  if (step === "expansion") {
    return tr(
      `${metrics.entities || 0} 个 Entity · ${metrics.relations || 0} 条关系`,
      `${metrics.entities || 0} Entities · ${metrics.relations || 0} relations`,
    );
  }
  if (step === "graph") {
    return tr(
      `${metrics.nodes || 0} 个节点 · ${metrics.edges || 0} 条边`,
      `${metrics.nodes || 0} nodes · ${metrics.edges || 0} edges`,
    );
  }
  if (step === "guide") {
    return tr(
      `${metrics.guide_papers || 0} 篇导读论文`,
      `${metrics.guide_papers || 0} guide papers`,
    );
  }
  return undefined;
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function mergeProvenanceResults(
  results: ProvenanceResult[],
): ProvenanceResult {
  const segments = new Map<string, ProvenanceResult["segments"][number]>();
  results.forEach((result) => {
    result.segments.forEach((segment) => {
      const key = segment.paragraph_id
        || `${segment.schema_id}:${segment.marker_num ?? segment.text}`;
      segments.set(key, segment);
    });
  });
  return {
    segments: [...segments.values()].sort((left, right) => (
      (left.marker_num ?? Number.MAX_SAFE_INTEGER)
      - (right.marker_num ?? Number.MAX_SAFE_INTEGER)
    )),
    returned: segments.size,
    locator_method: "provenance",
    query: null,
  };
}

function mergeParagraphSegments(
  base: ProvenanceResult["segments"],
  overlays: ProvenanceResult["segments"],
): ProvenanceResult["segments"] {
  const segments = new Map<string, ProvenanceResult["segments"][number]>();
  [...base, ...overlays].forEach((segment) => {
    const key = segment.paragraph_id
      || `${segment.schema_id}:${segment.marker_num ?? segment.text}`;
    const current = segments.get(key);
    segments.set(key, current ? { ...current, ...segment } : segment);
  });
  return [...segments.values()].sort((left, right) => (
    (left.marker_num ?? Number.MAX_SAFE_INTEGER)
    - (right.marker_num ?? Number.MAX_SAFE_INTEGER)
  ));
}

function countType(graph: GraphPayload | null, type: string) {
  if (!graph) return 0;
  if (type === "Paper") return graph.stats.paper_nodes;
  return graph.nodes.filter((node) => node.entity_type === type).length;
}

function countEdgeType(graph: GraphPayload | null, type: EdgeType) {
  if (!graph) return 0;
  return graph.edges.filter((edge) => edge.edge_type === type).length;
}

function broadPaperContextQuery(value: string): string {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "for",
    "from",
    "in",
    "of",
    "on",
    "the",
    "to",
    "using",
    "via",
    "with",
  ]);
  return (value.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => !stopWords.has(token))
    .slice(0, 5)
    .join(" ");
}

function humanizeEvidenceToken(value: string) {
  return value
    .replace(/\[\d+\]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isDisplayableEvidence(item: EvidenceItem) {
  const key = (item.key || "").toLowerCase();
  if (/(^|_)marker(_num)?$/.test(key) || key === "paragraph_id") {
    return false;
  }
  return Boolean(
    item.value_text?.trim()
    || item.value_number != null
    || item.value_bool != null,
  );
}

function evidenceLabel(
  item: EvidenceItem,
  tr: (zh: string, en: string) => string,
) {
  const key = (item.key || "").toLowerCase();
  const labels: Record<string, string> = {
    signal: tr("引用语境", "Citation context"),
    role: tr("引用关系", "Citation relation"),
    "roles[0]": tr("引用关系", "Citation relation"),
    stance: tr("引用立场", "Citation stance"),
    table_role: tr("表格用途", "Table purpose"),
  };
  if (labels[key]) return labels[key];
  if (item.groups.includes("formula")) return tr("公式", "Formula");
  if (item.groups.includes("resource")) return tr("研究资源", "Research resource");
  if (item.groups.includes("comparison_detail")) return tr("结果对比", "Result comparison");
  return humanizeEvidenceToken(
    item.key || item.groups[0] || tr("结构证据", "Structured evidence"),
  );
}

function evidenceValue(
  item: EvidenceItem,
  tr: (zh: string, en: string) => string,
) {
  if (item.value_number != null) return String(item.value_number);
  if (item.value_bool != null) {
    return item.value_bool ? tr("是", "Yes") : tr("否", "No");
  }
  const value = item.value_text?.trim() || "";
  const enums: Record<string, string> = {
    main_result: tr("主要结果", "Main result"),
    neutral: tr("中性引用", "Neutral citation"),
    addresses_limitation_of: tr("针对其局限", "Addresses a limitation"),
    compares_with: tr("对比相关工作", "Compares with related work"),
    uses_component: tr("使用其组件", "Uses a component"),
    uses_method: tr("使用其方法", "Uses a method"),
    supports: tr("提供支持", "Provides support"),
    extends: tr("扩展相关工作", "Extends related work"),
    contradicts: tr("提出不同结论", "Presents a conflicting result"),
    background: tr("作为背景", "Provides background"),
  };
  return enums[value.toLowerCase()] || value;
}

function evidenceMarkdown(
  item: EvidenceItem,
  tr: (zh: string, en: string) => string,
) {
  const value = evidenceValue(item, tr);
  const looksLikeBareLatex = item.groups.includes("formula")
    && /\\(?:begin|frac|left|right|sum|sqrt|tag|mathrm|mathbf|mathcal)\b/.test(value)
    && !value.includes("$$");
  return normalizeScientificMarkdown(
    looksLikeBareLatex ? `$$\n${value}\n$$` : value,
  );
}

function App() {
  const { language, setLanguage, tr } = useI18n();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [sciverseStatus, setSciverseStatus] = useState<SciverseConfigStatus | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [discoveryGraph, setDiscoveryGraph] = useState<GraphPayload | null>(null);
  const [mode, setMode] = useState<AppMode>("overview");
  const [overviewView, setOverviewView] = useState<OverviewView>("cards");
  const [visibleNodeTypes, setVisibleNodeTypes] = useState<
    Record<string, boolean>
  >(initialNodeVisibility);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<
    Record<EdgeType, boolean>
  >(initialEdgeVisibility);
  const [researchView, setResearchView] = useState<ResearchView>("roadmap");
  const [paperView, setPaperView] = useState<PaperView>("structure");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [guide, setGuide] = useState<ReadingGuide | null>(null);
  const [queryPlan, setQueryPlan] = useState<QueryPlan | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [canonicalPaper, setCanonicalPaper] = useState<PaperCard | null>(null);
  const [activePaper, setActivePaper] = useState<PaperCard | null>(null);
  const [paperOverview, setPaperOverview] = useState<PaperOverview | null>(null);
  const [paperOverviewLoading, setPaperOverviewLoading] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [citations, setCitations] = useState<CitationList | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceItem | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressTask, setProgressTask] = useState<ProgressTaskState | null>(null);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [overviewSidebarWidth, setOverviewSidebarWidth] = useState(
    DEFAULT_OVERVIEW_SIDEBAR_WIDTH,
  );
  const [resizingOverviewSidebar, setResizingOverviewSidebar] = useState(false);
  const [researchGuideWidth, setResearchGuideWidth] = useState(
    DEFAULT_RESEARCH_GUIDE_WIDTH,
  );
  const [paperGuideWidth, setPaperGuideWidth] = useState(DEFAULT_PAPER_GUIDE_WIDTH);
  const [evidenceReaderWidth, setEvidenceReaderWidth] = useState(
    DEFAULT_EVIDENCE_READER_WIDTH,
  );
  const [activePaneResize, setActivePaneResize] = useState<
    "research" | "guide" | "reader" | null
  >(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerSource, setReaderSource] = useState<ReaderSource | null>(null);
  const [readerResult, setReaderResult] = useState<ProvenanceResult | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");
  const [paperParagraphs, setPaperParagraphs] = useState<
    ProvenanceResult["segments"]
  >([]);
  const [paragraphSourceDocument, setParagraphSourceDocument] = useState<
    PaperCard | null
  >(null);
  const [paragraphComplete, setParagraphComplete] = useState(false);
  const [paragraphLoading, setParagraphLoading] = useState(false);
  const [paragraphError, setParagraphError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paperPanel, setPaperPanel] = useState<"guide" | "citations" | "evidence">("guide");
  const graphRef = useRef<GraphCanvasHandle | null>(null);
  const cardRef = useRef<GraphCanvasHandle | null>(null);
  const activeTaskController = useRef<AbortController | null>(null);
  const readerController = useRef<AbortController | null>(null);
  const paragraphController = useRef<AbortController | null>(null);
  const paperOverviewController = useRef<AbortController | null>(null);
  const retryTask = useRef<(() => void) | null>(null);
  const returnMode = useRef<Exclude<AppMode, "settings">>("overview");
  const levelHistory = useRef<NavigationSnapshot[]>([]);
  const sidebarResizeOrigin = useRef({ pointerX: 0, width: 0 });
  const paneResizeOrigin = useRef({ pointerX: 0, width: 0 });
  const cardViewActive = (
    (mode === "overview" && overviewView === "cards")
    || (mode === "research" && researchView === "roadmap")
    || (mode === "paper" && paperView === "structure")
  );
  const activeCanvasRef = cardViewActive ? cardRef : graphRef;

  useEffect(() => {
    Promise.all([getCapabilities(), getSciverseConfig()])
      .then(async ([nextCapabilities, nextStatus]) => {
        setCapabilities(nextCapabilities);
        setSciverseStatus(nextStatus);
        if (nextStatus.configured) {
          const nextGraph = await getDiscoveryMap();
          setDiscoveryGraph(nextGraph);
          setGraph(nextGraph);
        } else {
          setDiscoveryGraph(null);
          setGraph(null);
        }
      })
      .catch((reason: unknown) => setError(messageOf(reason)));
  }, []);

  useEffect(() => {
    if (!resizingOverviewSidebar) return;
    const resize = (event: globalThis.PointerEvent) => {
      if (!Number.isFinite(event.clientX)) return;
      const nextWidth = sidebarResizeOrigin.current.width
        + event.clientX
        - sidebarResizeOrigin.current.pointerX;
      setOverviewSidebarWidth(clampOverviewSidebarWidth(nextWidth));
    };
    const stop = () => setResizingOverviewSidebar(false);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizingOverviewSidebar]);

  useEffect(() => {
    const fitSidebarToViewport = () => {
      setOverviewSidebarWidth((width) => clampOverviewSidebarWidth(width));
    };
    window.addEventListener("resize", fitSidebarToViewport);
    return () => window.removeEventListener("resize", fitSidebarToViewport);
  }, []);

  useEffect(() => {
    if (!activePaneResize) return;
    const resize = (event: globalThis.PointerEvent) => {
      if (!Number.isFinite(event.clientX)) return;
      const delta = event.clientX - paneResizeOrigin.current.pointerX;
      if (activePaneResize === "research") {
        setResearchGuideWidth(clampResearchGuideWidth(
          paneResizeOrigin.current.width + delta,
        ));
      } else if (activePaneResize === "guide") {
        setPaperGuideWidth(clampPaperGuideWidth(
          paneResizeOrigin.current.width + delta,
        ));
      } else {
        setEvidenceReaderWidth(clampEvidenceReaderWidth(
          paneResizeOrigin.current.width - delta,
        ));
      }
    };
    const stop = () => setActivePaneResize(null);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [activePaneResize]);

  useEffect(() => {
    const fitPaperPanesToViewport = () => {
      setResearchGuideWidth((width) => clampResearchGuideWidth(width));
      setPaperGuideWidth((width) => clampPaperGuideWidth(width));
      setEvidenceReaderWidth((width) => clampEvidenceReaderWidth(width));
    };
    window.addEventListener("resize", fitPaperPanesToViewport);
    return () => window.removeEventListener("resize", fitPaperPanesToViewport);
  }, []);

  async function applySciverseStatus(nextStatus: SciverseConfigStatus) {
    setSciverseStatus(nextStatus);
    setCapabilities(await getCapabilities());
    if (!nextStatus.configured) {
      setGraph(null);
      setDiscoveryGraph(null);
      levelHistory.current = [];
      setMode("overview");
      return;
    }
    const nextGraph = await getDiscoveryMap();
    setDiscoveryGraph(nextGraph);
    setGraph(nextGraph);
    setMode("overview");
    setError("");
  }

  const selectedPaper = useMemo(() => {
    if (mode === "paper" && canonicalPaper) return canonicalPaper;
    if (selectedNode?.paper) return selectedNode.paper;
    return graph?.nodes.find((node) => node.node_type === "paper")?.paper || null;
  }, [canonicalPaper, graph, mode, selectedNode]);

  const selectNode = useCallback((node: GraphNode) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    setInspectorOpen(true);
  }, []);

  const selectEdge = useCallback((edge: GraphEdge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
    setInspectorOpen(true);
  }, []);

  function submitQuestion(event?: FormEvent) {
    event?.preventDefault();
    const value = query.trim();
    if (!value) return;
    runExploration(value, language);
  }

  function updateProgressStep(
    stepId: string,
    status: ProgressStatus,
    summary?: string,
  ) {
    const now = Date.now();
    setProgressTask((current) => current ? {
      ...current,
      error: status === "failed" ? current.error : undefined,
      steps: current.steps.map((step) => {
        if (step.id !== stepId) return step;
        const startedAt = status === "running"
          ? step.startedAt || now
          : step.startedAt;
        return {
          ...step,
          status,
          summary,
          startedAt,
          ...(status === "completed" || status === "failed"
            ? { elapsedMs: Math.max(0, now - (startedAt || current.startedAt)) }
            : {}),
        };
      }),
    } : current);
  }

  function failProgressTask(message: string) {
    const now = Date.now();
    setProgressTask((current) => {
      if (!current) return current;
      const running = current.steps.find((step) => step.status === "running");
      return {
        ...current,
        error: message,
        steps: current.steps.map((step) => (
          step.id === running?.id
            ? {
              ...step,
              status: "failed",
              summary: message,
              elapsedMs: Math.max(
                0,
                now - (step.startedAt || current.startedAt),
              ),
            }
            : step
        )),
      };
    });
  }

  function cancelProgressTask() {
    activeTaskController.current?.abort();
    activeTaskController.current = null;
    setProgressTask(null);
    setBusy(false);
  }

  async function runExploration(
    value: string,
    responseLanguage: "zh" | "en",
  ) {
    if (!sciverseStatus?.configured) {
      setError(tr(
        "请先在本地设置中配置并验证 Sciverse API Key。",
        "Configure and verify a Sciverse API key in Local Settings first.",
      ));
      setMode("settings");
      return;
    }
    activeTaskController.current?.abort();
    const controller = new AbortController();
    activeTaskController.current = controller;
    retryTask.current = () => {
      void runExploration(value, responseLanguage);
    };
    setBusy(true);
    setError("");
    setProgressTask(createProgressTask("exploration", value));
    try {
      const result = await exploreTopicStream(
        value,
        responseLanguage,
        (event) => {
          updateProgressStep(
            event.step,
            event.status,
            summarizeExplorationProgress(event.step, event.status, event.metrics, tr),
          );
        },
        controller.signal,
      );
      if (activeTaskController.current !== controller) return;
      setGraph(result.graph);
      setCanonicalPaper(null);
      setActivePaper(null);
      setPaperOverview(null);
      setGuide(result.guide);
      setQueryPlan(result.query_plan);
      setActiveQuery(value);
      levelHistory.current = [];
      setMode("research");
      setResearchView("roadmap");
      setSelectedNode(result.graph.nodes.find((node) => node.node_type === "paper") || null);
      setSelectedEdge(null);
      setInspectorOpen(false);
      setProgressTask(null);
    } catch (reason: unknown) {
      if (isAbortError(reason)) {
        setProgressTask(null);
      } else {
        failProgressTask(messageOf(reason));
      }
    } finally {
      if (activeTaskController.current === controller) {
        activeTaskController.current = null;
        setBusy(false);
      }
    }
  }

  function changeLanguage(next: "zh" | "en") {
    if (next === language) return;
    setLanguage(next);
    if (mode === "research" && activeQuery) {
      runExploration(activeQuery, next);
    } else if (mode === "paper" && (activePaper || canonicalPaper)) {
      void refreshPaperOverview(
        (activePaper || canonicalPaper)?.schema_id || "",
        next,
      );
    }
  }

  async function refreshPaperOverview(
    schemaId: string,
    responseLanguage: "zh" | "en",
  ) {
    paperOverviewController.current?.abort();
    const controller = new AbortController();
    paperOverviewController.current = controller;
    setPaperOverviewLoading(true);
    try {
      const next = await getPaperOverview(
        schemaId,
        responseLanguage,
        controller.signal,
      );
      if (paperOverviewController.current === controller) {
        setPaperOverview(next);
      }
    } catch (reason: unknown) {
      if (!isAbortError(reason) && paperOverviewController.current === controller) {
        setError(tr(
          `论文概述暂时无法更新：${messageOf(reason)}`,
          `The paper overview could not be updated: ${messageOf(reason)}`,
        ));
      }
    } finally {
      if (paperOverviewController.current === controller) {
        paperOverviewController.current = null;
        setPaperOverviewLoading(false);
      }
    }
  }

  function askExample(value: string) {
    setQuery(value);
    window.setTimeout(() => {
      const form = document.querySelector<HTMLFormElement>("#research-form");
      form?.requestSubmit();
    }, 0);
  }

  async function openPaper(schemaId: string) {
    const origin: NavigationSnapshot = {
      activePaper,
      canonicalPaper,
      paperOverview,
      citations,
      evidence,
      graph,
      inspectorOpen,
      mode: mode === "settings" ? returnMode.current : mode,
      overviewView,
      paperPanel,
      paperView,
      provenance,
      researchView,
      selectedEdge,
      selectedEvidence,
      selectedNode,
    };
    activeTaskController.current?.abort();
    const controller = new AbortController();
    activeTaskController.current = controller;
    retryTask.current = () => {
      void openPaper(schemaId);
    };
    const subject = graph?.nodes.find((node) => node.schema_id === schemaId)?.label
      || schemaId;
    setBusy(true);
    setError("");
    setProgressTask(createProgressTask("paper", subject));
    try {
      const readingSource = await getPaperReadingSource(
        schemaId,
        controller.signal,
      );
      const detail = readingSource.canonical_document;
      const activeSchemaId = readingSource.active_schema_id;
      updateProgressStep("metadata", "completed", tr(
        readingSource.used_equivalent_version
          ? "已选择具有全文的等价 Schema 版本"
          : "论文元数据与全文版本已确认",
        readingSource.used_equivalent_version
          ? "Selected an equivalent Schema version with full text"
          : "Paper metadata and full-text version confirmed",
      ));
      setProgressTask((current) => current ? {
        ...current,
        subject: detail.title,
      } : current);
      ["structure", "fulltext", "citations", "evidence"].forEach((step) => {
        updateProgressStep(step, "running");
      });
      updateProgressStep("overview", "running", tr(
        "正在使用元数据、Entity 与 Relation 生成概述",
        "Generating from metadata, Entities, and Relations",
      ));

      const overviewPromise = getPaperOverview(
        activeSchemaId,
        language,
        controller.signal,
      )
        .then((value) => {
          updateProgressStep("overview", "completed", tr(
            "论文概述已准备",
            "Paper overview ready",
          ));
          return value;
        })
        .catch((reason: unknown) => {
          updateProgressStep("overview", "failed", messageOf(reason));
          throw reason;
        });

      const graphPromise = getPaperGraph(activeSchemaId, controller.signal)
        .then((value) => {
          updateProgressStep("structure", "completed", tr(
            `${value.stats.entity_nodes + value.stats.reference_nodes} 个 Entity · ${value.stats.internal_relations} 条关系`,
            `${value.stats.entity_nodes + value.stats.reference_nodes} Entities · ${value.stats.internal_relations} relations`,
          ));
          return value;
        })
        .catch((reason: unknown) => {
          updateProgressStep("structure", "failed", messageOf(reason));
          throw reason;
        });
      const paragraphPromise = fetchCompletePaper(
        activeSchemaId,
        controller.signal,
        (count) => updateProgressStep("fulltext", "running", tr(
          `已按顺序加载 ${count} 个段落`,
          `${count} ordered paragraphs loaded`,
        )),
      )
        .then((value) => {
          updateProgressStep("fulltext", "completed", tr(
            `全文已按顺序拼接，共 ${value.segments.length} 个段落`,
            `Full text assembled from ${value.segments.length} ordered paragraphs`,
          ));
          return value;
        })
        .catch((reason: unknown) => {
          updateProgressStep("fulltext", "failed", messageOf(reason));
          throw reason;
        });
      const citationPromise = getCitations(activeSchemaId, controller.signal)
        .then((value) => {
          updateProgressStep("citations", "completed", tr(
            `${value.total} 条引用`,
            `${value.total} citations`,
          ));
          return value;
        })
        .catch((reason: unknown) => {
          updateProgressStep("citations", "failed", messageOf(reason));
          throw reason;
        });
      const evidencePromise = searchEvidence(activeSchemaId, controller.signal)
        .then((value) => {
          const items = value.items.filter(isDisplayableEvidence);
          updateProgressStep("evidence", "completed", tr(
            `${items.length} 条可读证据`,
            `${items.length} readable evidence items`,
          ));
          return { ...value, items };
        })
        .catch((reason: unknown) => {
          updateProgressStep("evidence", "failed", messageOf(reason));
          throw reason;
        });
      const [
        graphResult,
        citationResult,
        evidenceResult,
        overviewResult,
        paragraphResult,
      ] = await Promise.allSettled([
        graphPromise,
        citationPromise,
        evidencePromise,
        overviewPromise,
        paragraphPromise,
      ]);
      if (graphResult.status === "rejected") {
        throw graphResult.reason;
      }
      updateProgressStep("prepare", "running", tr(
        "正在准备论文知识视图",
        "Preparing the paper knowledge view",
      ));
      const nextGraph = graphResult.value;
      const nextCitations = citationResult.status === "fulfilled"
        ? citationResult.value
        : null;
      const nextEvidence = evidenceResult.status === "fulfilled"
        ? evidenceResult.value
        : { items: [], fallback_recommended: false };
      levelHistory.current.push(origin);
      setGraph(nextGraph);
      setCanonicalPaper(readingSource.canonical_document);
      setActivePaper(readingSource.active_document);
      setPaperOverview(
        overviewResult.status === "fulfilled" ? overviewResult.value : null,
      );
      setCitations(nextCitations);
      setEvidence(nextEvidence.items);
      setSelectedEvidence(nextEvidence.items[0] || null);
      setProvenance(null);
      setSelectedNode(nextGraph.nodes.find((node) => node.node_type === "paper") || null);
      setSelectedEdge(null);
      setMode("paper");
      setPaperView("structure");
      setPaperPanel("guide");
      setInspectorOpen(false);
      setReaderOpen(false);
      setReaderResult(null);
      setReaderSource(null);
      paragraphController.current?.abort();
      setPaperParagraphs(
        paragraphResult.status === "fulfilled"
          ? paragraphResult.value.segments
          : [],
      );
      setParagraphSourceDocument(
        paragraphResult.status === "fulfilled"
          ? paragraphResult.value.sourceDocument || readingSource.active_document
          : readingSource.active_document,
      );
      setParagraphComplete(paragraphResult.status === "fulfilled");
      setParagraphError(
        paragraphResult.status === "rejected"
          ? messageOf(paragraphResult.reason)
          : "",
      );
      updateProgressStep("prepare", "completed", tr(
        "论文知识视图已准备",
        "Paper knowledge view ready",
      ));
      if (
        citationResult.status === "rejected"
        || evidenceResult.status === "rejected"
        || overviewResult.status === "rejected"
        || paragraphResult.status === "rejected"
      ) {
        setError(tr(
          "论文已打开，但概述、全文、引用或证据有部分未加载，可稍后重新打开论文重试。",
          "The paper opened, but part of the overview, full text, citations, or evidence could not be loaded. Reopen it later to retry.",
        ));
      }
      setProgressTask(null);
    } catch (reason: unknown) {
      if (isAbortError(reason)) {
        setProgressTask(null);
      } else {
        failProgressTask(messageOf(reason));
      }
    } finally {
      if (activeTaskController.current === controller) {
        activeTaskController.current = null;
        setBusy(false);
      }
    }
  }

  async function fetchCompletePaper(
    schemaId: string,
    signal: AbortSignal,
    onProgress?: (count: number) => void,
  ): Promise<{
    segments: ProvenanceResult["segments"];
    sourceDocument: PaperCard | null;
  }> {
    let activeSchemaId = schemaId;
    let startMarker = 1;
    let merged: ProvenanceResult["segments"] = [];
    let sourceDocument: PaperCard | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await getPaperParagraphs(
        activeSchemaId,
        startMarker,
        signal,
      );
      activeSchemaId = page.source_schema_id || activeSchemaId;
      sourceDocument ||= page.source_document || null;
      merged = mergeParagraphSegments(merged, page.segments);
      onProgress?.(merged.length);
      if (page.complete || page.next_marker == null) {
        return { segments: merged, sourceDocument };
      }
      startMarker = page.next_marker;
    }
    throw new Error(tr(
      "正文超过安全分页上限，已停止继续读取。",
      "The paper exceeded the safe pagination limit.",
    ));
  }

  async function loadCompletePaper(schemaId: string) {
    paragraphController.current?.abort();
    const controller = new AbortController();
    paragraphController.current = controller;
    setParagraphLoading(true);
    setParagraphError("");
    setParagraphComplete(false);
    setPaperParagraphs([]);
    setParagraphSourceDocument(null);
    try {
      const result = await fetchCompletePaper(schemaId, controller.signal);
      if (paragraphController.current !== controller) return;
      setPaperParagraphs(result.segments);
      setParagraphSourceDocument(result.sourceDocument);
      setParagraphComplete(true);
    } catch (reason: unknown) {
      if (!isAbortError(reason) && paragraphController.current === controller) {
        setParagraphError(messageOf(reason));
      }
    } finally {
      if (paragraphController.current === controller) {
        paragraphController.current = null;
        setParagraphLoading(false);
      }
    }
  }

  function openReaderPanel() {
    setReaderOpen(true);
    const schemaId = graph?.nodes.find((node) => node.node_type === "paper")?.schema_id;
    if (schemaId && !paragraphLoading && !paragraphComplete) {
      void loadCompletePaper(schemaId);
    }
  }

  async function openPaperNode(node: GraphNode) {
    setSelectedNode(node);
    setSelectedEdge(null);
    setInspectorOpen(false);
    if (node.node_type !== "entity" && node.node_type !== "reference") {
      setInspectorOpen(true);
      return;
    }
    const entityNodes = graph?.nodes.filter((item) => (
      item.node_type === "entity" || item.node_type === "reference"
    )) || [];
    const entityIndex = Math.max(
      0,
      entityNodes.findIndex((item) => item.id === node.id),
    );
    setReaderSource({
      kind: "entity",
      label: node.label,
      displayId: `E${String(entityIndex + 1).padStart(2, "0")}`,
      schemaId: node.schema_id,
    });
    setReaderOpen(true);
    setReaderLoading(true);
    setReaderError("");
    setReaderResult(null);
    readerController.current?.abort();
    const controller = new AbortController();
    readerController.current = controller;
    try {
      const anchors = node.anchors || [];
      const paragraphIds = anchors
        .map((anchor) => anchor.paragraph_id)
        .filter((value): value is string => Boolean(value));
      const markerNums = anchors
        .filter((anchor) => !anchor.paragraph_id)
        .map((anchor) => anchor.marker_num)
        .filter((value): value is number => typeof value === "number");
      const requests: Promise<ProvenanceResult>[] = [];
      if (paragraphIds.length) {
        requests.push(resolveEvidence(
          node.schema_id,
          [],
          paragraphIds,
          controller.signal,
        ));
      }
      if (markerNums.length) {
        requests.push(resolveEvidence(
          node.schema_id,
          markerNums,
          [],
          controller.signal,
        ));
      }
      let result = requests.length
        ? mergeProvenanceResults(await Promise.all(requests))
        : await searchPaperContext(node.schema_id, node.label, controller.signal);
      if (!result.returned && requests.length) {
        result = await searchPaperContext(
          node.schema_id,
          node.label,
          controller.signal,
        );
      }
      if (
        !result.returned
        && node.description
        && node.description !== node.label
      ) {
        result = await searchPaperContext(
          node.schema_id,
          node.description.slice(0, 500),
          controller.signal,
        );
      }
      if (!result.returned) {
        const paperTitle = graph?.nodes.find((item) => (
          item.node_type === "paper"
        ))?.paper?.title || graph?.title || "";
        const broadQuery = broadPaperContextQuery(paperTitle);
        if (broadQuery) {
          result = await searchPaperContext(
            node.schema_id,
            broadQuery,
            controller.signal,
          );
        }
      }
      if (readerController.current === controller) {
        setReaderResult(result);
        if (!paragraphLoading && !paragraphComplete) {
          void loadCompletePaper(node.schema_id);
        }
      }
    } catch (reason: unknown) {
      if (!isAbortError(reason) && readerController.current === controller) {
        setReaderError(messageOf(reason));
      }
    } finally {
      if (readerController.current === controller) {
        readerController.current = null;
        setReaderLoading(false);
      }
    }
  }

  async function traceEvidence(item: EvidenceItem) {
    setSelectedEvidence(item);
    const evidenceIndex = Math.max(
      0,
      evidence.findIndex((value) => value.evidence_id === item.evidence_id),
    );
    setReaderSource({
      kind: "evidence",
      label: evidenceLabel(item, tr),
      displayId: `EV${String(evidenceIndex + 1).padStart(2, "0")}`,
      schemaId: item.schema_id,
    });
    setReaderOpen(true);
    setReaderLoading(true);
    setReaderError("");
    setReaderResult(null);
    readerController.current?.abort();
    const controller = new AbortController();
    readerController.current = controller;
    try {
      let result = item.marker_nums.length || item.paragraph_ids.length
        ? await resolveEvidence(
          item.schema_id,
          item.marker_nums,
          item.paragraph_ids,
          controller.signal,
        )
        : await searchPaperContext(
          item.schema_id,
          item.key || item.value_text || item.path || item.groups.join(" "),
          controller.signal,
        );
      if (
        !result.returned
        && (item.marker_nums.length || item.paragraph_ids.length)
      ) {
        result = await searchPaperContext(
          item.schema_id,
          item.key || item.value_text || item.path || item.groups.join(" "),
          controller.signal,
        );
      }
      if (readerController.current === controller) {
        setProvenance(result);
        setReaderResult(result);
        if (!paragraphLoading && !paragraphComplete) {
          void loadCompletePaper(item.schema_id);
        }
      }
    } catch (reason: unknown) {
      if (!isAbortError(reason) && readerController.current === controller) {
        setReaderError(messageOf(reason));
      }
    } finally {
      if (readerController.current === controller) {
        readerController.current = null;
        setReaderLoading(false);
      }
    }
  }

  function goOverview() {
    levelHistory.current = [];
    setActivePaper(null);
    setCanonicalPaper(null);
    setPaperOverview(null);
    setOverviewView("cards");
    if (discoveryGraph) {
      setGraph(discoveryGraph);
      setSelectedNode(discoveryGraph.nodes.find((node) => node.node_type === "paper") || null);
    }
    setMode("overview");
    setInspectorOpen(false);
    setSelectedEdge(null);
    setPaperPanel("guide");
  }

  function goBack() {
    const previous = levelHistory.current.pop();
    if (previous) {
      setActivePaper(previous.activePaper);
      setCanonicalPaper(previous.canonicalPaper);
      setPaperOverview(previous.paperOverview);
      setCitations(previous.citations);
      setEvidence(previous.evidence);
      setGraph(previous.graph);
      setInspectorOpen(previous.inspectorOpen);
      setMode(previous.mode);
      setOverviewView(previous.overviewView);
      setPaperPanel(previous.paperPanel);
      setPaperView(previous.paperView);
      setProvenance(previous.provenance);
      setResearchView(previous.researchView);
      setSelectedEdge(previous.selectedEdge);
      setSelectedEvidence(previous.selectedEvidence);
      setSelectedNode(previous.selectedNode);
      return;
    }
    goOverview();
  }

  function levelBackLabel() {
    if (mode === "research") {
      return tr("返回知识发现", "Back to discovery");
    }
    const previous = levelHistory.current[levelHistory.current.length - 1];
    if (previous?.mode === "paper") {
      return tr("返回上一论文", "Back to previous paper");
    }
    if (previous?.mode === "research") {
      return tr("返回主题结果", "Back to topic results");
    }
    return tr("返回知识发现", "Back to discovery");
  }

  function openSettings() {
    if (mode !== "settings") {
      returnMode.current = mode;
    }
    setMode("settings");
    setInspectorOpen(false);
  }

  function closeSettings() {
    setMode(returnMode.current);
  }

  function exportGraph() {
    if (!graph) return;
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${graph.graph_id.replace(/[^a-z0-9_-]+/gi, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function startOverviewSidebarResize(event: PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 820) return;
    if (!Number.isFinite(event.clientX)) return;
    event.preventDefault();
    sidebarResizeOrigin.current = {
      pointerX: event.clientX,
      width: overviewSidebarWidth,
    };
    setResizingOverviewSidebar(true);
  }

  function resizeOverviewSidebarWithKeyboard(
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -16 : 16;
      setOverviewSidebarWidth((width) => clampOverviewSidebarWidth(width + delta));
    } else if (event.key === "Home") {
      event.preventDefault();
      setOverviewSidebarWidth(DEFAULT_OVERVIEW_SIDEBAR_WIDTH);
    }
  }

  function startWorkspacePaneResize(
    pane: "research" | "guide" | "reader",
    event: PointerEvent<HTMLDivElement>,
  ) {
    if (window.innerWidth <= 820) return;
    if (!Number.isFinite(event.clientX)) return;
    event.preventDefault();
    paneResizeOrigin.current = {
      pointerX: event.clientX,
      width: pane === "research"
        ? researchGuideWidth
        : pane === "guide"
          ? paperGuideWidth
          : evidenceReaderWidth,
    };
    setActivePaneResize(pane);
  }

  function resizeWorkspacePaneWithKeyboard(
    pane: "research" | "guide" | "reader",
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      if (pane === "research") {
        setResearchGuideWidth((width) => clampResearchGuideWidth(
          width + direction * 16,
        ));
      } else if (pane === "guide") {
        setPaperGuideWidth((width) => clampPaperGuideWidth(width + direction * 16));
      } else {
        setEvidenceReaderWidth((width) => clampEvidenceReaderWidth(
          width - direction * 16,
        ));
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      if (pane === "research") {
        setResearchGuideWidth(DEFAULT_RESEARCH_GUIDE_WIDTH);
      } else if (pane === "guide") {
        setPaperGuideWidth(DEFAULT_PAPER_GUIDE_WIDTH);
      } else {
        setEvidenceReaderWidth(DEFAULT_EVIDENCE_READER_WIDTH);
      }
    }
  }

  const graphTitle = inlineScientificText(
    mode === "paper"
      ? selectedPaper?.title || graph?.title || ""
      : activeQuery || graph?.title || tr("知识发现图谱", "Knowledge Discovery Map"),
  );
  const filteredOverviewGraph = useMemo(
    () => graph
      ? filterGraphByVisibility(graph, visibleNodeTypes, visibleEdgeTypes)
      : null,
    [graph, visibleEdgeTypes, visibleNodeTypes],
  );

  return (
    <div
      className={`frontier-app mode-${mode} ${sidebarOpen ? "" : "sidebar-collapsed"} ${inspectorOpen ? "inspector-visible" : ""} ${resizingOverviewSidebar ? "is-resizing-sidebar" : ""}`}
      style={{
        "--overview-sidebar-width": `${overviewSidebarWidth}px`,
        "--research-guide-width": `${researchGuideWidth}px`,
        "--paper-guide-width": `${paperGuideWidth}px`,
        "--evidence-reader-width": `${evidenceReaderWidth}px`,
      } as CSSProperties}
    >
      {mode === "overview" ? (
        <div className="overview-sidebar-shell">
          <OverviewSidebar
            graph={graph}
            query={query}
            setQuery={setQuery}
            submitQuestion={submitQuestion}
            askExample={askExample}
            busy={busy}
            capabilities={capabilities}
            configured={Boolean(sciverseStatus?.configured)}
            openSettings={openSettings}
            overviewView={overviewView}
            visibleNodeTypes={visibleNodeTypes}
            visibleEdgeTypes={visibleEdgeTypes}
            toggleNodeType={(type) => setVisibleNodeTypes((current) => ({
              ...current,
              [type]: !current[type],
            }))}
            toggleEdgeType={(type) => setVisibleEdgeTypes((current) => ({
              ...current,
              [type]: !current[type],
            }))}
          />
          <div
            className="overview-sidebar-resizer"
            role="separator"
            aria-label={tr("调整侧边栏宽度", "Resize sidebar")}
            aria-orientation="vertical"
            aria-valuemin={MIN_OVERVIEW_SIDEBAR_WIDTH}
            aria-valuemax={MAX_OVERVIEW_SIDEBAR_WIDTH}
            aria-valuenow={overviewSidebarWidth}
            tabIndex={0}
            title={tr(
              "拖动调整宽度，双击恢复默认",
              "Drag to resize; double-click to reset",
            )}
            onPointerDown={startOverviewSidebarResize}
            onKeyDown={resizeOverviewSidebarWithKeyboard}
            onDoubleClick={() => setOverviewSidebarWidth(DEFAULT_OVERVIEW_SIDEBAR_WIDTH)}
          />
        </div>
      ) : null}

      <main className="frontier-main">
        <header className="stage-toolbar">
          <div className="stage-heading">
            <div>
              <h1>{mode === "overview" ? tr("知识发现图谱", "Knowledge Discovery Map") : mode === "paper" ? tr("论文阅读", "Paper Reading") : mode === "settings" ? tr("本地连接设置", "Local Connection Settings") : tr("主题研究", "Topic Research")}</h1>
              <p>
                {mode === "settings"
                  ? tr("连接 Sciverse 线上数据，并可选配置导读模型", "Connect Sciverse online data and optionally configure a guide model")
                  : mode === "overview"
                  ? tr(
                    `${capabilities?.coverage.paper_count || "100万+"} 篇已完成 Schema 抽取的 AI 论文 · 从问题构建有限图谱`,
                    `${capabilities?.coverage.paper_count || "1M+"} AI papers with completed Schema extraction · Build a bounded graph from a question`,
                  )
                  : tr(
                    `${graphTitle} · ${graph?.nodes.length || 0} 个节点 · ${graph?.edges.length || 0} 条边`,
                    `${graphTitle} · ${graph?.nodes.length || 0} nodes · ${graph?.edges.length || 0} edges`,
                  )}
              </p>
            </div>
          </div>
          <div className="toolbar-actions">
            <button
              className="language-button"
              type="button"
              onClick={() => changeLanguage(language === "zh" ? "en" : "zh")}
              title={language === "zh" ? "Switch to English" : "切换到中文"}
              aria-label={language === "zh" ? "Switch to English" : "切换到中文"}
            >
              <Globe size={16} />
              <span>{language === "zh" ? "EN" : "中"}</span>
            </button>
            {mode === "settings" ? <button className="text-button" type="button" onClick={closeSettings}><ArrowLeft size={15} /> {tr("返回", "Back")}</button> : null}
            {mode !== "overview" && mode !== "settings" ? <button className="text-button" type="button" onClick={goOverview}>{tr("发现首页", "Discovery Home")}</button> : null}
            {mode !== "settings" ? <button className="icon-button" type="button" onClick={openSettings} title={tr("连接设置", "Connection settings")}><Settings2 size={18} /></button> : null}
            {mode !== "settings" ? <button className="icon-button" type="button" onClick={() => activeCanvasRef.current?.fit()} title={cardViewActive ? tr("适应卡片", "Fit cards") : tr("适应图谱", "Fit graph")}><Focus size={18} /></button> : null}
            {mode !== "settings" ? <button className="icon-button" type="button" onClick={() => activeCanvasRef.current?.zoomIn()} title={tr("放大", "Zoom in")}><ZoomIn size={18} /></button> : null}
            {mode !== "settings" ? <button className="icon-button" type="button" onClick={() => activeCanvasRef.current?.zoomOut()} title={tr("缩小", "Zoom out")}><ZoomOut size={18} /></button> : null}
          </div>
        </header>

        {error ? <div className="error-banner"><CircleHelp size={17} /><span>{error}</span><button type="button" onClick={() => setError("")}><X size={16} /></button></div> : null}

        {mode === "overview" ? (
          <OverviewStage
            graph={graph}
            filteredGraph={filteredOverviewGraph}
            graphRef={graphRef}
            cardRef={cardRef}
            selectNode={selectNode}
            selectEdge={selectEdge}
            capabilities={capabilities}
            busy={busy}
            configured={Boolean(sciverseStatus?.configured)}
            openSettings={openSettings}
            overviewView={overviewView}
            setOverviewView={setOverviewView}
            openPaper={openPaper}
          />
        ) : null}

        {mode === "research" && graph ? (
          <ResearchWorkspace
            graph={graph}
            guide={guide}
            queryPlan={queryPlan}
            activeQuery={activeQuery}
            researchView={researchView}
            setResearchView={setResearchView}
            graphRef={graphRef}
            cardRef={cardRef}
            selectNode={selectNode}
            selectEdge={selectEdge}
            openPaper={openPaper}
            exportGraph={exportGraph}
            busy={busy}
            sidebarOpen={sidebarOpen}
            toggleSidebar={() => setSidebarOpen((value) => !value)}
            startPaneResize={startWorkspacePaneResize}
            resizePaneWithKeyboard={resizeWorkspacePaneWithKeyboard}
            resetPaneWidth={() => setResearchGuideWidth(
              DEFAULT_RESEARCH_GUIDE_WIDTH,
            )}
            paneWidth={researchGuideWidth}
            onLevelBack={goBack}
            levelBackLabel={levelBackLabel()}
          />
        ) : null}

        {mode === "paper" && graph ? (
          <PaperWorkspace
            graph={graph}
            citations={citations}
            evidence={evidence}
            selectedEvidence={selectedEvidence}
            provenance={provenance}
            paperPanel={paperPanel}
            setPaperPanel={setPaperPanel}
            paperView={paperView}
            setPaperView={setPaperView}
            graphRef={graphRef}
            cardRef={cardRef}
            selectNode={openPaperNode}
            selectEdge={selectEdge}
            openPaper={openPaper}
            traceEvidence={traceEvidence}
            exportGraph={exportGraph}
            busy={busy}
            sidebarOpen={sidebarOpen}
            toggleSidebar={() => setSidebarOpen((value) => !value)}
            readerOpen={readerOpen}
            openReader={openReaderPanel}
            closeReader={() => {
              readerController.current?.abort();
              setReaderOpen(false);
            }}
            readerSource={readerSource}
            readerResult={readerResult}
            readerLoading={readerLoading}
            readerError={readerError}
            paperParagraphs={paperParagraphs}
            paragraphLoading={paragraphLoading}
            paragraphError={paragraphError}
            paragraphComplete={paragraphComplete}
            canonicalPaper={canonicalPaper}
            paperOverview={paperOverview}
            paperOverviewLoading={paperOverviewLoading}
            paragraphSourceDocument={paragraphSourceDocument || activePaper}
            startPaneResize={startWorkspacePaneResize}
            resizePaneWithKeyboard={resizeWorkspacePaneWithKeyboard}
            resetPaneWidth={(pane) => {
              if (pane === "guide") {
                setPaperGuideWidth(DEFAULT_PAPER_GUIDE_WIDTH);
              } else {
                setEvidenceReaderWidth(DEFAULT_EVIDENCE_READER_WIDTH);
              }
            }}
            onLevelBack={goBack}
            levelBackLabel={levelBackLabel()}
          />
        ) : null}

        {mode === "settings" ? (
          <LocalSettingsPage onSciverseChanged={applySciverseStatus} />
        ) : null}
      </main>

      {inspectorOpen ? (
        <Inspector
          node={selectedNode}
          edge={selectedEdge}
          onClose={() => setInspectorOpen(false)}
          onOpenPaper={openPaper}
        />
      ) : null}

      {progressTask ? (
        <TaskProgressOverlay
          task={progressTask}
          onCancel={cancelProgressTask}
          onRetry={progressTask.error
            ? () => retryTask.current?.()
            : undefined}
        />
      ) : null}
    </div>
  );
}

function TaskProgressOverlay({ task, onCancel, onRetry }: {
  task: ProgressTaskState;
  onCancel: () => void;
  onRetry?: () => void;
}) {
  const { tr } = useI18n();
  const [elapsedSeconds, setElapsedSeconds] = useState(
    Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)),
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(
        0,
        Math.floor((Date.now() - task.startedAt) / 1000),
      ));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [task.startedAt]);

  const completed = task.steps.filter((step) => step.status === "completed").length;
  const progress = Math.round((completed / task.steps.length) * 100);
  const labels = task.kind === "exploration"
    ? {
      understand: tr("理解研究问题", "Understand the research question"),
      keywords: tr("生成英文检索关键词", "Generate English search queries"),
      papers: tr("查询 Sciverse 论文", "Search Sciverse papers"),
      expansion: tr("扩展论文结构信息", "Expand paper structure"),
      graph: tr("组装主题图谱", "Assemble the topic graph"),
      guide: tr(
        "基于 Schema 生成研究导读",
        "Generate a Schema-grounded research guide",
      ),
    }
    : {
      metadata: tr("获取论文元数据", "Load paper metadata"),
      overview: tr(
        "基于 Schema 生成论文概述",
        "Generate a Schema-grounded paper overview",
      ),
      structure: tr("加载 Entity 与文内关系", "Load Entities and internal relations"),
      fulltext: tr("加载并拼接全文段落", "Load and assemble full-text paragraphs"),
      citations: tr("加载引用概况", "Load citation coverage"),
      evidence: tr("加载证据摘要", "Load evidence summary"),
      prepare: tr("准备论文知识视图", "Prepare the paper knowledge view"),
    };
  return (
    <div className="task-progress-backdrop" role="presentation">
      <section
        className="task-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-progress-title"
      >
        <header>
          <LoaderCircle className="task-spinner" size={26} />
          <div>
            <h2 id="task-progress-title">{task.kind === "exploration"
              ? tr("正在探索研究主题", "Exploring the research topic")
              : tr("正在打开论文结构", "Opening the paper structure")}</h2>
            <p>{task.kind === "exploration"
              ? tr("正在从 Sciverse 检索并组织相关论文", "Retrieving and organizing related papers from Sciverse")
              : task.subject}</p>
          </div>
        </header>
        <div
          className="task-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <ol className="task-progress-steps">
          {task.steps.map((step, index) => (
            <li className={`status-${step.status}`} key={step.id}>
              <span className="task-step-icon">
                {step.status === "completed" ? <Check size={14} />
                  : step.status === "running" ? <LoaderCircle size={15} />
                  : step.status === "failed" ? <X size={14} />
                  : null}
              </span>
              <div>
                <strong>{index + 1}. {labels[step.id as keyof typeof labels]}</strong>
                {step.summary ? <small>{step.summary}</small> : null}
              </div>
              <time>
                {step.status === "running" && step.startedAt
                  ? `${Math.max(0, Math.floor((Date.now() - step.startedAt) / 1000))}s`
                  : step.elapsedMs != null
                    ? `${Math.max(0.1, step.elapsedMs / 1000).toFixed(1)}s`
                    : ""}
              </time>
            </li>
          ))}
        </ol>
        <footer>
          <span>{tr(`已用时 ${elapsedSeconds} 秒`, `${elapsedSeconds}s elapsed`)}</span>
          <div>
            {onRetry ? (
              <button type="button" className="task-retry-button" onClick={onRetry}>
                <RotateCcw size={15} /> {tr("重试", "Retry")}
              </button>
            ) : null}
            <button type="button" className="task-cancel-button" onClick={onCancel}>
              <X size={15} /> {tr("取消", "Cancel")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

interface OverviewSidebarProps {
  graph: GraphPayload | null;
  query: string;
  setQuery: (value: string) => void;
  submitQuestion: (event: FormEvent) => void;
  askExample: (value: string) => void;
  busy: boolean;
  capabilities: Capabilities | null;
  configured: boolean;
  openSettings: () => void;
  overviewView: OverviewView;
  visibleNodeTypes: Readonly<Record<string, boolean>>;
  visibleEdgeTypes: Readonly<Record<EdgeType, boolean>>;
  toggleNodeType: (type: string) => void;
  toggleEdgeType: (type: EdgeType) => void;
}

export function OverviewSidebar(props: OverviewSidebarProps) {
  const {
    graph,
    query,
    setQuery,
    submitQuestion,
    askExample,
    busy,
    capabilities,
    configured,
    openSettings,
    overviewView,
    visibleNodeTypes,
    visibleEdgeTypes,
    toggleNodeType,
    toggleEdgeType,
  } = props;
  const { language, tr } = useI18n();
  return (
    <aside className="overview-sidebar">
      <div className="brand">
        <span className="brand-mark"><img src="/frontierlens-icon.png?v=3" alt="" /></span>
        <div><strong>FrontierLens</strong><p>{tr("看见、理解并探索 AI 研究前沿。", "See, understand, and explore the frontiers of AI.")}</p></div>
      </div>
      <div className="stats-grid">
        <Stat value={capabilities?.coverage.paper_count || "1M+"} label={tr("Schema 论文", "Schema papers")} />
        <Stat value={graph?.edges.length || 0} label={tr("会话关系", "Session edges")} />
        <Stat value={graph?.nodes.length || 0} label={tr("可见节点", "Visible nodes")} />
        <Stat value={graph?.stats.citations || 0} label={tr("已解析引用", "Resolved citations")} />
      </div>
      <section className="sidebar-section">
        <label className="sidebar-label" htmlFor="question">{tr("研究问题", "Research Question")}</label>
        <form id="research-form" className="question-form" onSubmit={submitQuestion}>
          <textarea id="question" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("输入 AI 研究问题，或选择下方示例", "Enter an AI research question or choose an example")} rows={3} />
          <button type="submit" disabled={busy || !query.trim() || !configured}>{busy ? tr("构建中", "Building") : tr("探索", "Explore")}</button>
        </form>
        <div className="example-list">
          {EXAMPLES[language].map((example, index) => (
            <button type="button" key={example} disabled={!configured} onClick={() => askExample(example)}>
              <span>{String(index + 1).padStart(2, "0")}</span><strong>{example}</strong>
            </button>
          ))}
        </div>
      </section>
      {overviewView === "graph" ? (
        <>
          <section className="sidebar-section filter-section">
            <h2>{tr("节点类型", "Node Types")}</h2>
            {ENTITY_TYPES.map((item) => {
              const checked = visibleNodeTypes[item.key] !== false;
              return (
                <label
                  className={`filter-row ${checked ? "" : "is-filtered-out"}`}
                  key={item.key}
                >
                  <input
                    type="checkbox"
                    aria-label={tr(item.zh, item.en)}
                    checked={checked}
                    onChange={() => toggleNodeType(item.key)}
                  />
                  <i style={{ background: item.color }} />
                  <strong>{tr(item.zh, item.en)}</strong>
                  <span>{countType(graph, item.key)}</span>
                </label>
              );
            })}
          </section>
          <section className="sidebar-section filter-section">
            <h2>{tr("关系类型", "Edge Types")}</h2>
            {EDGE_TYPES.map((item) => {
              const checked = visibleEdgeTypes[item.key] !== false;
              return (
                <label
                  className={`filter-row ${checked ? "" : "is-filtered-out"}`}
                  key={item.key}
                >
                  <input
                    type="checkbox"
                    aria-label={tr(item.zh, item.en)}
                    checked={checked}
                    onChange={() => toggleEdgeType(item.key)}
                  />
                  <i className={item.dotClass} />
                  <strong>{tr(item.zh, item.en)}</strong>
                  <span>{countEdgeType(graph, item.key)}</span>
                </label>
              );
            })}
          </section>
        </>
      ) : null}
      <button className="sidebar-settings" type="button" onClick={openSettings}>
        <Settings2 size={16} /><span><strong>{tr("连接设置", "Connection settings")}</strong><small>{configured ? tr("Sciverse 线上数据已连接", "Sciverse online data connected") : tr("需要配置 Sciverse Key", "Sciverse key required")}</small></span>
      </button>
    </aside>
  );
}

function OverviewStage({ graph, filteredGraph, graphRef, cardRef, selectNode, selectEdge, capabilities, busy, configured, openSettings, overviewView, setOverviewView, openPaper }: {
  graph: GraphPayload | null;
  filteredGraph: GraphPayload | null;
  graphRef: React.RefObject<GraphCanvasHandle | null>;
  cardRef: React.RefObject<GraphCanvasHandle | null>;
  selectNode: (node: GraphNode) => void;
  selectEdge: (edge: GraphEdge) => void;
  capabilities: Capabilities | null;
  busy: boolean;
  configured: boolean;
  openSettings: () => void;
  overviewView: OverviewView;
  setOverviewView: (view: OverviewView) => void;
  openPaper: (schemaId: string) => void;
}) {
  const { tr } = useI18n();
  return (
    <section className={`overview-stage graph-grid-bg ${busy ? "is-busy" : ""}`}>
      <div className="scope-banner">
        <span><Sparkles size={15} /> Sciverse Paper Schema</span>
        <strong>{tr("问题范围内探索", "Query-scoped exploration")}</strong>
        <p>{tr(
          "已完成 Paper Schema 抽取的 AI 会议论文",
          capabilities?.coverage.current_focus || "AI conference papers with completed extraction",
        )}</p>
        {graph ? (
          <div className="segmented overview-view-tabs">
            <button type="button" className={overviewView === "cards" ? "active" : ""} onClick={() => setOverviewView("cards")}>{tr("卡片浏览", "Card View")}</button>
            <button type="button" className={overviewView === "graph" ? "active" : ""} onClick={() => setOverviewView("graph")}>{tr("关系图谱", "Relationship Graph")}</button>
          </div>
        ) : null}
      </div>
      {graph ? (
        overviewView === "cards"
          ? <DiscoveryBoard ref={cardRef} graph={graph} onOpenPaper={openPaper} />
          : <GraphCanvas ref={graphRef} graph={filteredGraph || graph} variant="overview" onSelectNode={selectNode} onSelectEdge={selectEdge} />
      ) : configured ? (
        <div className="loading-map">{tr("正在从 Sciverse 加载发现图谱", "Loading the discovery map from Sciverse")}</div>
      ) : (
        <div className="connection-required">
          <Settings2 size={26} />
          <h2>{tr("连接 Sciverse 后开始探索", "Connect Sciverse to start exploring")}</h2>
          <p>{tr(
            "本应用不使用任何本地论文或演示数据。配置 API Key 后，论文、Entity、Relation、Citation 和 Evidence 均从 Sciverse 线上获取。",
            "This app uses no local paper or demo data. After configuration, papers, Entities, Relations, Citations, and Evidence are fetched from Sciverse online.",
          )}</p>
          <button type="button" onClick={openSettings}>{tr("打开连接设置", "Open connection settings")}</button>
        </div>
      )}
      <div className="overview-footnote">{tr(
        "所有图谱事实均来自当前 Sciverse Paper Schema 线上语料，应用不会使用本地论文数据补齐结果。",
        "All graph facts come from the live Sciverse Paper Schema corpus; the app never fills results with local paper data.",
      )}</div>
    </section>
  );
}

function ResearchWorkspace({ graph, guide, queryPlan, activeQuery, researchView, setResearchView, graphRef, cardRef, selectNode, selectEdge, openPaper, exportGraph, busy, sidebarOpen, toggleSidebar, startPaneResize, resizePaneWithKeyboard, resetPaneWidth, paneWidth, onLevelBack, levelBackLabel }: {
  graph: GraphPayload;
  guide: ReadingGuide | null;
  queryPlan: QueryPlan | null;
  activeQuery: string;
  researchView: ResearchView;
  setResearchView: (view: ResearchView) => void;
  graphRef: React.RefObject<GraphCanvasHandle | null>;
  cardRef: React.RefObject<GraphCanvasHandle | null>;
  selectNode: (node: GraphNode) => void;
  selectEdge: (edge: GraphEdge) => void;
  openPaper: (schemaId: string) => void;
  exportGraph: () => void;
  busy: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  startPaneResize: (
    pane: "research",
    event: PointerEvent<HTMLDivElement>,
  ) => void;
  resizePaneWithKeyboard: (
    pane: "research",
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  resetPaneWidth: () => void;
  paneWidth: number;
  onLevelBack: () => void;
  levelBackLabel: string;
}) {
  const { tr } = useI18n();
  const fallbackGuide: ReadingGuide = guide || {
    query: activeQuery,
    title: tr(`${activeQuery} 的阅读路径`, `Reading path for ${activeQuery}`),
    summary: tr(
      "先阅读检索到的种子论文，再沿已解析引用和相关建议扩展。",
      "Start with the retrieved seed papers, then expand through resolved citations and related suggestions.",
    ),
    items: [],
    scope_note: "",
    caveats: [],
    generation_mode: "deterministic",
  };
  const papers = graph.nodes.filter((node) => node.node_type === "paper");
  return (
    <section className={`research-workspace ${sidebarOpen ? "" : "guide-hidden"} ${busy ? "is-busy" : ""}`}>
      <aside className="guide-pane">
        <article className="question-card">
          <span>{tr("研究问题", "Research question")}</span><h2>{activeQuery}</h2>
          <p>{tr(
            `关联子图 · ${graph.nodes.length} 个节点 · ${graph.edges.length} 条边`,
            `Related subgraph · ${graph.nodes.length} nodes · ${graph.edges.length} edges`,
          )}</p>
          {queryPlan && queryPlan.rewrite_source !== "none" ? (
            <div className="query-plan">
              <small>{queryPlan.rewrite_source === "model" ? tr("模型检索规划", "Model query plan") : tr("本地词表", "Local glossary")}</small>
              <strong>{queryPlan.search_queries.join(" · ")}</strong>
            </div>
          ) : null}
        </article>
        <article className="guide-summary">
          <header><h2>{tr("研究导读", "Research Guide")}</h2><span><Check size={13} /> {fallbackGuide.generation_mode === "model" ? tr("模型增强", "Model enhanced") : tr("规则生成", "Rule based")}</span></header>
          <div className="guide-metrics">
            <div><small>{tr("检索节点", "Retrieved nodes")}</small><strong>{graph.nodes.length}</strong></div>
            <div><small>{tr("导读论文", "Guide papers")}</small><strong>{fallbackGuide.items.length || papers.length}</strong></div>
          </div>
          <p>{fallbackGuide.scope_note || tr("基于当前会话图谱生成的确定性阅读路径。", "A deterministic reading path grounded in the current session graph.")}</p>
        </article>
        <article className="guide-judgement topic-narrative">
          <span>I</span>
          <div>
            <h3>{fallbackGuide.generation_mode === "model"
              ? tr("主题关系与演化概述", "Topic relationships and evolution")
              : tr("主题关系概述", "Topic relationship overview")}</h3>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {fallbackGuide.summary}
            </ReactMarkdown>
            {fallbackGuide.model_warning ? (
              <small>{fallbackGuide.model_warning}</small>
            ) : null}
          </div>
        </article>
        <section className="guide-section">
          <h3>{tr("建议阅读顺序", "Suggested reading order")}</h3>
          {(fallbackGuide.items.length ? fallbackGuide.items : papers.map((node, index) => ({ order: index + 1, schema_id: node.schema_id, title: node.label, role: "seed" as const, rationale: node.subtitle || tr("主题论文", "Topic paper") }))).map((item) => (
            <button type="button" className="guide-paper" key={`${item.order}-${item.schema_id}`} onClick={() => openPaper(item.schema_id)}>
              <span>{String(item.order).padStart(2, "0")}</span><div><strong>{inlineScientificText(item.title)}</strong><p>{item.rationale}</p></div><ChevronRight size={16} />
            </button>
          ))}
        </section>
        <section className="guide-section">
          <h3>{tr("关系口径", "Relation semantics")}</h3>
          <p>{tr(
            "Internal Relation 是论文内部 Entity 之间的抽取事实；Citation 是论文之间已解析的引用；虚线仅表示有解释的相关建议。",
            "Internal Relation is an extracted fact between Entities inside one paper; Citation is a resolved paper-to-paper reference; dashed edges are explained related suggestions only.",
          )}</p>
        </section>
      </aside>
      <div
        className="paper-pane-resizer research-guide-resizer"
        role="separator"
        aria-label={tr("调整主题研究栏宽度", "Resize research guide pane")}
        aria-orientation="vertical"
        aria-valuemin={MIN_RESEARCH_GUIDE_WIDTH}
        aria-valuemax={MAX_RESEARCH_GUIDE_WIDTH}
        aria-valuenow={paneWidth}
        tabIndex={sidebarOpen ? 0 : -1}
        title={tr(
          "拖动调整宽度，双击恢复默认",
          "Drag to resize; double-click to reset",
        )}
        onPointerDown={(event) => sidebarOpen && startPaneResize("research", event)}
        onKeyDown={(event) => sidebarOpen && resizePaneWithKeyboard("research", event)}
        onDoubleClick={resetPaneWidth}
      >
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleSidebar}
          title={sidebarOpen
            ? tr("收起主题导读", "Collapse research guide")
            : tr("展开主题导读", "Expand research guide")}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <section className="research-visual">
        <VisualHeader
          kicker={researchView === "roadmap" ? tr("卡片阅读路径", "Guided card path") : tr("主题关系图谱", "Topic relationship graph")}
          title={fallbackGuide.title}
          graph={graph}
          tabs={[
            { id: "roadmap", label: tr("卡片导读", "Guided Cards") },
            { id: "subgraph", label: tr("关系图谱", "Relationship Graph") },
          ]}
          active={researchView}
          onTab={(id) => setResearchView(id as ResearchView)}
          onExport={exportGraph}
        />
        <div className="visual-body graph-grid-bg">
          <button className="canvas-level-back" type="button" onClick={onLevelBack}><ArrowLeft size={15} /> {levelBackLabel}</button>
          {researchView === "roadmap"
            ? <RoadmapBoard ref={cardRef} guide={fallbackGuide} graph={graph} onOpenPaper={openPaper} />
            : <GraphCanvas ref={graphRef} graph={graph} variant="subgraph" onSelectNode={selectNode} onSelectEdge={selectEdge} />}
        </div>
      </section>
    </section>
  );
}

function PaperWorkspace({ graph, citations, evidence, selectedEvidence, provenance, paperPanel, setPaperPanel, paperView, setPaperView, graphRef, cardRef, selectNode, selectEdge, openPaper, traceEvidence, exportGraph, busy, sidebarOpen, toggleSidebar, readerOpen, openReader, closeReader, readerSource, readerResult, readerLoading, readerError, paperParagraphs, paragraphLoading, paragraphError, paragraphComplete, canonicalPaper, paperOverview, paperOverviewLoading, paragraphSourceDocument, startPaneResize, resizePaneWithKeyboard, resetPaneWidth, onLevelBack, levelBackLabel }: {
  graph: GraphPayload;
  citations: CitationList | null;
  evidence: EvidenceItem[];
  selectedEvidence: EvidenceItem | null;
  provenance: ProvenanceResult | null;
  paperPanel: "guide" | "citations" | "evidence";
  setPaperPanel: (panel: "guide" | "citations" | "evidence") => void;
  paperView: PaperView;
  setPaperView: (view: PaperView) => void;
  graphRef: React.RefObject<GraphCanvasHandle | null>;
  cardRef: React.RefObject<GraphCanvasHandle | null>;
  selectNode: (node: GraphNode) => void;
  selectEdge: (edge: GraphEdge) => void;
  openPaper: (schemaId: string) => void;
  traceEvidence: (item: EvidenceItem) => void;
  exportGraph: () => void;
  busy: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  readerOpen: boolean;
  openReader: () => void;
  closeReader: () => void;
  readerSource: ReaderSource | null;
  readerResult: ProvenanceResult | null;
  readerLoading: boolean;
  readerError: string;
  paperParagraphs: ProvenanceResult["segments"];
  paragraphLoading: boolean;
  paragraphError: string;
  paragraphComplete: boolean;
  canonicalPaper: PaperCard | null;
  paperOverview: PaperOverview | null;
  paperOverviewLoading: boolean;
  paragraphSourceDocument: PaperCard | null;
  startPaneResize: (
    pane: "guide" | "reader",
    event: PointerEvent<HTMLDivElement>,
  ) => void;
  resizePaneWithKeyboard: (
    pane: "guide" | "reader",
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  resetPaneWidth: (pane: "guide" | "reader") => void;
  onLevelBack: () => void;
  levelBackLabel: string;
}) {
  const { tr } = useI18n();
  const root = graph.nodes.find((node) => node.node_type === "paper");
  const paper = canonicalPaper || root?.paper;
  const entities = graph.nodes.filter((node) => node.node_type === "entity");
  const visibleEvidence = evidence.filter(isDisplayableEvidence);
  const resolved = citations?.items.filter((item) => item.resolution.status === "resolved").length || 0;
  return (
    <section className={`paper-workspace ${sidebarOpen ? "" : "guide-hidden"} ${readerOpen ? "reader-visible" : ""} ${busy ? "is-busy" : ""}`}>
      <aside className="paper-guide-pane">
        <article className="paper-guide-summary">
          <header><h2>{tr("阅读导引", "Reading Guide")}</h2><span><Check size={13} /> {tr("Schema 已结构化", "Schema structured")}</span></header>
          <div className="guide-metrics">
            <div><small>{tr("文内图节点", "Internal graph nodes")}</small><strong>{graph.nodes.length}</strong></div>
            <div><small>{tr("导读节点", "Guide nodes")}</small><strong>{Math.min(graph.nodes.length, 28)}</strong></div>
          </div>
          <p>{tr(
            "卡片导读从论文内部图中筛选和组织关键内容；完整 Entity 与 Relation 请切换到关系图谱。",
            "Guided Cards select and organize key content from the paper graph; switch to Relationship Graph for complete Entities and Relations.",
          )}</p>
        </article>
        <article className="paper-overview-card">
          <header>
            <div>
              <span>{tr("先读这一段", "Start here")}</span>
              <h3>{tr("论文概述", "Paper overview")}</h3>
            </div>
            <small>{paperOverviewLoading
              ? tr("生成中", "Generating")
              : paperOverview?.generation_mode === "model"
                ? tr("模型增强", "Model enhanced")
                : tr("元数据概述", "Metadata overview")}</small>
          </header>
          {paperOverviewLoading && !paperOverview ? (
            <p className="paper-overview-loading">
              <LoaderCircle className="task-spinner" size={16} />
              {tr("正在根据当前语言生成概述…", "Generating an overview in the selected language…")}
            </p>
          ) : (
            <>
              <div className="paper-overview-summary">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {paperOverview?.summary || paper?.abstract || tr(
                    "当前元数据不足以生成详细概述。",
                    "The available metadata is insufficient for a detailed overview.",
                  )}
                </ReactMarkdown>
              </div>
              <section>
                <h4>{tr("为什么继续读", "Why continue reading")}</h4>
                <p>{paperOverview?.why_read || tr(
                  "可先核对研究问题、核心贡献和关键结果，再决定是否进入结构图与原文证据。",
                  "Review the problem, contribution, and result before opening the structure graph and source evidence.",
                )}</p>
              </section>
              {paperOverview?.focus_points.length ? (
                <ul>
                  {paperOverview.focus_points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              ) : null}
              <footer>{paperOverview?.model_warning || tr(
                "概述仅使用结构化元数据、Entity 与 Relation；全文不会发送给模型。",
                "The overview uses only structured metadata, Entities, and Relations; full text is never sent to the model.",
              )}</footer>
            </>
          )}
        </article>
        <article className="paper-hero">
          <span>{paper?.year || "Paper"}</span>
          <h2>{inlineScientificText(paper?.title || graph.title)}</h2>
          <p>{paper?.authors.join(", ") || tr("作者信息不可用", "Authors unavailable")}</p>
          <blockquote>{paper?.central_contribution || paper?.abstract || tr("可通过结构化论文 Schema 探索图谱。", "Structured paper schema is available for graph exploration.")}</blockquote>
        </article>
        <nav className="paper-panel-tabs">
          <button className={paperPanel === "guide" ? "active" : ""} type="button" onClick={() => setPaperPanel("guide")}>{tr("导读", "Guide")}</button>
          <button className={paperPanel === "citations" ? "active" : ""} type="button" onClick={() => setPaperPanel("citations")}>{tr("引用", "Citations")} {citations?.total || 0}</button>
          <button className={paperPanel === "evidence" ? "active" : ""} type="button" onClick={() => setPaperPanel("evidence")}>{tr("证据", "Evidence")} {visibleEvidence.length}</button>
        </nav>
        {paperPanel === "guide" ? (
          <>
            <section className="paper-reading-route"><h3>{tr("阅读路线", "Reading route")}</h3><p>{tr(
              "建议沿“研究问题 → 核心方法 → 实验设置 → 关键结论”阅读，并在卡片中选择 Entity 查看详情，或切换到关系图谱检查完整文内关系。",
              "Follow Research problem → Core method → Experiment setup → Key finding. Select an Entity card for details, or switch to Relationship Graph for complete internal relations.",
            )}</p></section>
            {(tr(
              "先理解研究问题与贡献边界|再查看方法、设置与数据|最后核对结果证据与引用",
              "Understand the problem and contribution boundary|Inspect methods, settings, and data|Verify result evidence and citations",
            ).split("|")).map((title, index) => (
              <article className="reading-step" key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{index === 0 ? paper?.research_problem : index === 1 ? paper?.central_contribution : paper?.headline_result}</p></div></article>
            ))}
          </>
        ) : null}
        {paperPanel === "citations" ? (
          <section className="citation-list">
            <div className="citation-coverage"><strong>{resolved} / {citations?.total || 0}</strong><span>{tr("可跳转到 Schema 论文", "Openable Schema papers")}</span></div>
            {citations?.items.map((item) => (
              <button type="button" key={item.relation_id} disabled={!item.target_paper} onClick={() => item.target_paper && openPaper(item.target_paper.schema_id)}>
                <i className={item.resolution.status} />
                <div><strong>{inlineScientificText(item.reference?.title || tr("无标题引用", "Untitled reference"))}</strong><p>{item.reference?.year || "—"} · {item.resolution.status === "resolved" ? tr("已解析，可下钻", "Resolved and openable") : tr("保留完整引用条目，尚未映射", "Complete reference retained; target not mapped")}</p></div>
                {item.target_paper ? <ExternalLink size={14} /> : null}
              </button>
            ))}
          </section>
        ) : null}
        {paperPanel === "evidence" ? (
          <section className="evidence-list">
            {visibleEvidence.map((item) => (
              <button type="button" key={item.evidence_id} className={selectedEvidence?.evidence_id === item.evidence_id ? "active" : ""} onClick={() => traceEvidence(item)}>
                <FileSearch size={16} />
                <div>
                  <strong>{evidenceLabel(item, tr)}</strong>
                  <div className="evidence-card-value">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeKatex]}
                    >
                      {evidenceMarkdown(item, tr)}
                    </ReactMarkdown>
                  </div>
                </div>
              </button>
            ))}
            {selectedEvidence && provenance?.segments.map((segment) => (
              <blockquote key={`${segment.paragraph_id}-${segment.marker_num}`}><span>{segment.section_path || segment.section}</span>{segment.text}</blockquote>
            ))}
          </section>
        ) : null}
      </aside>
      <div
        className="paper-pane-resizer paper-guide-resizer"
        role="separator"
        aria-label={tr("调整论文导读栏宽度", "Resize paper guide pane")}
        aria-orientation="vertical"
        tabIndex={sidebarOpen ? 0 : -1}
        onPointerDown={(event) => sidebarOpen && startPaneResize("guide", event)}
        onKeyDown={(event) => sidebarOpen && resizePaneWithKeyboard("guide", event)}
        onDoubleClick={() => resetPaneWidth("guide")}
      >
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleSidebar}
          title={sidebarOpen
            ? tr("收起论文导读", "Collapse paper guide")
            : tr("展开论文导读", "Expand paper guide")}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <section className="research-visual">
        <VisualHeader
          kicker={paperView === "structure" ? tr("结构化卡片", "Structured cards") : tr("论文实体图谱", "Paper entity graph")}
          title={paper?.title || graph.title}
          graph={graph}
          tabs={[
            { id: "structure", label: tr("卡片导读", "Guided Cards") },
            { id: "internal", label: tr("关系图谱", "Relationship Graph") },
          ]}
          active={paperView}
          onTab={(id) => setPaperView(id as PaperView)}
          onExport={exportGraph}
        />
        <div className="visual-body graph-grid-bg">
          <button className="canvas-level-back" type="button" onClick={onLevelBack}><ArrowLeft size={15} /> {levelBackLabel}</button>
          {!readerOpen ? (
            <button className="canvas-reader-toggle" type="button" onClick={openReader}>
              <BookOpenText size={15} /> {tr("原文证据", "Source evidence")}
            </button>
          ) : null}
          {paperView === "structure"
            ? <StructureBoard ref={cardRef} graph={graph} onSelectNode={selectNode} />
            : <GraphCanvas ref={graphRef} graph={graph} variant="internal" onSelectNode={selectNode} onSelectEdge={selectEdge} />}
        </div>
      </section>
      {readerOpen ? (
        <>
          <div
            className="paper-pane-resizer evidence-reader-resizer"
            role="separator"
            aria-label={tr("调整原文证据栏宽度", "Resize source evidence pane")}
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(event) => startPaneResize("reader", event)}
            onKeyDown={(event) => resizePaneWithKeyboard("reader", event)}
            onDoubleClick={() => resetPaneWidth("reader")}
          />
          <EvidenceReader
            source={readerSource}
            result={readerResult}
            loading={readerLoading}
            error={readerError}
            paragraphs={paperParagraphs}
            paragraphLoading={paragraphLoading}
            paragraphError={paragraphError}
            paragraphComplete={paragraphComplete}
            paper={paper || null}
            sourceDocument={paragraphSourceDocument}
            onClose={closeReader}
          />
        </>
      ) : null}
    </section>
  );
}

function EvidenceReader({ source, result, loading, error, paragraphs, paragraphLoading, paragraphError, paragraphComplete, paper, sourceDocument, onClose }: {
  source: ReaderSource | null;
  result: ProvenanceResult | null;
  loading: boolean;
  error: string;
  paragraphs: ProvenanceResult["segments"];
  paragraphLoading: boolean;
  paragraphError: string;
  paragraphComplete: boolean;
  paper: PaperCard | null;
  sourceDocument: PaperCard | null;
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const segmentRefs = useRef(new Map<string, HTMLElement>());
  const displaySegments = useMemo(
    () => paragraphComplete
      ? paragraphs
      : paragraphError
        ? mergeParagraphSegments(paragraphs, result?.segments || [])
        : [],
    [paragraphComplete, paragraphError, paragraphs, result],
  );
  const targetParagraphIds = useMemo(() => new Set(
    (result?.segments || [])
      .filter((segment) => segment.match_role === "target")
      .map((segment) => segment.paragraph_id)
      .filter((value): value is string => Boolean(value)),
  ), [result]);
  const targetMarkers = useMemo(() => new Set(
    (result?.segments || [])
      .filter((segment) => segment.match_role === "target")
      .map((segment) => segment.marker_num)
      .filter((value): value is number => value != null),
  ), [result]);
  useEffect(() => {
    const target = result?.segments.find((segment) => segment.match_role === "target")
      || result?.segments[0];
    if (!target || !paragraphComplete) return;
    const key = target.paragraph_id || String(target.marker_num ?? target.text);
    window.setTimeout(() => {
      const exact = segmentRefs.current.get(key);
      const marker = target.marker_num != null
        ? segmentRefs.current.get(`marker:${target.marker_num}`)
        : undefined;
      (exact || marker)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 0);
  }, [paragraphComplete, result, displaySegments]);

  const sourceSchemaId = displaySegments[0]?.schema_id;
  const relatedVersion = Boolean(
    source?.schemaId
    && sourceSchemaId
    && source.schemaId !== sourceSchemaId,
  );
  const exactLocation = Boolean(
    result?.returned && result.locator_method === "provenance",
  );
  const textLocation = Boolean(
    result?.returned && result.locator_method === "schema_local_search",
  );
  const pdfDocument = sourceDocument?.pdf_url
    ? sourceDocument
    : paper?.pdf_url
      ? paper
      : null;
  const doiUrl = paper?.doi
    ? paper.external_url || `https://doi.org/${paper.doi}`
    : null;
  return (
    <aside className="evidence-reader" aria-label={tr("原文证据阅读器", "Source evidence reader")}>
      <header>
        <div>
          <span><BookOpenText size={15} /> {tr("原文证据", "Source evidence")}</span>
          <h2>{source?.label || tr("选择 Entity 或 Evidence", "Select an Entity or Evidence item")}</h2>
        </div>
        <button type="button" onClick={onClose} title={tr("收起阅读器", "Close reader")}>
          <PanelRightClose size={17} />
        </button>
      </header>
      {paper?.doi || sourceDocument?.arxiv_id || pdfDocument ? (
        <div className="reader-document-actions">
          <div>
            {paper?.doi ? <span>DOI {paper.doi}</span> : null}
            {sourceDocument?.arxiv_id
              ? <span>arXiv {sourceDocument.arxiv_id}</span>
              : paper?.arxiv_id
                ? <span>arXiv {paper.arxiv_id}</span>
                : null}
          </div>
          <nav>
            {pdfDocument?.pdf_url ? (
              <a href={pdfDocument.pdf_url} target="_blank" rel="noreferrer">
                <Download size={14} /> {tr("打开 PDF", "Open PDF")}
              </a>
            ) : null}
            {doiUrl ? (
              <a href={doiUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> DOI
              </a>
            ) : null}
          </nav>
        </div>
      ) : null}
      {source && (result || displaySegments.length) ? (
        <div className="reader-locator-summary">
          <strong>{source.displayId}</strong>
          <span>{exactLocation
            ? tr("精确 provenance 定位", "Exact provenance location")
            : textLocation
              ? relatedVersion
                ? tr("相关版本文本匹配", "Related-version text match")
                : tr("文本匹配定位", "Text-matched location")
              : relatedVersion
                ? tr("相关版本原文", "Related-version paper text")
                : tr("论文全文", "Paper text")}</span>
        </div>
      ) : null}
      <div className="evidence-reader-body">
        {paragraphLoading && !displaySegments.length ? (
          <div className="reader-state">
            <LoaderCircle className="task-spinner" size={22} />
            <h3>{tr("正在拼接论文全文", "Assembling the full paper")}</h3>
            <p>{tr(
              `已按顺序读取 ${paragraphs.length} 个段落，完成后将一次性渲染。`,
              `${paragraphs.length} paragraphs read in order. The document will render when complete.`,
            )}</p>
          </div>
        ) : null}
        {error && !displaySegments.length ? (
          <div className="reader-state reader-error"><CircleHelp size={22} /><p>{error}</p></div>
        ) : null}
        {!loading && !error && !source && !displaySegments.length && !paragraphLoading ? (
          <div className="reader-state">
            <BookOpenText size={24} />
            <h3>{tr("论文正文", "Paper text")}</h3>
            <p>{tr(
              "正文尚未返回。可以重新打开阅读器，或选择 Entity、图谱节点和 Evidence 定位原文。",
              "No paper text has been returned yet. Reopen the reader, or select an Entity, graph node, or Evidence item to locate its source text.",
            )}</p>
          </div>
        ) : null}
        {!loading && !error && source && result && !result.segments.length && !displaySegments.length ? (
          <div className="reader-state">
            <FileSearch size={23} />
            <h3>{tr("没有找到可显示的原文段落", "No source paragraph was found")}</h3>
            <p>{tr(
              "该结构对象没有精确 provenance，论文内文本匹配也未返回结果。",
              "This item has no exact provenance and schema-local text matching returned no result.",
            )}</p>
          </div>
        ) : null}
        {displaySegments.length ? (
          <article className="paper-document">
            {displaySegments.map((segment, index) => {
          const key = segment.paragraph_id || String(segment.marker_num ?? segment.text);
          const target = (
            (segment.paragraph_id && targetParagraphIds.has(segment.paragraph_id))
            || (segment.marker_num != null && targetMarkers.has(segment.marker_num))
          );
          const section = segment.section_path || segment.section || "";
          const previous = displaySegments[index - 1];
          const previousSection = previous?.section_path || previous?.section || "";
          const showSection = Boolean(section && section !== previousSection);
          return (
            <section
              className={`paper-document-block ${target ? "target" : ""}`}
              key={`${key}-${index}`}
              ref={(element) => {
                if (element) {
                  segmentRefs.current.set(key, element);
                  if (segment.marker_num != null) {
                    segmentRefs.current.set(`marker:${segment.marker_num}`, element);
                  }
                } else {
                  segmentRefs.current.delete(key);
                  if (segment.marker_num != null) {
                    segmentRefs.current.delete(`marker:${segment.marker_num}`);
                  }
                }
              }}
            >
              {showSection ? <h3 className="paper-document-section">{section}</h3> : null}
              {target ? <span className="paper-document-target">{source?.displayId}</span> : null}
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeKatex]}
                components={{
                  a: ({ href, children }) => href?.startsWith("https://")
                    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
                    : <span>{children}</span>,
                  img: ({ src, alt }) => src?.startsWith("https://")
                    ? <img src={src} alt={alt || ""} loading="lazy" />
                    : alt
                      ? <span className="paper-figure-placeholder">{alt}</span>
                      : null,
                }}
              >
                {normalizeScientificMarkdown(segment.text)}
              </ReactMarkdown>
            </section>
          );
            })}
          </article>
        ) : null}
        {loading && displaySegments.length ? (
          <div className="reader-inline-status"><LoaderCircle className="task-spinner" size={15} /> {tr("正在定位结构对象对应段落", "Locating the selected structure item")}</div>
        ) : null}
        {error && displaySegments.length ? (
          <div className="reader-inline-error"><CircleHelp size={16} /><span>{error}</span></div>
        ) : null}
        {paragraphError ? (
          <div className="reader-inline-error"><CircleHelp size={16} /><span>{paragraphError}</span></div>
        ) : null}
        {displaySegments.length && paragraphComplete ? (
          <div className="reader-complete"><Check size={15} /> {tr(
            `全文已按顺序拼接，共 ${displaySegments.length} 个段落`,
            `Full text assembled in order from ${displaySegments.length} paragraphs`,
          )}</div>
        ) : null}
      </div>
      {result?.locator_method === "schema_local_search" ? (
        <footer className="reader-match-note">{tr(
          `未找到精确锚点，当前内容按“${result.query || source?.label}”在本文中匹配。`,
          `No exact anchor was available. These passages were matched in this paper using “${result.query || source?.label}”.`,
        )}</footer>
      ) : null}
      {relatedVersion ? (
        <footer className="reader-match-note">{tr(
          "当前正式版本没有独立 paragraph 数据，正在展示标题和作者高度一致的相关发表版本原文；它可用于阅读，但不冒充当前 Entity 的精确 provenance。",
          "The selected publication has no separate paragraph data. Text from a title- and author-aligned publication version is shown for reading, but is not presented as exact Entity provenance.",
        )}</footer>
      ) : null}
    </aside>
  );
}

function SciverseSettingsForm({ onChanged }: {
  onChanged: (status: SciverseConfigStatus) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [status, setStatus] = useState<SciverseConfigStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.sciverse.space");
  const [apiKey, setApiKey] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(20);
  const [enabled, setEnabled] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    getSciverseConfig()
      .then((next) => {
        setStatus(next);
        setBaseUrl(next.base_url);
        setTimeoutSeconds(next.timeout_seconds);
        setEnabled(next.enabled);
      })
      .catch((reason: unknown) => setFailure(messageOf(reason)));
  }, []);

  async function persist(clearApiKey: boolean) {
    const next = await updateSciverseConfig({
      enabled,
      base_url: baseUrl.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      clear_api_key: clearApiKey,
      timeout_seconds: timeoutSeconds,
    });
    setStatus(next);
    setApiKey("");
    return next;
  }

  async function save(clearApiKey = false) {
    setWorking(true);
    setFailure("");
    setNotice("");
    try {
      const next = await persist(clearApiKey);
      await onChanged(next);
      setNotice(clearApiKey
        ? tr("Sciverse Key 已清除，线上数据访问已关闭。", "Sciverse key cleared; online data access is disabled.")
        : tr("Sciverse 连接已保存。", "Sciverse connection saved."));
    } catch (reason: unknown) {
      setFailure(messageOf(reason));
    } finally {
      setWorking(false);
    }
  }

  async function testConnection() {
    setWorking(true);
    setFailure("");
    setNotice("");
    try {
      const result = await testSciverseConfig({
        enabled,
        base_url: baseUrl.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        clear_api_key: false,
        timeout_seconds: timeoutSeconds,
      });
      setNotice(tr(
        `Sciverse 线上连接成功，耗时 ${result.latency_ms} 毫秒。当前表单尚未保存。`,
        `Connected to Sciverse online in ${result.latency_ms} ms. The current form has not been saved.`,
      ));
    } catch (reason: unknown) {
      setFailure(tr(
        `测试失败：${messageOf(reason)}`,
        `Test failed: ${messageOf(reason)}`,
      ));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form className="settings-form sciverse-settings-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <div className="settings-section-heading">
        <span>01</span>
        <div>
          <h3>{tr("Sciverse 线上数据", "Sciverse online data")}</h3>
          <p>{tr("论文与图谱数据的唯一来源。", "The only source of paper and graph data.")}</p>
        </div>
      </div>
      <div className="settings-status">
        <span className={status?.configured ? "ready" : "idle"} />
        <div>
          <strong>{status?.configured ? tr("线上数据已连接", "Online data connected") : tr("需要配置 Sciverse", "Sciverse configuration required")}</strong>
          <p>{status?.api_key_set ? tr(`已保存 Key ${status.api_key_hint}`, `Saved key ${status.api_key_hint}`) : tr("未保存 Sciverse Key", "No Sciverse key is stored")}</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span />
          {tr("启用", "Enabled")}
        </label>
      </div>

      <label htmlFor="sciverse-base-url">Base URL</label>
      <input id="sciverse-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.sciverse.space" required />
      <small>{tr("仅允许 HTTPS Sciverse API 根地址；本机 localhost 测试除外。", "Only an HTTPS Sciverse API root is accepted, except for localhost testing.")}</small>

      <label htmlFor="sciverse-api-key">Sciverse API Key</label>
      <input id="sciverse-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status?.api_key_set ? tr("留空以保留已保存 Key", "Leave blank to keep the saved key") : "sv-..."} />
      <small>{tr("Key 会以明文写入项目根目录的 local.config.json。", "The key is stored as plaintext in local.config.json at the project root.")}</small>
      {status?.storage_path ? <small><code>{status.storage_path}</code></small> : null}

      <label htmlFor="sciverse-timeout">{tr("请求超时", "Request timeout")}</label>
      <div className="timeout-control">
        <input id="sciverse-timeout" type="range" min="3" max="120" step="1" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
        <strong>{timeoutSeconds}s</strong>
      </div>

      {notice ? <p className="settings-notice success">{notice}</p> : null}
      {failure ? <p className="settings-notice failure">{failure}</p> : null}

      <div className="settings-actions">
        <button className="primary-action" type="submit" disabled={working}><Save size={16} /> {tr("保存连接", "Save connection")}</button>
        <button className="text-button" type="button" disabled={working || !status?.api_key_set && !apiKey.trim()} onClick={() => void testConnection()}><TestTube2 size={16} /> {tr("测试线上 API", "Test online API")}</button>
        <button className="danger-button" type="button" disabled={working || !status?.api_key_set} onClick={() => void save(true)}>{tr("清除 Key", "Clear key")}</button>
      </div>
    </form>
  );
}

function LocalSettingsPage({ onSciverseChanged }: {
  onSciverseChanged: (status: SciverseConfigStatus) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [status, setStatus] = useState<ModelConfigStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [apiKey, setApiKey] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [enabled, setEnabled] = useState(true);
  const [activeAction, setActiveAction] = useState<"save" | "test" | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    getModelConfig()
      .then((next) => {
        setStatus(next);
        setBaseUrl(next.base_url);
        setModel(next.model);
        setTimeoutSeconds(next.timeout_seconds);
        setEnabled(next.enabled);
      })
      .catch((reason: unknown) => setFailure(messageOf(reason)));
  }, []);

  async function persistConfig(clearApiKey: boolean) {
    const next = await updateModelConfig({
        enabled,
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        clear_api_key: clearApiKey,
        timeout_seconds: timeoutSeconds,
      });
    setStatus(next);
    setApiKey("");
    return next;
  }

  async function save(clearApiKey = false) {
    setActiveAction("save");
    setFailure("");
    setNotice("");
    try {
      await persistConfig(clearApiKey);
      setNotice(clearApiKey ? tr("密钥已清除。", "Secret key cleared.") : tr("配置已保存到本地。", "Configuration saved locally."));
    } catch (reason: unknown) {
      setFailure(messageOf(reason));
    } finally {
      setActiveAction(null);
    }
  }

  async function testConnection() {
    setActiveAction("test");
    setFailure("");
    setNotice("");
    try {
      const result = await testModelConfig({
        enabled,
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        clear_api_key: false,
        timeout_seconds: timeoutSeconds,
      });
      setNotice(tr(
        `测试成功：已连接 ${result.model}，耗时 ${result.latency_ms} 毫秒。当前表单尚未保存。`,
        `Test succeeded: connected to ${result.model} in ${result.latency_ms} ms. The current form has not been saved.`,
      ));
    } catch (reason: unknown) {
      setFailure(tr(
        `测试失败：${messageOf(reason)}`,
        `Test failed: ${messageOf(reason)}`,
      ));
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-shell">
        <header className="settings-intro">
          <span><Settings2 size={16} /> {tr("仅本地配置", "Local-only configuration")}</span>
          <h2>{tr("连接线上数据与导读模型", "Connect online data and a guide model")}</h2>
          <p>{tr(
            "Sciverse Key 和模型密钥由本页面管理，并以明文保存在项目根目录的同一个 local.config.json 中。论文与图谱数据不会写入本地。",
            "This page manages both keys. They are stored as plaintext in one local.config.json at the project root; papers and graph data are never written locally.",
          )}</p>
        </header>

        <div className="settings-layout">
          <div className="settings-forms">
            <SciverseSettingsForm onChanged={onSciverseChanged} />
          <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
            <div className="settings-section-heading">
              <span>02</span>
              <div>
                <h3>{tr("OpenAI 兼容模型", "OpenAI-compatible model")}</h3>
                <p>{tr(
                  "仅用于检索改写，以及基于 Schema 的主题导读和论文概述。",
                  "Used only for query rewriting and Schema-grounded topic and paper guides.",
                )}</p>
              </div>
            </div>
            <div className="settings-status">
              <span className={status?.configured ? "ready" : "idle"} />
              <div>
                <strong>{status?.configured ? tr("模型增强已就绪", "Model enhancement ready") : tr("模型尚未配置", "Model not configured")}</strong>
                <p>{status?.api_key_set ? tr(`已保存密钥 ${status.api_key_hint}`, `Saved key ${status.api_key_hint}`) : tr("未保存密钥", "No secret key is stored")}</p>
              </div>
              <label className="switch">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                <span />
                {tr("启用", "Enabled")}
              </label>
            </div>

            <label htmlFor="model-base-url">Base URL</label>
            <input id="model-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" required />
            <small>{tr("请填写提供 ", "Use the API root that exposes ")}<code>/chat/completions</code>{tr(" 的 API 根地址，支持 HTTP 或 HTTPS。", ". HTTP and HTTPS endpoints are supported.")}</small>

            <label htmlFor="model-name">{tr("模型", "Model")}</label>
            <input id="model-name" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" required />

            <label htmlFor="model-api-key">{tr("密钥", "Secret key")}</label>
            <input id="model-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status?.api_key_set ? tr("留空以保留已保存密钥", "Leave blank to keep the saved key") : "sk-..."} />
            <small>{tr("留空会保留当前密钥；密钥以明文保存在 local.config.json。", "Leaving this blank preserves the current key; it is stored as plaintext in local.config.json.")}</small>
            {status?.storage_path ? <small><code>{status.storage_path}</code></small> : null}

            <label htmlFor="model-timeout">{tr("超时", "Timeout")}</label>
            <div className="timeout-control">
              <input id="model-timeout" type="range" min="3" max="120" step="1" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
              <strong>{timeoutSeconds}s</strong>
            </div>

            {notice ? <p className="settings-notice success">{notice}</p> : null}
            {failure ? <p className="settings-notice failure">{failure}</p> : null}

            <div className="settings-actions">
              <button className="primary-action" type="submit" disabled={activeAction !== null}><Save size={16} /> {activeAction === "save" ? tr("保存中…", "Saving…") : tr("保存", "Save")}</button>
              <button className="text-button" type="button" disabled={activeAction !== null || !status?.api_key_set && !apiKey.trim()} onClick={() => void testConnection()}><TestTube2 size={16} /> {activeAction === "test" ? tr("测试中…", "Testing…") : tr("测试连接", "Test connection")}</button>
              <button className="danger-button" type="button" disabled={activeAction !== null || !status?.api_key_set} onClick={() => void save(true)}>{tr("清除密钥", "Clear key")}</button>
            </div>
          </form>
          </div>

          <aside className="model-roles">
            <h3>{tr("模型介入范围", "Where the model participates")}</h3>
            <article>
              <span className="role-required">{tr("中文检索需要", "Required for Chinese")}</span>
              <strong>{tr("检索规划", "Query planning")}</strong>
              <p>{tr("将中文问题转换为简短英文检索短语；没有模型时仅提供有限的本地 AI 词表。", "Translates Chinese questions into short English retrieval phrases. Without a model, only a small local AI glossary is available.")}</p>
            </article>
            <article>
              <span className="role-optional">{tr("可选增强", "Optional enhancement")}</span>
              <strong>{tr("研究导读与论文概述", "Research guides and paper overviews")}</strong>
              <p>{tr(
                "只读取 Sciverse 返回的结构化元数据、Entity、Relation 与 Citation；不把全文段落发送给模型，也不允许模型增加事实。",
                "Uses only structured metadata, Entities, Relations, and Citations returned by Sciverse. Full-text paragraphs are never sent to the model, and the model cannot add facts.",
              )}</p>
            </article>
            <article>
              <span className="role-data">{tr("模型不介入", "No model involved")}</span>
              <strong>{tr("图谱事实与证据", "Graph facts and evidence")}</strong>
              <p>{tr("Entity、文内关系、引用、Evidence 和 provenance 始终直接来自 Paper Schema API；模型不能添加节点或事实边。", "Entities, internal relations, citations, Evidence and provenance always come directly from Paper Schema APIs. The model cannot add nodes or factual edges.")}</p>
            </article>
            <div className="settings-boundary">
              <CircleHelp size={17} />
              <p>{tr("尚未启用论文级中文摘要和事实标签翻译；英文原始标题与证据保持不变，以便审计。", "Paper-level Chinese summaries and fact-label translation are not enabled yet. English source titles and evidence remain unchanged to preserve auditability.")}</p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function VisualHeader({ kicker, title, graph, tabs, active, onTab, onExport }: {
  kicker: string;
  title: string;
  graph: GraphPayload;
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onTab: (id: string) => void;
  onExport: () => void;
}) {
  const { tr } = useI18n();
  return (
    <header className="visual-header">
      <div><span>{kicker}</span><h2>{inlineScientificText(title)}</h2><p>{tr(
        `${graph.nodes.length} 个节点 · ${graph.edges.length} 条边 · 文内 ${graph.stats.internal_relations} · 引用 ${graph.stats.citations} · 建议 ${graph.stats.suggestions}`,
        `${graph.nodes.length} nodes · ${graph.edges.length} edges · Internal ${graph.stats.internal_relations} · Citation ${graph.stats.citations} · Suggested ${graph.stats.suggestions}`,
      )}</p></div>
      <div className="visual-controls">
        <div className="segmented">{tabs.map((tab) => <button type="button" className={active === tab.id ? "active" : ""} key={tab.id} onClick={() => onTab(tab.id)}>{tab.label}</button>)}</div>
        <button className="export-button" type="button" onClick={onExport}><Download size={15} /> {tr("导出子图", "Export Subgraph")}</button>
      </div>
    </header>
  );
}

function Inspector({ node, edge, onClose, onOpenPaper }: {
  node: GraphNode | null;
  edge: GraphEdge | null;
  onClose: () => void;
  onOpenPaper: (schemaId: string) => void;
}) {
  const { tr } = useI18n();
  return (
    <aside className="inspector">
      <header><div><span>{tr("检查器", "Inspector")}</span><h2>{tr("Entity 详情", "Entity Details")}</h2></div><button type="button" onClick={onClose}><X size={18} /></button></header>
      {edge ? (
        <article className="inspector-card">
          <span className={`semantic-badge badge-${edge.edge_type}`}>{edge.edge_type.replaceAll("_", " ")}</span>
          <h3>{edge.label}</h3>
          <p>{edge.edge_type === "internal_relation" ? tr("论文内部 Entity 之间的抽取事实关系。", "An extracted factual relation between Entities inside one paper.") : edge.edge_type === "citation" ? tr("论文之间已解析的引用边。", "A resolved citation edge between papers.") : tr("基于检索信号生成的相关建议，不代表抽取事实。", "A related suggestion from retrieval signals, not an extracted fact.")}</p>
          <Detail label={tr("起点", "Source")} value={edge.source} /><Detail label={tr("终点", "Target")} value={edge.target} />
          {edge.reasons.length ? <blockquote>{edge.reasons.join(" · ")}</blockquote> : null}
        </article>
      ) : node ? (
        <>
          <article className="inspector-card">
            <span className="semantic-badge">{node.entity_type || node.node_type}</span>
            <h3>{node.label}</h3>
            <p>{node.description || node.paper?.abstract || node.subtitle}</p>
            {node.node_type === "paper" ? <button className="primary-action" type="button" onClick={() => onOpenPaper(node.schema_id)}><BookOpen size={16} />{tr("进入论文导读", "Open paper guide")}</button> : null}
          </article>
          <section className="detail-list"><Detail label="Schema ID" value={node.schema_id} /><Detail label={tr("章节", "Section")} value={node.section || "—"} /><Detail label={tr("状态", "Status")} value={node.status} /></section>
        </>
      ) : <p className="inspector-empty">{tr("选择图中的论文、Entity 或关系查看详情。", "Select a paper, Entity, or relation in the graph to inspect it.")}</p>}
    </aside>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : "The request could not be completed";
}

export default App;
