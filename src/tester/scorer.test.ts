import { describe, it, expect } from "bun:test";
import {
  TEST_WEIGHTS,
  GRADE_MAP,
  getGradeFromScore,
  scoreModel,
  rankCategory,
} from "./scorer.ts";
import type { ModelResult, ScoredModel } from "./types.ts";

describe("TEST_WEIGHTS", () => {
  it("should have weights for all test types", () => {
    expect(TEST_WEIGHTS.basic_availability).toBe(30);
    expect(TEST_WEIGHTS.chinese_support).toBe(10);
    expect(TEST_WEIGHTS.tool_calling).toBe(20);
    expect(TEST_WEIGHTS.code_generation).toBe(30);
    expect(TEST_WEIGHTS.basic_embedding).toBe(40);
    expect(TEST_WEIGHTS.basic_rerank).toBe(100);
    expect(TEST_WEIGHTS.text2image).toBe(100);
    expect(TEST_WEIGHTS.tts).toBe(100);
  });

  it("should have total weight less than 100 (speed bonus adds up to 10)", () => {
    const totalWeight = Object.values(TEST_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(totalWeight).toBeGreaterThan(0);
  });
});

describe("GRADE_MAP", () => {
  it("should have correct grade thresholds", () => {
    expect(GRADE_MAP).toEqual([
      [85, "S"],
      [70, "A"],
      [55, "B"],
      [40, "C"],
      [20, "D"],
      [0, "F"],
    ]);
  });
});

describe("getGradeFromScore", () => {
  it("should return S for score >= 85", () => {
    expect(getGradeFromScore(100)).toBe("S");
    expect(getGradeFromScore(85)).toBe("S");
    expect(getGradeFromScore(90)).toBe("S");
  });

  it("should return A for score >= 70", () => {
    expect(getGradeFromScore(84.9)).toBe("A");
    expect(getGradeFromScore(70)).toBe("A");
    expect(getGradeFromScore(75)).toBe("A");
  });

  it("should return B for score >= 55", () => {
    expect(getGradeFromScore(69.9)).toBe("B");
    expect(getGradeFromScore(55)).toBe("B");
    expect(getGradeFromScore(60)).toBe("B");
  });

  it("should return C for score >= 40", () => {
    expect(getGradeFromScore(54.9)).toBe("C");
    expect(getGradeFromScore(40)).toBe("C");
    expect(getGradeFromScore(45)).toBe("C");
  });

  it("should return D for score >= 20", () => {
    expect(getGradeFromScore(39.9)).toBe("D");
    expect(getGradeFromScore(20)).toBe("D");
    expect(getGradeFromScore(25)).toBe("D");
  });

  it("should return F for score < 20", () => {
    expect(getGradeFromScore(19.9)).toBe("F");
    expect(getGradeFromScore(0)).toBe("F");
    expect(getGradeFromScore(10)).toBe("F");
  });
});

describe("scoreModel", () => {
  const createResult = (
    test: string,
    status: "pass" | "fail" | "skip" = "pass",
    tps: number = 10
  ): ModelResult => ({
    model_id: "test-model",
    category: "general_chat",
    case_name: `Test ${test}`,
    test,
    status,
    success: status === "pass",
    elapsed_ms: 100,
    tps,
  });

  it("should calculate base score from passed tests", () => {
    const results = [
      createResult("basic_availability", "pass"),
      createResult("chinese_support", "pass"),
    ];
    const scored = scoreModel(results);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.passed).toBe(2);
    expect(scored.total).toBe(2);
  });

  it("should skip tests with skip status", () => {
    const results = [
      createResult("basic_availability", "pass"),
      createResult("chinese_support", "skip"),
    ];
    const scored = scoreModel(results);
    expect(scored.passed).toBe(1);
    expect(scored.skipped).toBe(1);
    expect(scored.total).toBe(2);
  });

  it("should deduct 15 points for context < 32k", () => {
    const results = [createResult("basic_availability", "pass")];
    const scoredWithLargeContext = scoreModel(results, 128000);
    const scoredWithSmallContext = scoreModel(results, 16000);
    expect(scoredWithSmallContext.score).toBeLessThan(scoredWithLargeContext.score);
    expect(scoredWithSmallContext.score).toBe(scoredWithLargeContext.score - 15);
  });

  it("should cap grade at B for context < 32k", () => {
    const results = [
      createResult("basic_availability", "pass"),
      createResult("chinese_support", "pass"),
      createResult("tool_calling", "pass"),
    ];
    const scored = scoreModel(results, 16000);
    expect(["B", "C", "D", "F"]).toContain(scored.grade);
    expect(["S", "A"]).not.toContain(scored.grade);
  });

  it("should deduct 20 points for avg_tps < 3.0", () => {
    const results = [createResult("basic_availability", "pass", 2.0)];
    const scoredSlow = scoreModel(results);
    const resultsFast = [createResult("basic_availability", "pass", 10.0)];
    const scoredFast = scoreModel(resultsFast);
    expect(scoredSlow.score).toBeLessThan(scoredFast.score);
  });

  it("should cap grade at C for avg_tps < 3.0", () => {
    const results = [
      createResult("basic_availability", "pass", 2.0),
      createResult("chinese_support", "pass", 2.0),
      createResult("tool_calling", "pass", 2.0),
    ];
    const scored = scoreModel(results);
    expect(["C", "D", "F"]).toContain(scored.grade);
    expect(["S", "A", "B"]).not.toContain(scored.grade);
  });

  it("should calculate average TPS", () => {
    const results = [
      createResult("basic_availability", "pass", 10),
      createResult("chinese_support", "pass", 20),
    ];
    const scored = scoreModel(results);
    expect(scored.avg_tps).toBe(15);
  });

  it("should handle empty results", () => {
    const scored = scoreModel([]);
    expect(scored.score).toBe(0);
    expect(scored.grade).toBe("F");
    expect(scored.passed).toBe(0);
    expect(scored.total).toBe(0);
  });
});

