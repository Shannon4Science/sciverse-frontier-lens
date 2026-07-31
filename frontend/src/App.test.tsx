import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { OverviewSidebar } from "./App";
import { LanguageProvider } from "./i18n";
import type { Capabilities, GraphPayload } from "./types";

const capabilities = {
  contract_version: "test",
  mode: "unconfigured",
  coverage: {
    current_focus: "AI conference papers",
    paper_count: "1M+",
    empty_result_message: "Scoped empty result",
  },
  resources: [],
  edge_types: ["internal_relation", "citation", "related_suggestion"],
  limits: {},
};

describe("FrontierLens unconfigured application", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.setItem("frontierlens-ui-language", "en");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("capabilities")) return json(capabilities);
      if (path.includes("settings/sciverse")) {
        return json({
          enabled: true,
          configured: false,
          mode: "unconfigured",
          base_url: "https://api.sciverse.space",
          api_key_set: false,
          api_key_hint: null,
          timeout_seconds: 20,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      if (path.includes("settings/model")) {
        return json({
          enabled: true,
          configured: false,
          base_url: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          api_key_set: false,
          api_key_hint: null,
          timeout_seconds: 30,
          allow_insecure_http: false,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      return new Response(JSON.stringify({ detail: "Sciverse is not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  it("shows no graph or research data until both connections can be configured", async () => {
    renderApp();

    expect(await screen.findByRole("heading", {
      name: "Configure Sciverse and LLM to start exploring",
    })).toBeInTheDocument();
    expect(screen.queryByLabelText("Research graph")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explore" })).toBeDisabled();
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input).includes("discovery-map"))).toBe(false);
  });

  it("shows the single project JSON configuration path", async () => {
    renderApp();
    fireEvent.click(screen.getByTitle("Connection settings"));

    expect(await screen.findByRole("heading", {
      name: "Local Connection Settings",
    })).toBeInTheDocument();
    expect(screen.getAllByText("/project/local.config.json")).toHaveLength(2);
    expect(screen.getByLabelText("Sciverse API Key")).toHaveValue("");
    expect(screen.getByLabelText("Secret key")).toHaveValue("");
  });

  it("persists only the interface language in browser storage", async () => {
    renderApp();
    fireEvent.click(screen.getByTitle("切换到中文"));

    expect(screen.getByRole("heading", { name: "知识发现图谱" })).toBeInTheDocument();
    expect(window.localStorage.getItem("frontierlens-ui-language")).toBe("zh");
  });

  it("resizes the overview sidebar by keyboard and pointer", async () => {
    renderApp();
    await screen.findByRole("heading", {
      name: "Configure Sciverse and LLM to start exploring",
    });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    expect(separator).toHaveAttribute("aria-valuenow", "264");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "280");
    fireEvent(separator, new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 280,
    }));
    fireEvent(window, new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 402,
    }));
    expect(separator).toHaveAttribute("aria-valuenow", "402");
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "264");
  });

  it("blocks exploration with an explicit prompt when only the LLM is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) {
        return jsonResponse({
          ...configuredModel,
          configured: false,
          api_key_set: false,
          api_key_hint: null,
        });
      }
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      return notFound();
    }));
    renderApp();
    expect((await screen.findAllByText("LLM key required")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Test Paper/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Research Question"), {
      target: { value: "transformer architecture" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));

    expect(await screen.findByRole("heading", {
      name: "Local Connection Settings",
    })).toBeInTheDocument();
    expect(screen.getByText(
      "Configure and enable the LLM API key before continuing.",
    )).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input).includes("topic-explore"))).toBe(false);
  });

  it("saves both connection forms without leaving settings between saves", async () => {
    let sciverseConfigured = false;
    let modelConfigured = false;
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.endsWith("/api/settings/sciverse")) {
        if (init?.method === "PUT") sciverseConfigured = true;
        return jsonResponse({
          ...configuredSciverse,
          configured: sciverseConfigured,
          api_key_set: sciverseConfigured,
          api_key_hint: sciverseConfigured ? "sv-••••test" : null,
        });
      }
      if (path.endsWith("/api/settings/model")) {
        if (init?.method === "PUT") modelConfigured = true;
        return jsonResponse({
          ...configuredModel,
          configured: modelConfigured,
          api_key_set: modelConfigured,
          api_key_hint: modelConfigured ? "••••test" : null,
        });
      }
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      return notFound();
    }));
    renderApp();
    fireEvent.click(screen.getByTitle("Connection settings"));
    await screen.findByRole("heading", { name: "Local Connection Settings" });

    fireEvent.change(screen.getByLabelText("Sciverse API Key"), {
      target: { value: "sv-test-value" },
    });
    fireEvent.change(screen.getByLabelText("Secret key"), {
      target: { value: "sk-test-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    expect(await screen.findByText("Sciverse connection saved.")).toBeInTheDocument();
    expect(screen.getByRole("heading", {
      name: "Local Connection Settings",
    })).toBeInTheDocument();
    expect(screen.getByLabelText("Secret key")).toHaveValue("sk-test-value");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(
      "LLM configuration saved and ready for exploration.",
    )).toBeInTheDocument();
    expect(screen.getByRole("heading", {
      name: "Local Connection Settings",
    })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input).includes("discovery-map"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: /Test Paper/ })).toBeInTheDocument();
  });

  it("tests the current model draft without saving it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return json(capabilities);
      if (path.includes("settings/sciverse")) {
        return json({
          enabled: true,
          configured: false,
          mode: "unconfigured",
          base_url: "https://api.sciverse.space",
          api_key_set: false,
          api_key_hint: null,
          timeout_seconds: 20,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      if (path.endsWith("/api/settings/model/test")) {
        expect(init?.method).toBe("POST");
        return json({ ok: true, model: "draft-model", latency_ms: 42 });
      }
      if (path.endsWith("/api/settings/model")) {
        return json({
          enabled: true,
          configured: true,
          base_url: "https://models.example/v1",
          model: "stored-model",
          api_key_set: true,
          api_key_hint: "••••test",
          timeout_seconds: 30,
          allow_insecure_http: false,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }));
    renderApp();
    fireEvent.click(screen.getByTitle("Connection settings"));
    await screen.findByDisplayValue("stored-model");

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "draft-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(
      "Test succeeded: connected to draft-model in 42 ms. The current form has not been saved.",
    )).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([input, init]) =>
      String(input).endsWith("/api/settings/model/test")
      && init?.method === "POST")).toBe(true);
    expect(calls.some(([input, init]) =>
      String(input).endsWith("/api/settings/model")
      && init?.method === "PUT")).toBe(false);
  });

  it("tests the current Sciverse draft without saving it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return json(capabilities);
      if (path.endsWith("/api/settings/sciverse/test")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          base_url: "https://draft.sciverse.test",
          api_key: "draft-test-value",
          timeout_seconds: 20,
        });
        return jsonResponse({
          ok: true,
          mode: "production",
          latency_ms: 37,
          contract_version: "draft-test",
        });
      }
      if (path.endsWith("/api/settings/sciverse")) {
        return jsonResponse({
          enabled: true,
          configured: false,
          mode: "unconfigured",
          base_url: "https://api.sciverse.space",
          api_key_set: false,
          api_key_hint: null,
          timeout_seconds: 20,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      if (path.includes("settings/model")) {
        return jsonResponse({
          enabled: true,
          configured: false,
          base_url: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          api_key_set: false,
          api_key_hint: null,
          timeout_seconds: 30,
          allow_insecure_http: false,
          storage: "local_project_json",
          storage_path: "/project/local.config.json",
        });
      }
      return notFound();
    }));
    renderApp();
    fireEvent.click(screen.getByTitle("Connection settings"));
    await screen.findByRole("heading", { name: "Local Connection Settings" });

    fireEvent.change(document.querySelector(
      "#sciverse-base-url",
    ) as HTMLInputElement, {
      target: { value: "https://draft.sciverse.test" },
    });
    fireEvent.change(screen.getByLabelText("Sciverse API Key"), {
      target: { value: "draft-test-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test online API" }));

    expect(await screen.findByText(
      "Connected to Sciverse online in 37 ms. The current form has not been saved.",
    )).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([input, init]) =>
      String(input).endsWith("/api/settings/sciverse")
      && init?.method === "PUT")).toBe(false);
  });
});

