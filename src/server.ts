import { Hono } from "hono";
import { serve } from "bun";
import { parse } from "yaml";
import { mkdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { readdirSync, statSync, existsSync, watch } from "fs";
import { initDb, saveRun, finishRun, saveModelResultsBatch, listRuns, getRunResults, getDb, compareRuns } from "./tester/db.ts";
import { NetworkSelector } from "./tester/network.ts";
import { ModelFetcher } from "./tester/model_fetcher.ts";
import { bulkInitMeta } from "./tester/metaFetcher.ts";
import { ModelCategorizer } from "./tester/categorizer.ts";
import { TestRunner } from "./tester/runner.ts";
import { scoreModel, rankCategory } from "./tester/scorer.ts";
import { inferUseCases } from "./tester/useCase.ts";
import { saveExcelReport, generateExcelForRun } from "./tester/excelReport.ts";
import { streamSSE } from "hono/streaming";
import type { ModelResult, ScoredModel } from "./tester/types.ts";

// Initialize the database
initDb();

const app = new Hono();

interface RunConfigOverride {
  api_keys?: string[];
  base_url?: string;
  proxy?: string;
  concurrency?: number;
  required_only?: boolean;
  rate_limit_per_key?: number;
  _profile?: string;
}

// ── Global State ─────────────────────────────────────────────────────────────
let currentConfig: any = null;

async function loadConfig(): Promise<any> {
  const text = await Bun.file("config.yaml").text();
  currentConfig = parse(text);
  return currentConfig;
}

const _events: any[] = [];
let _eventIdCounter = 0;

const _runState = {
  running: false,
  results: null as any,
  scored: null as any,
  run_id: null as string | null,
  meta: null as any,
};

function _emit(event: any) {
  const ev = { ...event, id: _eventIdCounter++ };
  _events.push(ev);
  if (_events.length > 2000) {
    _events.shift(); // Prevent memory bloat during long runs
  }
}

// ── Intercept Console Logs to SSE ───────────────────────────────────────────
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatArgs(args: any[]): string {
  return args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
    .join(" ");
}

console.log = (...args: any[]) => {
  originalLog(...args);
  if (_runState.running) {
    _emit({ type: "log", level: "info", msg: formatArgs(args) });
  }
};

console.error = (...args: any[]) => {
  originalError(...args);
  if (_runState.running) {
    _emit({ type: "log", level: "error", msg: formatArgs(args) });
  }
};

console.warn = (...args: any[]) => {
  originalWarn(...args);
  if (_runState.running) {
    _emit({ type: "log", level: "warning", msg: formatArgs(args) });
  }
};

// ── Web Server Routes ────────────────────────────────────────────────────────
app.get("/", async (c) => {
  try {
    const fileContent = await Bun.file("static/index.html").text();
    return c.html(fileContent);
  } catch (e: any) {
    return c.text("static/index.html not found", 404);
  }
});

app.get("/api/config", (c) => {
  if (!currentConfig) {
    return c.json({ ok: false, msg: "配置未加载" }, 500);
  }
  return c.json(currentConfig);
});

// ── Profiles Management ──────────────────────────────────────────────────────
async function loadProfiles(): Promise<any> {
  const file = Bun.file("profiles.json");
  if (await file.exists()) {
    try {
      const text = await file.text();
      return JSON.parse(text);
    } catch (e) {
      // ignore
    }
  }
  return { profiles: [], last_used: "" };
}

async function saveProfiles(data: any): Promise<void> {
  await Bun.write("profiles.json", JSON.stringify(data, null, 2));
}

app.get("/api/profiles", async (c) => {
  const data = await loadProfiles();
  return c.json(data);
});

app.post("/api/profiles", async (c) => {
  try {
    const p = await c.req.json<any>();
    if (!p || !p.name) {
      return c.json({ ok: false, msg: "Invalid profile data" }, 400);
    }
    const data = await loadProfiles();
    const profiles = data.profiles || [];
    const idx = profiles.findIndex((x: any) => x.name === p.name);
    if (idx !== -1) {
      profiles[idx] = p;
      data.last_used = p.name;
      await saveProfiles(data);
      return c.json({ ok: true, action: "updated" });
    }
    profiles.push(p);
    data.last_used = p.name;
    await saveProfiles(data);
    return c.json({ ok: true, action: "created" });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) }, 500);
  }
});