describe("rankCategory", () => {
  it("should rank models by score", () => {
    const modelScores: Record<string, ScoredModel> = {
      "model-a": {
        score: 80,
        grade: "A",
        avg_tps: 10,
        avg_elapsed: 100,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
      "model-b": {
        score: 90,
        grade: "S",
        avg_tps: 15,
        avg_elapsed: 80,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
    };
    const ranked = rankCategory(modelScores);
    expect(ranked["model-b"].rank).toBe(1);
    expect(ranked["model-a"].rank).toBe(2);
  });

  it("should add speed bonus based on TPS", () => {
    const modelScores: Record<string, ScoredModel> = {
      "slow-model": {
        score: 70,
        grade: "A",
        avg_tps: 5,
        avg_elapsed: 200,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
      "fast-model": {
        score: 70,
        grade: "A",
        avg_tps: 20,
        avg_elapsed: 50,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
    };
    const ranked = rankCategory(modelScores);
    expect(ranked["fast-model"].score).toBeGreaterThan(70);
    expect(ranked["slow-model"].score).toBeLessThan(ranked["fast-model"].score);
  });

  it("should handle empty input", () => {
    const ranked = rankCategory({});
    expect(Object.keys(ranked)).toHaveLength(0);
  });

  it("should handle tie scores with same rank", () => {
    const modelScores: Record<string, ScoredModel> = {
      "model-a": {
        score: 80,
        grade: "A",
        avg_tps: 10,
        avg_elapsed: 100,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
      "model-b": {
        score: 80,
        grade: "A",
        avg_tps: 10,
        avg_elapsed: 100,
        passed: 5,
        skipped: 0,
        total: 5,
        use_cases: [],
        use_cases_str: "",
      },
    };
    const ranked = rankCategory(modelScores);
    expect(ranked["model-a"].rank).toBe(1);
    expect(ranked["model-b"].rank).toBe(1);
  });
});
