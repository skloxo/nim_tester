import ExcelJS from "exceljs";
import { join } from "path";
import { parse } from "yaml";
import { getDb, getRunResults } from "./db.ts";
import type { ModelResult, ScoredModel } from "./types.ts";

export async function saveExcelReport(
  results: Record<string, ModelResult[]>,
  scored: Record<string, { description: string; models: Record<string, ScoredModel & { use_cases_str?: string }> }>,
  config: any,
  outDir: string
): Promise<string> {
  const workbook = new ExcelJS.Workbook();

  // 1. 总览 Sheet
  const wsSummary = workbook.addWorksheet("总览");
  const summaryHeaders = ["分类", "模型数", "平均分", "最高分", "第一名", "通过率"];
  wsSummary.addRow(summaryHeaders);

  // Style Header function
  const styleHeader = (worksheet: ExcelJS.Worksheet, colCount: number) => {
    const headerRow = worksheet.getRow(1);
    headerRow.height = 24;
    for (let col = 1; col <= colCount; col++) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1E40AF" }, // Dark Blue #1E40AF
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
  };

  styleHeader(wsSummary, summaryHeaders.length);

  for (const [cat, data] of Object.entries(scored)) {
    const models = data.models;
    const modelEntries = Object.entries(models);
    if (modelEntries.length === 0) continue;

    const scores = modelEntries.map(([_, m]) => m.score);
    
    // Find model with rank = 1 or minimum rank
    let topName = "";
    let minRank = Infinity;
    for (const [mid, m] of modelEntries) {
      const r = m.rank ?? 999;
      if (r < minRank) {
        minRank = r;
        topName = mid;
      }
    }

    const catResults = results[cat] || [];
    const total = catResults.length;
    const passed = catResults.filter((r) => r.status === "pass").length;
    
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const passRate = total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : "N/A";

    wsSummary.addRow([
      data.description || cat,
      modelEntries.length,
      Math.round(avgScore * 10) / 10,
      maxScore,
      topName,
      passRate,
    ]);
  }

  // Adjust column widths for Summary
  wsSummary.columns.forEach((column) => {
    let maxLength = 0;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const val = cell.value ? String(cell.value) : "";
      if (val.length > maxLength) maxLength = val.length;
    });
    column.width = Math.min(Math.max(maxLength + 4, 15), 50);
  });

  // 2. 每个分类一个 Sheet
  const gradeColors: Record<string, string> = {
    "S": "FF7B2FBE",
    "A": "FF1D4ED8",
    "B": "FF047857",
    "C": "FFB45309",
    "D": "FF9CA3AF",
    "F": "FFDC2626",
  };

  for (const [cat, data] of Object.entries(scored)) {
    const desc = data.description || cat;
    // Clean sheet name: Excel allows max 31 chars, no / \ ? * [ ] :
    const safeTitle = desc.replace(/[/\\?*[\]:]/g, "_").slice(0, 31);
    
    const wsCat = workbook.addWorksheet(safeTitle);
    const detailHeaders = ["排名", "模型 ID", "评分", "等级", "通过/总用例", "TPS", "推荐场景"];
    wsCat.addRow(detailHeaders);
    styleHeader(wsCat, detailHeaders.length);

    const sortedModels = Object.entries(data.models).sort((a, b) => (a[1].rank || 999) - (b[1].rank || 999));

    for (const [mid, m] of sortedModels) {
      const rankVal = m.rank || 999;
      const rankStr = rankVal === 1 ? "🥇" : rankVal === 2 ? "🥈" : rankVal === 3 ? "🥉" : `#${rankVal}`;
      const ucDisplay = m.use_cases_str || (m.use_cases || []).join("、");

      const row = wsCat.addRow([
        rankStr,
        mid,
        m.score,
        m.grade,
        `${m.passed}/${m.total}`,
        m.avg_tps,
        ucDisplay,
      ]);

      const scoreCell = row.getCell(3);
      const grade = m.grade || "F";
      const color = gradeColors[grade] || "FF9CA3AF";
      scoreCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: color },
      };
      scoreCell.font = {
        color: { argb: "FFFFFFFF" },
        bold: true,
      };
    }

    wsCat.columns.forEach((column) => {
      column.width = 20;
    });
  }

  const outputPath = join(outDir, "report.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

export async function generateExcelForRun(runId: string): Promise<Buffer> {
  const results = getRunResults(runId);
  if (!results || results.length === 0) {
    throw new Error("未找到该 Run 的测试数据");
  }

  // Load category Descriptions
  const catDescs: Record<string, string> = {};
  try {
    const configText = await Bun.file("config.yaml").text();
    const cfg = parse(configText);
    for (const [k, v] of Object.entries(cfg.model_categories || {})) {
      catDescs[k] = (v as any).description || k;
    }
  } catch (e) {
    // ignore
  }

  // Load metadata from model_meta_cache
  const modelIds = Array.from(new Set(results.map((r) => r.model_id)));
  const metaMap: Record<string, any> = {};
  if (modelIds.length > 0) {
    try {
      const db = getDb();
      const placeholders = modelIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT model_id, param_count, max_context, release_date, hf_pipeline_tag 
         FROM model_meta_cache WHERE model_id IN (${placeholders})`
      ).all(...modelIds) as any[];
      for (const row of rows) {
        metaMap[row.model_id] = row;
      }
    } catch (e) {
      console.warn("Failed to load metadata cache:", e);
    }
  }

  // Group by category and sort by rank
  const byCat: Record<string, any[]> = {};
  for (const row of results) {
    let catList = byCat[row.category];
    if (!catList) {
      catList = [];
      byCat[row.category] = catList;
    }
    catList.push(row);
  }

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("模型测试报告");

  const HEADERS = [
    "模型 ID", "分类", "排名", "评分", "等级",
    "通过用例", "总用例数", "通过率(%)",
    "Tokens/s (均值)", "平均响应时间(ms)",
    "参数量(B)", "上下文长度(tokens)", "发布日期", "推荐场景"
  ];

  // Header row
  const headerRow = ws.addRow(HEADERS);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E2A40" }, // #1E2A40
    };
    cell.font = {
      bold: true,
      color: { argb: "FFA5B4FC" }, // #A5B4FC
      size: 11
    };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  for (const [cat, rows] of Object.entries(byCat)) {
    const catCn = catDescs[cat] || cat;
    const sorted = rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));

    for (const r of sorted) {
      const mid = r.model_id;
      const meta = metaMap[mid] || {};
      const uc = r.use_cases || [];
      const ucStr = uc.join("、");

      // Calculate avg_elapsed from results_json
      let avgElapsed: number | null = null;
      try {
        const rawResults = r.results_json || [];
        const elapsedVals = rawResults
          .filter((res: any) => res.elapsed_ms && res.status === "pass")
          .map((res: any) => res.elapsed_ms);
        if (elapsedVals.length > 0) {
          avgElapsed = Math.round(
            elapsedVals.reduce((a: number, b: number) => a + b, 0) / elapsedVals.length
          );
        }
      } catch (e) {
        // ignore
      }

      const passed = r.passed ?? 0;
      const total = r.total ?? 0;
      const passRate = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
      const tps = r.avg_tps ?? null;

      ws.addRow([
        mid,
        catCn,
        r.rank,
        r.score,
        r.grade,
        passed,
        total,
        passRate,
        tps ? Math.round(tps * 100) / 100 : null,
        avgElapsed,
        meta.param_count ?? null,
        meta.max_context ?? null,
        meta.release_date ?? null,
        ucStr,
      ]);
    }
  }

  // Auto column widths
  ws.columns.forEach((column) => {
    let maxLength = 0;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const val = cell.value ? String(cell.value) : "";
      if (val.length > maxLength) maxLength = val.length;
    });
    column.width = Math.min(Math.max(maxLength + 4, 12), 50);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