app.delete("/api/profiles/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const data = await loadProfiles();
    const before = data.profiles ? data.profiles.length : 0;
    data.profiles = (data.profiles || []).filter((x: any) => x.name !== name);
    if (data.last_used === name) {
      data.last_used = data.profiles.length > 0 ? data.profiles[0]!.name : "";
    }
    await saveProfiles(data);
    const deleted = before - data.profiles.length;
    return c.json({ ok: true, deleted });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) }, 500);
  }
});

// ── In-memory Run Results ────────────────────────────────────────────────────
app.get("/api/results", (c) => {
  if (!_runState.scored) {
    return c.json({ ok: false, msg: "暂无结果" });
  }
  return c.json({ ok: true, scored: _runState.scored });
});

// ── History Database ─────────────────────────────────────────────────────────
app.get("/api/history", (c) => {
  try {
    const runs = listRuns(20);
    return c.json({ ok: true, runs });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) });
  }
});

app.get("/api/history/:runId", (c) => {
  const runId = c.req.param("runId");
  try {
    const results = getRunResults(runId);
    return c.json({ ok: true, run_id: runId, results });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) });
  }
});

// ── Compare Runs ─────────────────────────────────────────────────────────────
app.get("/api/compare/:runId1/:runId2", (c) => {
  const runId1 = c.req.param("runId1");
  const runId2 = c.req.param("runId2");
  try {
    const comparison = compareRuns(runId1, runId2);
    return c.json({ ok: true, comparison });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) }, 500);
  }
});

// ── Catalog Stats ────────────────────────────────────────────────────────────
app.get("/api/catalog/stats", async (c) => {
  const catPath = "data/model_catalog.json";
  try {
    if (!(await Bun.file(catPath).exists())) {
      return c.json({ ok: false, msg: "catalog 未生成，请运行 tools/build_catalog.ts/py" });
    }
    const text = await Bun.file(catPath).text();
    const catalog = JSON.parse(text);
    const entries = Object.values(catalog) as any[];
    const total = entries.length;
    const has_params = entries.filter((e) => e.param_count).length;
    const has_date = entries.filter((e) => e.release_date).length;
    const hf_matched = entries.filter((e) => e.hf_pipeline_tag).length;
    const updated_at = entries.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), "");
    return c.json({
      ok: true,
      total,
      has_params,
      has_date,
      hf_matched,
      updated_at,
    });
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) });
  }
});

// ── Excel Exports ────────────────────────────────────────────────────────────
app.get("/api/export/excel", async (c) => {
  if (!existsSync("results")) {
    return c.json({ ok: false, msg: "暂无报告，请先运行测试" }, 404);
  }
  const dirs = readdirSync("results")
    .map((name) => join("results", name))
    .filter((p) => statSync(p).isDirectory());

  const reports = dirs
    .map((d) => join(d, "report.xlsx"))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

  if (reports.length === 0) {
    return c.json({ ok: false, msg: "暂无报告，请先运行测试" }, 404);
  }

  const latest = reports[reports.length - 1]!;
  const fileContent = Bun.file(latest);
  c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  c.header("Content-Disposition", `attachment; filename="model_report_${basename(dirname(latest))}.xlsx"`);
  return c.body(await fileContent.arrayBuffer());
});

app.get("/api/export/excel/:runId", async (c) => {
  const runId = c.req.param("runId");
  try {
    const buffer = await generateExcelForRun(runId);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="model_report_${runId}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  } catch (e: any) {
    return c.json({ ok: false, msg: e.message || String(e) }, 500);
  }
});

