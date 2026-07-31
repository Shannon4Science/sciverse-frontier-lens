# FrontierLens User Guide

## 1. Start the local application

Install the Python and frontend dependencies:

```bash
make setup
```

Start `make backend` and `make frontend` in separate terminals, then open
`http://127.0.0.1:3040`. FrontierLens starts with no research data until a
Sciverse connection is configured.

## 2. Configure Sciverse

Open **Connection settings** and enter:

- Base URL: normally `https://api.sciverse.space`
- Sciverse API key
- Request timeout

Normal local use does not require a `.env` file. Configure the Sciverse
connection and the model connection from this settings page.

Use **Test online API** when you want to verify the current form. Testing does
not save the form; **Save connection** stores and enables it.

The key is stored as plaintext in `local.config.json` in the directory where
FrontierLens was started. Do not commit or share this file.

## 3. Configure the required model connection

FrontierLens accepts an OpenAI-compatible `/chat/completions` endpoint. Enter
the base URL, model name, secret, and timeout. The model is used only for:

- rewriting Chinese or long questions into short English search phrases;
- producing a reader-facing topic guide from returned Schema facts;
- producing a paper overview from returned Schema facts.

The model cannot add a paper, Entity, Relation, Citation, Evidence item, or
source paragraph. Full paper text is not the default input to guide generation.
Exploration starts only after both Sciverse and model connections are configured
and enabled. If either connection is missing, FrontierLens names the missing
key and opens Local Settings. If a configured model request times out, fails,
or returns invalid structured output, the current exploration or paper-opening
task stops and displays that error. FrontierLens does not substitute a local
glossary, deterministic guide, or rule-generated paper overview.

## 4. Explore a topic

Enter an AI research question or select an example. FrontierLens:

1. plans concise retrieval phrases;
2. searches the current Sciverse Paper Schema corpus;
3. expands bounded Entity, internal Relation, and Citation context;
4. assembles a topic graph;
5. produces a guided reading path.

The progress dialog reflects real milestones and can be cancelled. A result
set is intentionally bounded for reading. It is not a global literature graph.

Use **Guided Cards** for an ordered reading path and **Relationship Graph** for
the factual graph view. Toolbar zoom controls always apply to the currently
visible card or graph canvas.

## 5. Read a paper

Opening a paper loads its public metadata, Schema-grounded overview, Entities,
internal Relations, citation summary, high-value Evidence, and ordered
paragraphs.

- **Guided Cards** groups extracted content for reading.
- **Relationship Graph** shows complete paper-local Entity relations.
- **Source evidence** opens the assembled paragraph reader.
- Selecting an anchored Entity or Evidence item scrolls to and highlights the
  matching source paragraph.
- Approximate paper-local matches are labeled as approximate.
- A title- and author-verified related publication version is labeled when it
  supplies readable paragraph text.

DOI and arXiv links are shown when present in public paper metadata.

## 6. Understand coverage

The current corpus contains more than one million AI-focused papers with
completed Paper Schema extraction. No result means only that FrontierLens did
not find a match in this corpus. It does not mean the research is absent from
the scholarly literature.

## 7. Stop and remove local configuration

Stop the terminal process with `Ctrl+C`. Remove `local.config.json` to erase the
saved Sciverse and model connection settings. FrontierLens does not maintain a
local paper or graph database.
