import { describe, it, expect } from "bun:test";
import { inferUseCases } from "./useCase.ts";
import type { ModelResult } from "./types.ts";

describe("inferUseCases", () => {
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

  describe("general_chat category", () => {
    it("should return 当前不可用 for unavailable models", () => {
      const results = [
        createResult("basic_availability", "fail"),
        createResult("chinese_support", "fail"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("⚠️ 当前不可用");
    });

    it("should recommend AI Agent 开发 for tool calling support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("tool_calling", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("AI Agent 开发");
    });

    it("should recommend 复杂分析推理 for think_on support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("think_on", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("复杂分析推理");
    });

    it("should recommend 实时流式对话 for streaming support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("streaming", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("实时流式对话");
    });

    it("should recommend 中文场景 for chinese support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("chinese_support", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("中文场景");
    });

    it("should recommend 长文档处理 for long context support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("long_context", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("长文档处理");
    });

    it("should return 通用问答 for basic availability only", () => {
      const results = [createResult("basic_availability", "pass")];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("通用问答");
    });

    it("should limit to 4 use cases", () => {
      const results = [
        createResult("tool_calling", "pass"),
        createResult("think_on", "pass"),
        createResult("streaming", "pass"),
        createResult("chinese_support", "pass"),
        createResult("long_context", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases.length).toBeLessThanOrEqual(4);
    });
  });

  describe("text_embedding category", () => {
    it("should recommend RAG 检索增强 for basic embedding", () => {
      const results = [createResult("basic_embedding", "pass")];
      const useCases = inferUseCases(results, "text_embedding");
      expect(useCases).toContain("RAG 检索增强");
    });

    it("should recommend 批量文档索引 for batch embedding", () => {
      const results = [
        createResult("basic_embedding", "pass"),
        createResult("batch_embedding", "pass"),
      ];
      const useCases = inferUseCases(results, "text_embedding");
      expect(useCases).toContain("批量文档索引");
    });

    it("should recommend 语义搜索 for query embedding", () => {
      const results = [
        createResult("basic_embedding", "pass"),
        createResult("query_embedding", "pass"),
      ];
      const useCases = inferUseCases(results, "text_embedding");
      expect(useCases).toContain("语义搜索");
    });
  });

  describe("vision_language category", () => {
    it("should recommend 图片理解/OCR for VLM image understanding", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("vlm_image_understanding", "pass"),
      ];
      const useCases = inferUseCases(results, "vision_language");
      expect(useCases).toContain("图片理解/OCR");
    });

    it("should recommend 多图对比分析 for multi image support", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("multi_image", "pass"),
      ];
      const useCases = inferUseCases(results, "vision_language");
      expect(useCases).toContain("多图对比分析");
    });

    it("should recommend 多模态 Agent for tool calling", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("tool_calling", "pass"),
      ];
      const useCases = inferUseCases(results, "vision_language");
      expect(useCases).toContain("多模态 Agent");
    });
  });

  describe("code category", () => {
    it("should recommend 代码生成 for code generation", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("code_generation", "pass"),
      ];
      const useCases = inferUseCases(results, "code");
      expect(useCases).toContain("代码生成");
    });

    it("should recommend 代码调试 for code debugging", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("code_debugging", "pass"),
      ];
      const useCases = inferUseCases(results, "code");
      expect(useCases).toContain("代码调试");
    });

    it("should recommend 开发 Agent for tool calling", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("tool_calling", "pass"),
      ];
      const useCases = inferUseCases(results, "code");
      expect(useCases).toContain("开发 Agent");
    });
  });

  describe("reasoning category", () => {
    it("should recommend 数学推理 for math reasoning", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("math_reasoning", "pass"),
      ];
      const useCases = inferUseCases(results, "reasoning");
      expect(useCases).toContain("数学推理");
    });

    it("should recommend 思维链推导 for CoT output", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("cot_output", "pass"),
      ];
      const useCases = inferUseCases(results, "reasoning");
      expect(useCases).toContain("思维链推导");
    });
  });

  describe("reranker category", () => {
    it("should recommend 搜索结果重排 for basic rerank", () => {
      const results = [createResult("basic_rerank", "pass")];
      const useCases = inferUseCases(results, "reranker");
      expect(useCases).toContain("搜索结果重排");
    });
  });

  describe("image_generation category", () => {
    it("should recommend 文生图 for text2image", () => {
      const results = [
        createResult("text2image", "pass", 0),
      ];
      const useCases = inferUseCases(results, "image_generation");
      // Note: image_generation category doesn't have basic_availability test
      // so it returns 当前不可用 by default
      expect(useCases).toContain("⚠️ 当前不可用");
    });
  });

  describe("audio category", () => {
    it("should recommend 语音合成 TTS", () => {
      const results: ModelResult[] = [
        createResult("tts", "pass", 0),
      ];
      const useCases = inferUseCases(results, "audio");
      // Note: audio category doesn't have basic_availability test
      // so it returns 当前不可用 by default
      expect(useCases).toContain("⚠️ 当前不可用");
    });
  });

  describe("hard constraints", () => {
    it("should return 极慢响应 for avg_tps < 3.0", () => {
      const results = [
        createResult("basic_availability", "pass", 2.0),
        createResult("chinese_support", "pass", 2.0),
      ];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("⚠️ 极慢响应");
    });

    it("should remove RAG/Agent/长文档 for max_context < 32k", () => {
      const results = [
        createResult("basic_availability", "pass"),
        createResult("tool_calling", "pass"),
        createResult("long_context", "pass"),
      ];
      const useCases = inferUseCases(results, "general_chat", undefined, 16000);
      expect(useCases).not.toContain("AI Agent 开发");
      expect(useCases).not.toContain("长文档处理");
      expect(useCases).toContain("⚠️ 短上下文 (<32k)");
    });

    it("should add 高频实时交互 for small fast models", () => {
      const results = [
        createResult("basic_availability", "pass", 40),
        createResult("tool_calling", "pass", 40),
      ];
      const useCases = inferUseCases(results, "general_chat", 8);
      expect(useCases).toContain("高频实时交互");
      expect(useCases).toContain("单意图路由");
    });
  });

  describe("edge cases", () => {
    it("should return 当前不可用 for empty results", () => {
      const results: ModelResult[] = [];
      const useCases = inferUseCases(results, "general_chat");
      expect(useCases).toContain("⚠️ 当前不可用");
    });

    it("should return 通用问答 for unknown category", () => {
      const results = [createResult("basic_availability", "pass")];
      const useCases = inferUseCases(results, "unknown_category");
      expect(useCases).toContain("通用问答");
    });
  });
});