describe("FrontierLens configured research flows", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.setItem("frontierlens-ui-language", "en");
  });

  it("routes toolbar zoom controls to the active card canvas", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) return jsonResponse(configuredModel);
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      return notFound();
    }));
    renderApp();
    await screen.findByRole("button", { name: /Test Paper/ });

    const cardCanvas = document.querySelector(
      ".card-canvas-world",
    ) as HTMLDivElement;
    const before = cardCanvas.style.transform;
    fireEvent.click(screen.getByTitle("Zoom in"));

    await waitFor(() => {
      expect(cardCanvas.style.transform).not.toBe(before);
    });
    expect(screen.getByTitle("Fit cards")).toBeInTheDocument();
  });

  it("shows persistent filters only in the relationship graph view", async () => {
    const toggleNodeType = vi.fn();
    const toggleEdgeType = vi.fn();
    const props = {
      graph: discoveryGraph as unknown as GraphPayload,
      query: "",
      setQuery: vi.fn(),
      submitQuestion: vi.fn(),
      askExample: vi.fn(),
      busy: false,
      capabilities: configuredCapabilities as Capabilities,
      sciverseConfigured: true,
      modelConfigured: true,
      openSettings: vi.fn(),
      visibleNodeTypes: { Paper: true },
      visibleEdgeTypes: {
        internal_relation: true,
        citation: true,
        related_suggestion: true,
      },
      toggleNodeType,
      toggleEdgeType,
    } as const;
    const view = render(
      <LanguageProvider>
        <OverviewSidebar {...props} overviewView="cards" />
      </LanguageProvider>,
    );

    expect(screen.queryByRole("heading", { name: "Node Types" })).not.toBeInTheDocument();
    view.rerender(
      <LanguageProvider>
        <OverviewSidebar {...props} overviewView="graph" />
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "Node Types" })).toBeInTheDocument();
    const paperFilter = screen.getByRole("checkbox", { name: "Paper" });
    expect(paperFilter).toBeChecked();
    fireEvent.click(paperFilter);
    expect(toggleNodeType).toHaveBeenCalledWith("Paper");
  });

  it("shows and cancels the compact exploration progress dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) return jsonResponse(configuredModel);
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      if (path.includes("topic-explore/stream")) {
        return await new Promise<Response>(() => {});
      }
      return notFound();
    }));
    renderApp();
    await screen.findByRole("button", { name: /Test Paper/ });

    fireEvent.change(screen.getByLabelText("Research Question"), {
      target: { value: "transformer architecture" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Exploring the research topic",
    });
    expect(dialog).toHaveTextContent("Understand the research question");
    expect(dialog).toHaveTextContent("Search Sciverse papers");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stops paper opening when the LLM overview fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) return jsonResponse(configuredModel);
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      if (path.endsWith("/api/papers/paper-1/reading-source")) {
        return jsonResponse({
          requested_schema_id: "paper-1",
          active_schema_id: "paper-1",
          canonical_document: paperCard,
          active_document: paperCard,
          used_equivalent_version: false,
          active_reason: "requested_full_text",
        });
      }
      if (path.endsWith("/api/papers/paper-1/graph")) return jsonResponse(paperGraph);
      if (path.includes("/api/papers/paper-1/overview")) {
        return jsonResponse({
          error: {
            code: "MODEL_REQUEST_FAILED",
            message: "model endpoint is unreachable",
            retryable: true,
            request_id: "test-request",
          },
        }, 502);
      }
      if (path.includes("/api/papers/paper-1/citations")) {
        return jsonResponse({
          schema_id: "paper-1",
          items: [],
          total: 0,
          returned: 0,
          truncated: false,
        });
      }
      if (path.includes("/api/evidence/search")) {
        return jsonResponse({
          items: [],
          next_cursor: null,
          fallback_recommended: false,
        });
      }
      if (path.includes("/api/papers/paper-1/paragraphs")) {
        return jsonResponse({
          schema_id: "paper-1",
          segments: [],
          returned: 0,
          next_marker: null,
          complete: true,
        });
      }
      return notFound();
    }));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Test Paper/ }));

    const dialog = await screen.findByRole("dialog", {
      name: "Opening the paper structure",
    });
    expect(dialog).toHaveTextContent("model endpoint is unreachable");
    expect(screen.getByRole("heading", {
      name: "Knowledge Discovery Map",
    })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading Guide" })).not.toBeInTheDocument();
  });

  it("opens a paper, exposes resizable panes, and reads ordered paragraphs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) return jsonResponse(configuredModel);
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      if (path.endsWith("/api/papers/paper-1/reading-source")) {
        return jsonResponse({
          requested_schema_id: "paper-1",
          active_schema_id: "paper-1",
          canonical_document: paperCard,
          active_document: paperCard,
          used_equivalent_version: false,
          active_reason: "requested_full_text",
        });
      }
      if (path.endsWith("/api/papers/paper-1/graph")) return jsonResponse(paperGraph);
      if (path.includes("/api/papers/paper-1/overview")) {
        const language = path.includes("response_language=zh") ? "zh" : "en";
        return jsonResponse({
          schema_id: "paper-1",
          language,
          summary: language === "zh"
            ? "这是一篇有依据的中文论文概述。"
            : "A grounded paper overview.",
          why_read: language === "zh"
            ? "用于判断是否继续深入。"
            : "Use this to decide whether to continue.",
          focus_points: language === "zh"
            ? ["研究问题", "核心贡献"]
            : ["Research problem", "Central contribution"],
          generation_mode: "model",
          model_warning: null,
        });
      }
      if (path.includes("/api/papers/paper-1/citations")) {
        return jsonResponse({
          schema_id: "paper-1",
          items: [],
          total: 0,
          returned: 0,
          truncated: false,
        });
      }
      if (path.includes("/api/evidence/search")) {
        return jsonResponse({
          items: [
            {
              schema_id: "paper-1",
              evidence_id: "marker-only",
              groups: ["table_evidence"],
              key: "source_table_marker",
              path: "sections[0].source_table_marker",
              path_bucket: null,
              value_text: "§84",
              value_number: null,
              value_bool: null,
              marker_nums: [],
              paragraph_ids: [],
            },
            {
              schema_id: "paper-1",
              evidence_id: "formula-1",
              groups: ["formula"],
              key: "expression",
              path: "sections[0].formula",
              path_bucket: null,
              value_text: "\\frac{a}{b}",
              value_number: null,
              value_bool: null,
              marker_nums: [2],
              paragraph_ids: [],
            },
          ],
          next_cursor: null,
          fallback_recommended: false,
        });
      }
      if (path.includes("/api/papers/paper-1/paragraphs")) {
        return jsonResponse({
          schema_id: "paper-1",
          segments: [
            {
              schema_id: "paper-1",
              paragraph_id: "paragraph::paper-1::000001",
              marker_num: 1,
              section: "Abstract",
              section_path: "Abstract",
              text: "**First paragraph**",
              match_role: null,
            },
            {
              schema_id: "paper-1",
              paragraph_id: "paragraph::paper-1::000002",
              marker_num: 2,
              section: "Introduction",
              section_path: "1 Introduction",
              text: "Second paragraph",
              match_role: null,
            },
          ],
          returned: 2,
          next_marker: null,
          complete: true,
        });
      }
      if (path.endsWith("/api/papers/paper-1")) return jsonResponse(paperCard);
      return notFound();
    }));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Test Paper/ }));

    expect(await screen.findByRole("heading", { name: "Reading Guide" })).toBeInTheDocument();
    expect(screen.getByText("Paper overview", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByText("A grounded paper overview.")).toBeInTheDocument();
    expect(screen.getByText("Use this to decide whether to continue.")).toBeInTheDocument();
    const paragraphCallsAfterOpen = vi.mocked(fetch).mock.calls.filter(([input]) => (
      String(input).includes("/api/papers/paper-1/paragraphs")
    )).length;
    expect(paragraphCallsAfterOpen).toBeGreaterThan(0);
    expect(screen.queryByRole("button", {
      name: "Toggle guide panel",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("separator", {
      name: "Resize paper guide pane",
    })).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Evidence 1$/, { selector: "button" }));
    expect(screen.queryByText("source_table_marker")).not.toBeInTheDocument();
    expect(screen.queryByText("§84")).not.toBeInTheDocument();
    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(document.querySelector(".evidence-card-value .katex")).not.toBeNull();
    fireEvent.click(screen.getByText("Source evidence", { selector: "button" }));

    expect(await screen.findByText("First paragraph")).toBeInTheDocument();
    expect(screen.getByText("First paragraph").tagName).toBe("STRONG");
    expect(screen.getByText("Second paragraph")).toBeInTheDocument();
    expect(screen.getByText(
      "Full text assembled in order from 2 paragraphs",
    )).toBeInTheDocument();
    expect(document.querySelector(
      '[role="separator"][aria-label="Resize source evidence pane"]',
    )).not.toBeNull();
    expect(screen.queryByText("§1")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => (
      String(input).includes("/api/papers/paper-1/paragraphs")
    ))).toHaveLength(paragraphCallsAfterOpen);

    fireEvent.click(document.querySelector(".language-button") as HTMLButtonElement);
    expect(await screen.findByText("这是一篇有依据的中文论文概述。")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).includes("/api/papers/paper-1/overview?response_language=zh")
    ))).toBe(true);
  });

  it("uses one readable schema version for graph, entities, and full text", async () => {
    const versionedGraph = {
      ...paperGraph,
      nodes: [
        ...paperGraph.nodes,
        {
          id: "entity:paper-1:method",
          node_type: "entity",
          schema_id: "paper-1",
          entity_id: "method",
          entity_type: "Component",
          label: "T-Razor",
          description: "A training-free Transformer architecture search method.",
          anchors: [{ paragraph_id: null, marker_num: 23 }],
          status: "available",
        },
      ],
      stats: {
        ...paperGraph.stats,
        entity_nodes: 1,
      },
    };
    const activeVersionedGraph = {
      ...versionedGraph,
      graph_id: "paper:conference-paper-1",
      nodes: versionedGraph.nodes.map((node) => ({
        ...node,
        schema_id: "conference-paper-1",
        ...("paper" in node && node.paper ? { paper: {
          ...node.paper,
          schema_id: "conference-paper-1",
        } } : {}),
      })),
    };
    const activeDocument = {
      ...paperCard,
      schema_id: "conference-paper-1",
      doi: "10.48550/arXiv.2203.12217",
      arxiv_id: "2203.12217",
      pdf_url: "https://arxiv.org/pdf/2203.12217",
      external_url: "https://arxiv.org/pdf/2203.12217",
    };
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const path = String(input);
      if (path.includes("capabilities")) return jsonResponse(configuredCapabilities);
      if (path.includes("settings/sciverse")) return jsonResponse(configuredSciverse);
      if (path.includes("settings/model")) return jsonResponse(configuredModel);
      if (path.includes("discovery-map")) return jsonResponse(discoveryGraph);
      if (path.endsWith("/api/papers/paper-1/reading-source")) {
        return jsonResponse({
          requested_schema_id: "paper-1",
          active_schema_id: "conference-paper-1",
          canonical_document: paperCard,
          active_document: activeDocument,
          used_equivalent_version: true,
          active_reason: "equivalent_full_text",
        });
      }
      if (path.endsWith("/api/papers/conference-paper-1/graph")) {
        return jsonResponse(activeVersionedGraph);
      }
      if (path.includes("/api/papers/conference-paper-1/overview")) {
        return jsonResponse({
          schema_id: "conference-paper-1",
          language: "en",
          summary: "A grounded overview of the canonical paper.",
          why_read: "Review the contribution before continuing.",
          focus_points: ["Zero-cost proxy"],
          generation_mode: "model",
          model_warning: null,
        });
      }
      if (path.includes("/api/papers/conference-paper-1/citations")) {
        return jsonResponse({
          schema_id: "conference-paper-1",
          items: [],
          total: 0,
          returned: 0,
          truncated: false,
        });
      }
      if (path.includes("/api/evidence/search")) {
        return jsonResponse({
          items: [],
          next_cursor: null,
          fallback_recommended: false,
        });
      }
      if (path.endsWith("/api/provenance")) {
        return jsonResponse({
          segments: [],
          returned: 0,
          locator_method: "provenance",
          query: null,
        });
      }
      if (path.includes("/context-search")) {
        return jsonResponse({
          segments: [],
          returned: 0,
          locator_method: "schema_local_search",
          query: "T-Razor",
        });
      }
      if (path.includes("/api/papers/conference-paper-1/paragraphs")) {
        return jsonResponse({
          schema_id: "conference-paper-1",
          source_schema_id: "conference-paper-1",
          source_document: null,
          segments: [{
            schema_id: "conference-paper-1",
            paragraph_id: "paragraph::conference-paper-1::000001",
            marker_num: 1,
            section: "Introduction",
            section_path: "1 Introduction",
            text: "**Equivalent** source version text",
            match_role: null,
          }],
          returned: 1,
          next_marker: null,
          complete: true,
        });
      }
      if (path.endsWith("/api/papers/conference-paper-1")) {
        return jsonResponse(activeDocument);
      }
      return notFound();
    }));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Test Paper/ }));
    fireEvent.click(await screen.findByRole("button", { name: /T-Razor/ }));

    expect(await screen.findByText("Equivalent")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("link", { name: "Open PDF" })).toHaveAttribute(
      "href",
      "https://arxiv.org/pdf/2203.12217",
    );
    expect(screen.queryByText("§1")).not.toBeInTheDocument();
    expect(screen.getByText("Paper text")).toBeInTheDocument();
    expect(screen.queryByText(
      /not presented as exact Entity provenance/,
    )).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).endsWith("/api/papers/conference-paper-1/graph")
    ))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).endsWith("/api/papers/paper-1/graph")
    ))).toBe(false);
  });
});

