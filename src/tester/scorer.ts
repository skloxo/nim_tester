import type { ModelResult, ScoredModel } from "./types.ts";

// 各测试用例权重（满分 90，另 10 分来自速度）
export const TEST_WEIGHTS: Record<string, number> = {
  basic_availability: 30,
  chinese_support: 10,
  tool_calling: 20,
  streaming: 10,
  think_on: 8,
  think_off: 4,
  long_context: 8,
  code_generation: 30,
  code_completion: 15,
  code_debugging: 30,
  code_explanation: 15,
  basic_embedding: 40,
  batch_embedding: 30,
  query_embedding: 30,
  vlm_image_understanding: 30,
  multi_image: 15,
  basic_rerank: 100,
  text2image: 100,
  basic: 20,
  math_reasoning: 30,
  cot_output: 30,
  logic_puzzle: 20,
  text_via_clip: 50,
  image_via_clip: 50,
  tts: 100,
};

export const GRADE_MAP: [number, string][] = [
  [85, "S"],
  [70, "A"],
  [55, "B"],
  [40, "C"],
  [20, "D"],
  [0, "F"],
];

export function getGradeFromScore(score: number): string {
  for (const [threshold, grade] of GRADE_MAP) {
    if (score >= threshold) {
      return grade;
    }
  }
  return "F";
}

/**
 * 计算单个模型的综合评分（0-90 的基础分段）
 */
export function scoreModel(
  results: ModelResult[],
  maxContext?: number,
  paramCount?: number
): ScoredModel {
  let weightedSum = 0;
  let totalWeight = 0;
  const tpsList: number[] = [];
  const elapsedList: number[] = [];

  for (const r of results) {
    const status = r.status || "";
    if (status === "skip") {
      continue; // skip = 模型不支持该功能，不计入评分分母
    }
    const testName = r.test || "";
    const w = TEST_WEIGHTS[testName] || 0;
    if (w > 0) {
      totalWeight += w;
      if (status === "pass") {
        weightedSum += w;
      }
    }
    if (r.tps && r.tps > 0) {
      tpsList.push(r.tps);
    }
    if (r.elapsed_ms && r.elapsed_ms > 0) {
      elapsedList.push(r.elapsed_ms);
    }
  }

  const base = totalWeight > 0 ? (weightedSum / totalWeight) * 90 : 0;
  const avg_tps = tpsList.length > 0 ? tpsList.reduce((a, b) => a + b, 0) / tpsList.length : 0;
  const avg_elapsed = elapsedList.length > 0 ? elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length : 0;

  // 提取 max_context 和 param_count
  let finalMaxContext = maxContext;
  if (finalMaxContext === undefined) {
    for (const r of results) {
      if (typeof r.max_context === "number") {
        finalMaxContext = r.max_context;
        break;
      }
      if (r.meta_json && typeof r.meta_json.max_context === "number") {
        finalMaxContext = r.meta_json.max_context;
        break;
      }
      if (r.meta && typeof r.meta.max_context === "number") {
        finalMaxContext = r.meta.max_context;
        break;
      }
    }
  }

  let finalParamCount = paramCount;
  if (finalParamCount === undefined) {
    for (const r of results) {
      if (typeof r.param_count === "number") {
        finalParamCount = r.param_count;
        break;
      }
      if (r.meta_json && typeof r.meta_json.param_count === "number") {
        finalParamCount = r.meta_json.param_count;
        break;
      }
      if (r.meta && typeof r.meta.param_count === "number") {
        finalParamCount = r.meta.param_count;
        break;
      }
    }
  }

  let score = base;

  // 硬性约束扣分：
  // 1. Max Context Constraint: 若 max_context < 32768，扣除 15 分
  if (finalMaxContext !== undefined && finalMaxContext < 32768) {
    score -= 15;
  }
  // 2. Low Speed Constraint: 若 avg_tps < 3.0，扣除 20 分
  if (avg_tps > 0 && avg_tps < 3.0) {
    score -= 20;
  }

  score = Math.max(0, Math.min(90, Math.round(score * 10) / 10));

  let grade = getGradeFromScore(score);

  // 硬性约束评级上限：
  // 1. Max Context Constraint: 若 max_context < 32768，上限为 B
  if (finalMaxContext !== undefined && finalMaxContext < 32768) {
    if (grade === "S" || grade === "A") {
      grade = "B";
    }
  }
  // 2. Low Speed Constraint: 若 avg_tps < 3.0，上限为 C
  if (avg_tps > 0 && avg_tps < 3.0) {
    if (grade === "S" || grade === "A" || grade === "B") {
      grade = "C";
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  return {
    score,
    grade,
    avg_tps: Math.round(avg_tps * 10) / 10,
    avg_elapsed: Math.round(avg_elapsed * 10) / 10,
    passed,
    skipped,
    total: results.length,
    use_cases: [],
    use_cases_str: "",
    max_context: finalMaxContext,
    param_count: finalParamCount,
  };
}

/**
 * 输入: { model_id: ScoredModel }
 * 输出: { model_id: ScoredModel }，按分类内分数排名且加上速度加分，并应用评级上限
 */
export function rankCategory(modelScoreMap: Record<string, ScoredModel>): Record<string, ScoredModel> {
  const entries = Object.entries(modelScoreMap);
  if (entries.length === 0) {
    return {};
  }

  const scoredModels = entries.map(([_, v]) => v);
  const tpsValues = scoredModels.map((m) => m.avg_tps).filter((v) => v > 0);
  const maxTps = tpsValues.length > 0 ? Math.max(...tpsValues) : 0;

  let minElapsed = 0;
  if (maxTps === 0) {
    const elapsedValues = scoredModels.map((m) => m.avg_elapsed).filter((v) => v > 0);
    minElapsed = elapsedValues.length > 0 ? Math.min(...elapsedValues) : 0;
  }

  const scored: Record<string, ScoredModel> = {};

  for (const [mid, s] of entries) {
    let speedBonus = 0;
    if (maxTps > 0 && s.avg_tps > 0) {
      speedBonus = (s.avg_tps / maxTps) * 10;
    } else if (maxTps === 0 && s.avg_elapsed > 0 && minElapsed > 0) {
      speedBonus = (minElapsed / s.avg_elapsed) * 10;
    }

    let finalScore = s.score + speedBonus;
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore * 10) / 10));

    let grade = getGradeFromScore(finalScore);

    // 重新应用评级上限（因为加了速度分可能让等级回升，所以最终要在此处再做一次上限约束）
    if (s.max_context !== undefined && s.max_context < 32768) {
      if (grade === "S" || grade === "A") {
        grade = "B";
      }
    }
    if (s.avg_tps > 0 && s.avg_tps < 3.0) {
      if (grade === "S" || grade === "A" || grade === "B") {
        grade = "C";
      }
    }

    scored[mid] = {
      ...s,
      score: finalScore,
      grade,
    };
  }

  // 排名计算（同分并列排名）
  const sortedIds = Object.keys(scored).sort((a, b) => scored[b]!.score - scored[a]!.score);
  let prevScore: number | null = null;
  let prevRank = 1;

  for (let i = 0; i < sortedIds.length; i++) {
    const mid = sortedIds[i]!;
    const currentScore = scored[mid]!.score;
    if (currentScore !== prevScore) {
      prevRank = i + 1;
    }
    scored[mid]!.rank = prevRank;
    prevScore = currentScore;
  }

  return scored;
}