// ── SSE Server-Sent Events Endpoint ──────────────────────────────────────────
app.get("/api/events", async (c) => {
  const sinceStr = c.req.query("since");
  const since = sinceStr ? parseInt(sinceStr, 10) : 0;

  return streamSSE(c, async (stream) => {
    let lastSentId = since - 1;
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    while (!closed) {
      const eventsList = [..._events];
      const newEvents = eventsList.filter((ev) => ev.id > lastSentId);

      if (newEvents.length > 0) {
        for (const ev of newEvents) {
          await stream.writeSSE({
            data: JSON.stringify(ev),
          });
          lastSentId = ev.id;
        }
      } else {
        if (eventsList.length > 0 && eventsList[eventsList.length - 1].type === "complete") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  });
});

// ── Start Test Run Pipeline ──────────────────────────────────────────────────
app.post("/api/run", async (c) => {
  if (_runState.running) {
    return c.json({ ok: false, msg: "测试已在运行中" });
  }
  _events.length = 0;
  _eventIdCounter = 0;
  _runState.running = true;
  _runState.results = null;
  _runState.scored = null;

  let overrides: RunConfigOverride = {};
  try {
    overrides = await c.req.json();
  } catch (e) {
    // ignore empty/invalid body
  }

  // Run the pipeline in the background asynchronously
  runPipeline(overrides).catch((err) => {
    originalError("Background test run error:", err);
  });

  return c.json({ ok: true });
});

// ── Run Pipeline Implementation ──────────────────────────────────────────────
async function runPipeline(overrides: RunConfigOverride = {}) {
  const config = await loadConfig();

  // Apply UI overrides
  if (overrides.api_keys && overrides.api_keys.length > 0) {
    config.api_keys = overrides.api_keys.map((k) => k.trim()).filter(Boolean);
  }
  if (overrides.base_url) {
    config.api = config.api || {};
    config.api.base_url = overrides.base_url.replace(/\/+$/, "");
  }
  if (overrides.proxy !== undefined) {
    config.network = config.network || {};
    config.network.proxy = overrides.proxy;
  }
  if (overrides.concurrency) {
    config.testing = config.testing || {};
    config.testing.concurrency = Number(overrides.concurrency);
  }
  if (overrides.required_only !== undefined) {
    config.testing = config.testing || {};
    config.testing.required_only = !!overrides.required_only;
  }
  if (overrides.rate_limit_per_key !== undefined) {
    config.testing = config.testing || {};
    config.testing.rate_limit_per_key = Number(overrides.rate_limit_per_key);
  }

  const runId = crypto.randomUUID().replace(/-/g, "").substring(0, 12);
  const runStarted = new Date().toISOString().slice(0, 19);
  const profileName = overrides._profile || "";

  // Save the run to DB
  saveRun(runId, profileName, config.api.base_url, config, runStarted);
  _runState.run_id = runId;
  let totalModels = 0;

  try {
    // Step 1: network selection
    _emit({ type: "step", step: 1, label: "自动测速..." });
    const selector = new NetworkSelector(config);
    const [bestMode, latency] = await selector.selectBest();
    _emit({ type: "step_done", step: 1, label: `最优路径: ${bestMode}（${latency.toFixed(0)}ms）` });

    // Step 2: fetch models
    _emit({ type: "step", step: 2, label: "拉取全量模型列表..." });
    const fetcher = new ModelFetcher(config, bestMode);
    const models = await fetcher.fetchAll();
    const modelIds = models.map((m: any) => m.id);
    _emit({ type: "step_done", step: 2, label: `获取 ${models.length} 个模型` });

    // Step 2.5: meta fetch
    _emit({ type: "step", step: 25, label: `同步模型元数据（${models.length} 个）...` });
    const proxy = config.network?.proxy || "";
    const allMeta = await bulkInitMeta(modelIds, proxy);
    _runState.meta = allMeta;
    _emit({ type: "step_done", step: 25, label: `元数据就绪（${Object.keys(allMeta).length} 个模型）` });

    // Step 3: grouping
    _emit({ type: "step", step: 3, label: "模型智能分组..." });
    const categorizer = new ModelCategorizer(config);
    const groups = categorizer.categorize(models);
    const catConf = config.model_categories || {};
    const groupsInfo: Record<string, any> = {};
    for (const [k, v] of Object.entries(groups)) {
      groupsInfo[k] = {
        count: v.length,
        desc: catConf[k]?.description || k,
      };
    }
    _emit({ type: "groups", groups: groupsInfo });
    _emit({ type: "step_done", step: 3, label: `共 ${Object.keys(groups).length} 个分类` });

    // Step 4: test
    _emit({ type: "step", step: 4, label: "分类测试中..." });
    totalModels = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
    let doneCount = 0;

    const onModelDone = async (resultList: ModelResult[]) => {
      doneCount++;
      const first = resultList[0];
      if (first) {
        const mid = first.model_id;
        const cat = first.category;
        const passed = resultList.filter((r) => r.status === "pass").length;
        _emit({
          type: "model_done",
          model_id: mid,
          category: cat,
          passed,
          total: resultList.length,
          done: doneCount,
          total_models: totalModels,
        });
      }
    };

    const runner = new TestRunner(config, bestMode, onModelDone);
    const results = await runner.runAll(groups);
    _emit({ type: "step_done", step: 4, label: "测试完成" });

    // Step 5: score + report
    _emit({ type: "step", step: 5, label: "生成评分与报告..." });
    const scored = buildScored(results, config);
    _runState.results = results;
    _runState.scored = scored;

    // Write to SQLite history (batch transaction)
    try {
      const batchItems: any[] = [];
      for (const [cat, data] of Object.entries(scored)) {
        for (const [mid, m] of Object.entries((data as any).models)) {
          batchItems.push({
            model_id: mid,
            category: cat,
            scored_model: m,
            raw_results: (m as any).results || [],
          });
        }
      }
      saveModelResultsBatch(runId, batchItems);
      finishRun(runId, new Date().toISOString().slice(0, 19), totalModels);
    } catch (dbErr: any) {
      originalError(`DB 持久化失败（不影响主流程）: ${dbErr.message || dbErr}`);
    }

    // Save JSON files
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const outDir = `results/${ts}`;
    await mkdir(outDir, { recursive: true });

    await Bun.write(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    await Bun.write(join(outDir, "scored.json"), JSON.stringify(scored, null, 2));

    // Save Excel
    try {
      await saveExcelReport(results, scored, config, outDir);
    } catch (e: any) {
      originalWarn(`Excel 生成失败: ${e.message || e}`);
    }

    _emit({ type: "step_done", step: 5, label: `报告已保存: ${outDir}` });

    // Construct scored summary without full raw results to send to UI
    const scoredSummary: Record<string, any> = {};
    for (const [cat, data] of Object.entries(scored)) {
      const modelsCopy: Record<string, any> = {};
      for (const [mid, m] of Object.entries((data as any).models)) {
        const copy = { ...((m as any) || {}) };
        delete copy.results;
        modelsCopy[mid] = copy;
      }
      scoredSummary[cat] = {
        description: (data as any).description,
        models: modelsCopy,
      };
    }

    _emit({
      type: "complete",
      scored: scoredSummary,
      out_dir: outDir,
      run_id: runId,
    });
  } catch (e: any) {
    originalError(`流程异常:`, e);
    _emit({ type: "error", msg: e.message || String(e) });
  } finally {
    _runState.running = false;
  }
}

function buildScored(results: Record<string, ModelResult[]>, config: any): Record<string, any> {
  const catConf = config.model_categories || {};
  const output: Record<string, any> = {};

  for (const [category, catResults] of Object.entries(results)) {
    const desc = catConf[category]?.description || category;

    // Group by model_id
    const byModel: Record<string, ModelResult[]> = {};
    for (const r of catResults) {
      if (!byModel[r.model_id]) {
        byModel[r.model_id] = [];
      }
      byModel[r.model_id]!.push(r);
    }

    // Score models
    const modelScores: Record<string, ScoredModel> = {};
    for (const [mid, rs] of Object.entries(byModel)) {
      modelScores[mid] = scoreModel(rs!);
    }

    const ranked = rankCategory(modelScores);

    // Add use cases and raw results
    for (const [mid, rs] of Object.entries(byModel)) {
      const useCases = inferUseCases(rs!, category);
      if (ranked[mid]) {
        ranked[mid]!.use_cases = useCases;
        ranked[mid]!.use_cases_str = useCases.join("、");
        (ranked[mid] as any).results = rs;
      }
    }

    output[category] = {
      description: desc,
      models: ranked,
    };
  }

  return output;
}

// ── Load Config & Start File Watcher ─────────────────────────────────────────
await loadConfig();

watch("config.yaml", (event) => {
  if (event === "change") {
    console.log("🔄 配置文件已更新，重新加载...");
    loadConfig()
      .then(() => console.log("✅ 配置重新加载成功"))
      .catch((e) => console.error("❌ 配置重新加载失败:", e.message || e));
  }
});

// ── Start Server ─────────────────────────────────────────────────────────────
serve({
  port: 28080,
  fetch: app.fetch,
});

console.log("🚀 Bun/Hono Web Server started on http://localhost:28080");