function renderApp() {
  return render(
    <LanguageProvider>
      <App />
    </LanguageProvider>,
  );
}

function json(value: unknown) {
  return Promise.resolve(jsonResponse(value));
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound() {
  return new Response(JSON.stringify({ detail: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

const configuredCapabilities = {
  ...capabilities,
  mode: "production",
};

const configuredSciverse = {
  enabled: true,
  configured: true,
  mode: "production",
  base_url: "https://api.sciverse.space",
  api_key_set: true,
  api_key_hint: "••••test",
  timeout_seconds: 20,
  storage: "local_project_json",
  storage_path: "/project/local.config.json",
};

const configuredModel = {
  enabled: true,
  configured: true,
  base_url: "https://models.example/v1",
  model: "guide-model",
  api_key_set: true,
  api_key_hint: "••••test",
  timeout_seconds: 30,
  allow_insecure_http: false,
  storage: "local_project_json",
  storage_path: "/project/local.config.json",
};

const paperCard = {
  schema_id: "paper-1",
  title: "Test Paper",
  authors: ["A. Researcher"],
  year: 2025,
  abstract: "A test abstract.",
  central_contribution: "A test contribution.",
  research_problem: "A test problem.",
  headline_result: "A test result.",
  doi: null,
  venue: null,
  citation_count: 0,
  topics: [],
};

const discoveryGraph = {
  graph_id: "discovery",
  title: "Discovery",
  root_schema_ids: ["paper-1"],
  nodes: [{
    id: "paper:paper-1",
    node_type: "paper",
    schema_id: "paper-1",
    label: "Test Paper",
    status: "resolved",
    paper: paperCard,
  }],
  edges: [],
  stats: {
    paper_nodes: 1,
    entity_nodes: 0,
    reference_nodes: 0,
    internal_relations: 0,
    citations: 0,
    suggestions: 0,
  },
  warnings: [],
  truncated: false,
};

const paperGraph = {
  ...discoveryGraph,
  graph_id: "paper-1",
  title: "Test Paper",
};
