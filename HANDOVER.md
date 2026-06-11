# API Model Benchmarking Framework (nim_tester) Handover Document

Welcome, agent! This document contains the necessary context, architecture breakdown, and next steps for continuing the optimization and iteration of this benchmarking project.

---

## 1. Project Overview & Context
This project is an automated testing and evaluation framework for LLMs and other API-based models (NVIDIA NIM, OpenAI compatible APIs, embeddings, rerankers, multimodal, etc.). 
- **Legacy Stack**: Originally built in Python (`python_legacy/`).
- **Current Stack**: Fully rewritten in **TypeScript + Bun** for maximum performance, concurrent network request speed, and developer simplicity.
- **Goal**: Read available models from remote APIs, categorize them, execute 9 categories of test cases with concurrency control and rotating API keys, score them, recommend use cases, and generate Excel reports or serve a control dashboard.

---

## 2. System Architecture
All main source files are under `src/`. Here is a quick guide to what each component does:

### A. Core Engine (`src/tester/`)
* **types.ts**: Core type declarations (`TestCase`, `ModelResult`, `ScoredModel`, `RunRecord`).
* **cases.ts**: Declares all `TestCase` objects for 9 categories: `general_chat`, `vision_language`, `reasoning`, `code`, `text_embedding`, `multimodal_embedding`, `reranker`, `image_generation`, and `audio`.
* **db.ts**: Database wrapper using `bun:sqlite`. Uses WAL mode (`PRAGMA journal_mode = WAL`), busy timeout, and transactions for batch inserts.
* **network.ts**: Automatic path latency testing. Measures latency via direct connections vs configured proxy and configures the optimal path dynamically.
* **model_fetcher.ts**: Automates model fetching from the provider's `/models` endpoint.
* **metaFetcher.ts**: Merges locally cached model data (`data/model_catalog.json`) with HuggingFace Hub live API queries to populate parameters, release dates, and context lengths.
* **categorizer.ts**: Sorts models into appropriate categories (e.g. VLM, Embeddings, Rerank, Code) using include/exclude rules.
* **runner.ts**: Handles the main execution pipeline. Includes `KeyRotator` for rotating API keys and sliding window rate limits. *Note: wait durations happen outside of the concurrency semaphore to avoid blocking active connection slots.*
* **scorer.ts**: Calculates model grades (S, A, B, C, D, F) based on pass rates, avg_tps, and hard constraints (e.g. context window limits and low TPS caps).
* **useCase.ts**: Recommends real-world scenarios (RAG, Agents, Real-time chat) using parameter count, context size, and average speed.
* **excelReport.ts**: Exporter utilizing `exceljs` to generate well-styled multi-sheet reports.

### B. Entry Points
* **main.ts**: The command line entry point. Runs the full test sequence.
* **server.ts**: A Hono web server serving API endpoints and streaming log events using SSE (Server-Sent Events).
* **static/index.html**: The single-page frontend application for managing runs and viewing history.

---

## 3. Configuration & Authentication
* **config.yaml**: Configures backend URL paths, proxy settings, concurrency limits, and model categorizer patterns.
* **profiles.json**: Stores rotating API Keys. (Currently desensitized with placeholder keys: `"YOUR_NVIDIA_API_KEY_HERE"`). Ensure valid keys are inserted before launching tests.

---

## 4. Run Guide

### Locally (Native WSL with Bun)
1. Double-click `启动WebUI.bat` to launch the Hono server in the background and open the web dashboard in your default browser.
2. Run the CLI benchmark manually inside WSL:
   ```bash
   bun run src/main.ts
   ```

### Using Docker (Containerized)
1. Double-click `启动Docker.bat` to build and launch the containerized application.
2. The dashboard will be accessible at `http://localhost:28080`.

---

## 5. Next Steps for Optimization & Iteration
Incoming agents should focus on the following high-priority areas:

### 🚀 Optimization 1: Real-time UI Enhancements
* Currently, the frontend dashboard `static/index.html` is a single-page HTML with basic styling.
* **Action**: Integrate charting (e.g., using Chart.js or Tailwind/Lucide charts via CDN) to plot comparison charts of TPS vs latency, model size vs score, and speed trends.
* **Action**: Show live streaming logs via SSE in a terminal-like auto-scroll viewport on the UI.

### 🧪 Optimization 2: Modality & TestCase Expansion
* Expand the test coverage inside `src/tester/cases.ts`.
* **Action**: Add more multimodal embedding/rerank verification scenarios (e.g., cross-lingual search or document embeddings).
* **Action**: Enhance reasoning checks (e.g., math verification using programmatic output checks, or structured JSON schema adherence).

### ⚙️ Optimization 3: Provider Abstraction
* The framework is primarily geared towards NVIDIA NIM and OpenAI-compatible endpoints.
* **Action**: Abstract the fetch and call endpoints to fully support other providers (like local Ollama, DeepSeek API, Anthropic, or Gemini) with customized HTTP headers, token counting algorithms, and payload wrappers.

### 📂 Optimization 4: Database Maintenance
* Over time, SQLite runs history can accumulate large raw request logs.
* **Action**: Add database pruning endpoints or scripts to purge raw logs of runs older than N days while keeping aggregate scored results.

Good luck! Refer to `DEVELOPER.md` for database schemas and detail formulas.
