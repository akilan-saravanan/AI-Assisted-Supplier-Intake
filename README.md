# AI-Assisted-Supplier-Intake
# Supplier Risk Scoring

This repository contains a supplier-intake risk scoring tool. The repository demonstrates AI-assisted supplier risk assessment, by combining client-side document parsing, LLM-based risk scoring, a deterministic rule-based fallback, and a reviewer decision workflow into a single browsable supplier assessment app.

## Application description

The primary purpose of this repository is to demonstrate automated supplier intake risk scoring, by providing a tool that ingests one or more uploaded supplier documents — PDF or Word — and produces a weighted risk score, a set of cited evidence and concerns, and a reviewer-facing decision workflow for each supplier.

The tool is designed to exercise the full lifecycle of supplier intake review: parsing uploaded documents into plain text in the browser, scoring that text against four weighted risk dimensions using a local LLM, extracting the specific evidence and concerns behind that score with citations back to source text, and carrying the supplier through an Approve/Escalate/Reject decision with a full audit trail.

The tool illustrates how a set of manual, slider-driven risk scores can be replaced by an AI-assisted scoring engine that reads the underlying documents itself, while keeping a deterministic fallback path so the review workflow never depends on a model being reachable.

### Supplier dashboard (`index.html`)

The supplier list, upload modal, and reviewer detail page (sliders, score ring, evidence/concerns, decision history) are plain client-rendered HTML/JS/CSS talking directly to a local Ollama instance — see [How it's built](#how-its-built) below.

## Possible uses

- Get a reviewer to a first-pass risk score on a new supplier before they've read a single document themselves.
- Cut down manual slider-scoring by having the model read financial, audit, compliance, and ESG documents directly.
- Give a reviewer a cited evidence/concerns trail instead of a bare score, so a decision to escalate or reject can be justified from the source text.
- Track which concerns have been raised to a supplier and which have since been addressed, across multiple review rounds.
- Demo an AI-assisted intake workflow end to end with no backend, database, or account setup.

## Skill level required

Beginner to use — no configuration is needed to demo it end to end with manual scoring. Live AI scoring requires a locally running Ollama instance, which needs comfort with the command line to install and start.

## Prerequisites

- A modern browser (the app is a static site with no build step)
- Optional, for live AI scoring: [Ollama](https://ollama.com) running locally with the Mistral model pulled (`ollama pull mistral`)

## Getting started

Serve the folder with any static file server and open it in a browser, for example:

```bash
npx serve .
```

That's the whole setup. No local model is required — if Ollama isn't reachable (for example, when the app is accessed over the hosted HTTPS GitHub Pages demo, which can't reach `localhost` as mixed content), scoring falls back to a deterministic rule-based engine instead of a live model call, so the app is fully demoable without a local model. Run `ollama pull mistral` and `ollama serve` locally, and it calls the local Mistral model instead, blending its output with the same rule-based baseline.

Click **+ New Supplier** on the list page to upload documents and see a score generated, or use **Or enter scores manually →** to bypass documents and drive the four sliders directly.

## What you get, per supplier

| Feature | Description |
|---|---|
| **Overall risk score** | A weighted blend of four dimensions: Financial Health (35%), Audit History (25%), Compliance Status (25%), Geo & ESG Risk (15%). |
| **Evidence** | The specific facts in the uploaded documents that support the score, cited back to source text. |
| **Concerns** | Risk flags raised by the score, each of which can later be marked (individually or via multi-select) as addressed once resolved with the supplier. |
| **Source documents** | The uploaded PDF/Word files the score and evidence were derived from, listed alongside the score. |
| **Decision history** | A running audit trail of Approve/Escalate/Reject actions taken by the reviewer, with concerns-addressed status per entry. |
| **Export** | A supplier-facing PDF summary generated directly in the browser. |

## Design notes

### Why a supplier dashboard, not a spreadsheet of scores

An earlier approach to this problem is a spreadsheet: one row per supplier, one score per dimension. The problem with that shape: a score alone doesn't tell a reviewer *why* — they have to go back to the raw documents to justify an escalate-or-reject decision. A dashboard with one supplier selected and its score, evidence, concerns, and source documents all on screen at once does that justification for the reviewer, before they ever need to reopen the original files.

### Why AI scoring is blended with a rule-based baseline, not a pure model call

The app is deployed on GitHub Pages over HTTPS, which blocks calls to a local Ollama instance as mixed content — so a pure model-only design would simply not work in the hosted demo. Instead, `scoring.js` always computes a deterministic rule-based score first, then blends in the AI-derived score when Ollama is reachable. The reviewer workflow — score, evidence, concerns, decision — never depends on whether a model call succeeds.

## How it's built

```
.
├── index.html       Supplier list, upload modal, reviewer dashboard (UI shell)
├── documents.js     Client-side document parsing (pdf.js / mammoth.js) and
│                     evidence/concerns extraction from parsed text
├── scoring.js       Risk scoring engine: Ollama (Mistral) calls when reachable,
│                     deterministic rule-based fallback, weighted score blending
├── styles.css       App styling
└── README.md
```

Static parsing vs. LLM scoring are deliberately separate. `documents.js` extracts plain text and evidence spans from uploaded PDFs and Word documents before any model is involved. `scoring.js` then either asks the local Ollama model to score that text, or — if unreachable — scores it with the deterministic rule-based engine, so the reviewer workflow never comes back with a section missing.

## Change history and contributors

This is an active proof-of-concept, built using an AI Risk Scoring Engine approach — one of three approaches researched and selected for this project. See the repository's commit history for subsequent changes.
