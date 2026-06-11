import type { ModelResult } from "./types.ts";
import { extractMetaFromResults } from "./types.ts";

/**
 * 基于测试结果推断推荐使用场景
 */
export function inferUseCases(
  results: ModelResult[],
  category: string,
  paramCount?: number,
  maxContext?: number
): string[] {
  const statusMap = new Map<string, boolean>();
  for (const r of results) {
    if (r.test) {
      statusMap.set(r.test, r.status === "pass");
    }
  }

  const ok = (key: string) => statusMap.get(key) === true;

  // 完全不可用
  if (!ok("basic_availability") && !ok("basic_embedding") && !ok("basic_rerank") && !ok("basic")) {
    return ["⚠️ 当前不可用"];
  }

  let tags: string[] = [];

  switch (category) {
    case "text_embedding":
      if (ok("basic_embedding")) tags.push("RAG 检索增强");
      if (ok("batch_embedding")) tags.push("批量文档索引");
      if (ok("query_embedding")) tags.push("语义搜索");
      if (tags.length === 0) tags.push("文本向量化");
      break;

    case "multimodal_embedding":
      tags.push("图文跨模态检索");
      if (ok("text_via_clip")) tags.push("文本向量化");
      if (ok("image_via_clip")) tags.push("以图搜图");
      break;

    case "reranker":
      if (ok("basic_rerank")) tags.push("搜索结果重排");
      tags.push("RAG 精排");
      break;

    case "image_generation":
      if (ok("text2image")) tags.push("文生图");
      tags.push("内容创作");
      break;

    case "audio":
      tags.push("语音合成 TTS");
      tags.push("语音播报");
      break;

    case "vision_language":
      if (ok("basic_availability")) tags.push("通用对话");
      if (ok("vlm_image_understanding")) tags.push("图片理解/OCR");
      if (ok("multi_image")) tags.push("多图对比分析");
      if (ok("tool_calling")) tags.push("多模态 Agent");
      if (ok("chinese_support")) tags.push("中文视觉场景");
      if (ok("think_on")) tags.push("视觉推理");
      if (tags.length === 0) tags.push("图文理解");
      break;

    case "code":
      if (ok("code_generation")) tags.push("代码生成");
      if (ok("code_debugging")) tags.push("代码调试");
      if (ok("code_explanation")) tags.push("代码解释");
      if (ok("code_completion")) tags.push("智能补全");
      if (ok("tool_calling")) tags.push("开发 Agent");
      if (tags.length === 0) tags.push("编程辅助");
      break;

    case "reasoning":
      if (ok("math_reasoning")) tags.push("数学推理");
      if (ok("logic_puzzle")) tags.push("逻辑分析");
      if (ok("cot_output")) tags.push("思维链推导");
      if (ok("tool_calling")) tags.push("推理 Agent");
      if (ok("chinese_support")) tags.push("中文推理");
      if (tags.length === 0) tags.push("深度推理");
      break;

    default: // general_chat
      if (ok("tool_calling")) tags.push("AI Agent 开发");
      if (ok("think_on")) tags.push("复杂分析推理");
      if (ok("streaming")) tags.push("实时流式对话");
      if (ok("chinese_support")) tags.push("中文场景");
      if (ok("long_context")) tags.push("长文档处理");
      if (ok("basic_availability") && tags.length === 0) tags.push("通用问答");
      break;
  }

  if (tags.length === 0) {
    tags.push("基础使用");
  }

  // 截取前 4 个推荐场景
  tags = tags.slice(0, 4);

  const extracted = extractMetaFromResults(results);
  const finalMaxContext = maxContext ?? extracted.maxContext;
  const finalParamCount = paramCount ?? extracted.paramCount;

  // 计算 avg_tps
  const tpsList: number[] = [];
  for (const r of results) {
    if (r.tps && r.tps > 0) {
      tpsList.push(r.tps);
    }
  }
  const avg_tps = tpsList.length > 0 ? tpsList.reduce((a, b) => a + b, 0) / tpsList.length : 0;

  // 1. Speed Constraint: If avg_tps < 3.0, replace use cases with "⚠️ 极慢响应"
  if (tpsList.length > 0 && avg_tps < 3.0) {
    return ["⚠️ 极慢响应"];
  }

  // 2. Max Context Constraint: If maxContext < 32768, remove RAG/Agent/LongText cases and append "⚠️ 短上下文 (<32k)"
  if (finalMaxContext !== undefined && finalMaxContext < 32768) {
    tags = tags.filter(
      (tag) =>
        !tag.includes("RAG") &&
        !tag.includes("Agent") &&
        !tag.includes("长文档") &&
        !tag.includes("LongText")
    );
    tags.push("⚠️ 短上下文 (<32k)");
  }

  // 3. Small & Fast: If small parameter (< 10B) and fast (> 35 tps), recommend "高频实时交互", "单意图路由"
  if (
    finalParamCount !== undefined &&
    finalParamCount < 10 &&
    tpsList.length > 0 &&
    avg_tps > 35
  ) {
    tags.push("高频实时交互", "单意图路由");
  }

  return tags;
}
