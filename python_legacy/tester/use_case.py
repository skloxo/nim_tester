# -*- coding: utf-8 -*-
"""根据测试结果自动推断模型的典型适用场景"""

from typing import List, Dict, Any


def infer_use_cases(results: List[Dict], category: str) -> str:
    """基于测试结果推断推荐使用场景（全规则驱动，无需额外 API 调用）"""
    status = {r.get("test"): r.get("status") == "pass" for r in results}

    def ok(key): return status.get(key, False)

    # 完全不可用
    if not ok("basic_availability") and not ok("basic_embedding") and not ok("basic_rerank") and not ok("basic"):
        return "⚠️ 当前不可用"

    tags = []

    if category == "text_embedding":
        if ok("basic_embedding"): tags.append("RAG 检索增强")
        if ok("batch_embedding"): tags.append("批量文档索引")
        if ok("query_embedding"): tags.append("语义搜索")
        if not tags: tags.append("文本向量化")

    elif category == "multimodal_embedding":
        tags.append("图文跨模态检索")
        if ok("text_via_clip"): tags.append("文本向量化")
        if ok("image_via_clip"): tags.append("以图搜图")

    elif category == "reranker":
        if ok("basic_rerank"): tags.append("搜索结果重排")
        tags.append("RAG 精排")

    elif category == "image_generation":
        if ok("text2image"): tags.append("文生图")
        tags.append("内容创作")

    elif category == "audio":
        tags.append("语音合成 TTS")
        tags.append("语音播报")

    elif category == "vision_language":
        if ok("basic_availability"): tags.append("通用对话")
        if ok("vlm_image_understanding"): tags.append("图片理解/OCR")
        if ok("multi_image"): tags.append("多图对比分析")
        if ok("tool_calling"): tags.append("多模态 Agent")
        if ok("chinese_support"): tags.append("中文视觉场景")
        if ok("think_on"): tags.append("视觉推理")
        if not tags: tags.append("图文理解")

    elif category == "code":
        if ok("code_generation"): tags.append("代码生成")
        if ok("code_debugging"): tags.append("代码调试")
        if ok("code_explanation"): tags.append("代码解释")
        if ok("code_completion"): tags.append("智能补全")
        if ok("tool_calling"): tags.append("开发 Agent")
        if not tags: tags.append("编程辅助")

    elif category == "reasoning":
        if ok("math_reasoning"): tags.append("数学推理")
        if ok("logic_puzzle"): tags.append("逻辑分析")
        if ok("cot_output"): tags.append("思维链推导")
        if ok("tool_calling"): tags.append("推理 Agent")
        if ok("chinese_support"): tags.append("中文推理")
        if not tags: tags.append("深度推理")

    else:  # general_chat
        if ok("tool_calling"): tags.append("AI Agent 开发")
        if ok("think_on"): tags.append("复杂分析推理")
        if ok("streaming"): tags.append("实时流式对话")
        if ok("chinese_support"): tags.append("中文场景")
        if ok("long_context"): tags.append("长文档处理")
        if ok("basic_availability") and not tags: tags.append("通用问答")

    return "、".join(tags[:4]) if tags else "基础使用"
