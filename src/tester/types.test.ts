import { describe, it, expect } from "bun:test";
import type { TestCase, ModelResult, ScoredModel } from "./types.ts";

describe("Type Definitions", () => {
  it("should have valid TestCase interface", () => {
    const testCase: TestCase = {
      name: "Test Case",
      description: "A test case",
      test: "test",
      required: true,
      tags: ["test"],
      buildPayload: (modelId: string) => ({ model: modelId }),
      parseResult: (responseJson: any, elapsedMs: number) => ({ success: true }),
    };
    expect(testCase.name).toBe("Test Case");
    expect(testCase.required).toBe(true);
  });

  it("should have valid ModelResult interface", () => {
    const result: ModelResult = {
      model_id: "test-model",
      category: "general_chat",
      case_name: "Test Case",
      test: "test",
      status: "pass",
      success: true,
      elapsed_ms: 100,
      tps: 10.5,
    };
    expect(result.model_id).toBe("test-model");
    expect(result.status).toBe("pass");
  });

  it("should have valid ScoredModel interface", () => {
    const scored: ScoredModel = {
      score: 85.5,
      grade: "S",
      rank: 1,
      avg_tps: 15.2,
      avg_elapsed: 200,
      passed: 5,
      skipped: 1,
      total: 6,
      use_cases: ["AI Agent 开发"],
      use_cases_str: "AI Agent 开发",
      max_context: 128000,
      param_count: 70,
    };
    expect(scored.score).toBe(85.5);
    expect(scored.grade).toBe("S");
  });
});
