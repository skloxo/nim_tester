import { parse } from "yaml";
import { join } from "path";
import { mkdir } from "fs/promises";
import { initDb, saveRun, finishRun, saveModelResultsBatch } from "./tester/db.ts";
import { NetworkSelector } from "./tester/network.ts";
import { ModelFetcher } from "./tester/model_fetcher.ts";
import { bulkInitMeta } from "./tester/metaFetcher.ts";
import { ModelCategorizer } from "./tester/categorizer.ts";
import { TestRunner } from "./tester/runner.ts";
import { scoreModel, rankCategory } from "./tester/scorer.ts";
import { inferUseCases } from "./tester/useCase.ts";
import { saveExcelReport } from "./tester/excelReport.ts";
import type { ModelResult, ScoredModel } from "./tester/types.ts";

const BANNER = `
╔══════════════════════════════════════════════════════════╗
║          API 模型全量测试框架  v1.1.0                    ║
║          支持 NVIDIA / OpenAI 兼容接口                   ║
╚══════════════════════════════════════════════════════════╝
`;

async function main() {
  console.log(BANNER);

  // Initialize DB
  initDb();

  // Load config
  const configText = await Bun.file("config.yaml").text();
  const config = parse(configText);

  const runId = crypto.randomUUID().replace(/-/g, "").substring(0, 12);
  const runStarted = new Date().toISOString().slice(0, 19);

  // 1. Network Selection
  console.log("🌐 Step 1/5  自动测速，选择最优网络路径...");
  const selector = new NetworkSelector(config);
  const [bestMode, latency] = await selector.selectBest();
  console.log(`  ✅ 最优路径：${bestMode}（平均延迟 ${latency.toFixed(0)}ms）`);

  // 2. Fetch Models
  console.log("📋 Step 2/5  拉取全量模型列表...");
  const fetcher = new ModelFetcher(config, bestMode);
  const models = await fetcher.fetchAll();
  const modelIds = models.map((m: any) => m.id);
  console.log(`  ✅ 共获取 ${models.length} 个模型`);

  // 2.5 Meta Fetch
  console.log("🧬 Step 2.5  同步模型元数据...");
  const proxy = config.network?.proxy || "";
  const allMeta = await bulkInitMeta(modelIds, proxy);
  console.log(`  ✅ 元数据就绪（${Object.keys(allMeta).length} 个模型）`);

  // 3. Model Categorize
  console.log("🗂️  Step 3/5  模型智能分组...");
  const categorizer = new ModelCategorizer(config);
  const groups = categorizer.categorize(models);
  for (const [cat, items] of Object.entries(groups)) {
    const desc = config.model_categories?.[cat]?.description || cat;
    console.log(`  📂 ${desc}：${items.length} 个`);
  }

  // Save run to DB
  saveRun(runId, "", config.api.base_url, config, runStarted);

  // 4. Test Runner
  const concurrency = config.testing?.concurrency || 5;
  console.log(`🧪 Step 4/5  开始分类测试（并发=${concurrency}）...`);
  const runner = new TestRunner(config, bestMode);
  const results = await runner.runAll(groups);

  // 5. Scoring + Reporting
  console.log("📊 Step 5/5  生成评分报告...");
  const scored = buildScored(results, config);
  printScoredSummary(scored);

  const totalModels = Object.values(groups).reduce((sum, list) => sum + list.length, 0);

  // Write to DB
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
    console.error(`DB 持久化失败: ${dbErr.message || dbErr}`);
  }

  // Save JSON
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const outDir = `results/${ts}`;
  await mkdir(outDir, { recursive: true });

  await Bun.write(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  
  // Scored output formatting (strip raw results for scored.json)
  const scoredOutput: Record<string, any> = {};
  for (const [cat, data] of Object.entries(scored)) {
    const modelsCopy: Record<string, any> = {};
    for (const [mid, m] of Object.entries((data as any).models)) {
      const copy = { ...((m as any) || {}) };
      delete copy.results;
      modelsCopy[mid] = copy;
    }
    scoredOutput[cat] = {
      description: (data as any).description,
      models: modelsCopy,
    };
  }
  await Bun.write(join(outDir, "scored.json"), JSON.stringify(scoredOutput, null, 2));
  console.log(`  ✅ 结果已保存至：${outDir}`);

  // Save Excel
  try {
    const excelPath = await saveExcelReport(results, scored, config, outDir);
    console.log(`  ✅ Excel 报告：${excelPath}`);
  } catch (e: any) {
    console.warn(`Excel 生成跳过：${e.message || e}`);
  }
}

function buildScored(results: Record<string, ModelResult[]>, config: any): Record<string, any> {
  const catConf = config.model_categories || {};
  const output: Record<string, any> = {};

  for (const [category, catResults] of Object.entries(results)) {
    const desc = catConf[category]?.description || category;
    const byModel: Record<string, ModelResult[]> = {};
    for (const r of catResults) {
      if (!byModel[r.model_id]) {
        byModel[r.model_id] = [];
      }
      byModel[r.model_id]!.push(r);
    }

    const modelScores: Record<string, ScoredModel> = {};
    for (const [mid, rs] of Object.entries(byModel)) {
      modelScores[mid] = scoreModel(rs!);
    }

    const ranked = rankCategory(modelScores);

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

function printScoredSummary(scored: Record<string, any>) {
  for (const [_, data] of Object.entries(scored)) {
    const desc = data.description;
    const models = Object.entries(data.models);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${desc}（${models.length} 个模型）`);
    console.log(`${"=".repeat(60)}`);
    
    console.log(
      `  ${"排名".padEnd(4)} ${"评分".padEnd(6)} ${"等级".padEnd(4)} ${"通过/总".padEnd(8)} ${"TPS".padEnd(7)} 推荐场景`
    );
    console.log(`  ${"-".repeat(75)}`);

    const sorted = models.sort((a, b) => ((a[1] as any).rank || 99) - ((b[1] as any).rank || 99));

    for (const [mid, mRaw] of sorted) {
      const m = mRaw as any;
      const rankIcon = m.rank === 1 ? "🥇" : m.rank === 2 ? "🥈" : m.rank === 3 ? "🥉" : `#${m.rank}`;
      const scoreStr = m.score.toFixed(1);
      const gradeStr = m.grade.padEnd(4);
      const passedStr = `${m.passed}/${m.total}`.padEnd(8);
      const tpsStr = m.avg_tps.toFixed(1).padEnd(7);
      const useCasesDisplay = m.use_cases_str || (m.use_cases || []).join("、");
      
      const shortId = mid.split("/").pop() || "";
      const displayId = shortId.substring(0, 25).padEnd(25);

      console.log(
        `  ${rankIcon.padEnd(4)} ${scoreStr.padEnd(6)} ${gradeStr} ${passedStr} ${tpsStr} [${displayId}] ${useCasesDisplay}`
      );
    }
  }
}

main().catch((err) => {
  console.error("Fatal run error:", err);
});
