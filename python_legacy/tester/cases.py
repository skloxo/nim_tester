# -*- coding: utf-8 -*-
"""
测试用例定义模块
为每种模型分类设计专属的测试用例集合
"""

import base64
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


# ─── 最小 1x1 白色 PNG（Base64），用于 VLM 视觉测试 ────────────────────────────
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
)
_TINY_PNG_DATA_URL = f"data:image/png;base64,{_TINY_PNG_B64}"


@dataclass
class TestCase:
    """单个测试用例"""
    name: str                          # 用例名称（中文）
    description: str                   # 描述
    build_payload: Callable            # (model_id) -> dict  构造请求 payload
    parse_result: Callable             # (response_json, elapsed_ms) -> dict
    test: str = ""                     # 评分关键 key，与 TEST_WEIGHTS 对应
    required: bool = True              # False 表示可选探测项
    tags: List[str] = field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════════
#  通用对话模型  (general_chat)
# ═══════════════════════════════════════════════════════════════════════════════

def _chat_payload(model_id, messages, **kwargs):
    return {"model": model_id, "messages": messages, "max_tokens": 256, **kwargs}


def _parse_chat(resp: dict, elapsed: float) -> dict:
    """解析 chat completions 响应，提取关键指标"""
    choice = (resp.get("choices") or [{}])[0]
    message = choice.get("message", {})
    usage = resp.get("usage", {})
    content = message.get("content", "")
    finish_reason = choice.get("finish_reason", "")
    reasoning = message.get("reasoning_content") or message.get("thinking", "")

    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)

    # 计算 token 速率（tokens/s）
    tps = completion_tokens / (elapsed / 1000) if elapsed > 0 else 0

    return {
        "success": bool(content or finish_reason),
        "content_preview": content[:200] if content else "",
        "finish_reason": finish_reason,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tps": round(tps, 1),
        "elapsed_ms": round(elapsed, 0),
        "has_reasoning": bool(reasoning),
        "reasoning_preview": reasoning[:100] if reasoning else "",
    }


GENERAL_CHAT_CASES: List[TestCase] = [
    # ── T-01 基础可用性 ────────────────────────────────────────────────────
    TestCase(
        name="T-01 基础可用性",
        test="basic_availability",
        description="发送简单问候，验证模型是否响应并返回非空内容",
        tags=["basic", "availability"],
        build_payload=lambda mid: _chat_payload(
            mid, [{"role": "user", "content": "Hello, reply with exactly: OK"}]
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "basic_availability"},
    ),

    # ── T-02 中文支持 ──────────────────────────────────────────────────────
    TestCase(
        name="T-02 中文支持",
        test="chinese_support",
        description="验证模型是否能正常处理中文输入并返回中文内容",
        tags=["language", "chinese"],
        build_payload=lambda mid: _chat_payload(
            mid, [{"role": "user", "content": "用中文回答：你好，你是什么模型？一句话即可。"}]
        ),
        parse_result=lambda r, e: (
            lambda p: {**p, "test": "chinese_support",
                "has_chinese": any('\u4e00' <= c <= '\u9fff' for c in p.get("content_preview", ""))}
        )(_parse_chat(r, e)),  # 只调用一次 _parse_chat
    ),

    # ── T-03 工具调用（Function Calling）──────────────────────────────────
    TestCase(
        name="T-03 工具调用（Function Calling）",
        test="tool_calling",
        description="测试模型是否支持 function calling / tool use",
        tags=["tool_call", "function_calling"],
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 256,
            "messages": [{"role": "user", "content": "What's the weather in Beijing?"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get current weather",
                    "parameters": {
                        "type": "object",
                        "properties": {"city": {"type": "string"}},
                        "required": ["city"],
                    },
                },
            }],
            "tool_choice": "auto",
        },
        parse_result=lambda r, e: {
            **_parse_chat(r, e),
            "test": "tool_calling",
            "tool_calls": (r.get("choices") or [{}])[0]
                          .get("message", {})
                          .get("tool_calls", []),
            "supports_tool_call": bool(
                (r.get("choices") or [{}])[0]
                .get("message", {})
                .get("tool_calls")
            ),
        },
    ),

    # ── T-04 Thinking-On（深度推理）────────────────────────────────────────
    TestCase(
        name="T-04 深度推理（Think On）",
        test="think_on",
        description="测试模型是否支持 think/reasoning 模式（CoT 输出）",
        tags=["reasoning", "think_on"],
        required=False,
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 512,
            "messages": [{"role": "user", "content": "9.11 and 9.9, which is bigger? Think step by step."}],
            # NVIDIA / DeepSeek 开启思维链的常见参数
            "thinking": {"type": "enabled", "budget_tokens": 512},
        },
        parse_result=lambda r, e: {
            **_parse_chat(r, e),
            "test": "think_on",
        },
    ),

    # ── T-05 Flash/无推理模式 ──────────────────────────────────────────────
    TestCase(
        name="T-05 Flash/快速模式（Think Off）",
        test="think_off",
        description="测试模型是否支持关闭推理的快速响应模式",
        tags=["flash", "think_off"],
        required=False,
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 128,
            "messages": [{"role": "user", "content": "Say 'FAST' and nothing else."}],
            "thinking": {"type": "disabled"},
        },
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "think_off"},
    ),

    # ── T-06 长文本/上下文 ─────────────────────────────────────────────────
    TestCase(
        name="T-06 长上下文摘要",
        test="long_context",
        description="输入中等长度文本，测试摘要能力和速度",
        tags=["long_context", "summarization"],
        required=False,
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "Summarize the following text in one sentence:\n\n"
                "Artificial intelligence (AI) is intelligence demonstrated by machines, "
                "as opposed to the natural intelligence displayed by animals including humans. "
                "AI research has been defined as the field of study of intelligent agents, "
                "which refers to any system that perceives its environment and takes actions "
                "that maximize its chance of achieving its goals. "
                "The term 'artificial intelligence' had previously been used to describe "
                "machines that mimic and display 'human' cognitive skills associated with "
                "the human mind, such as learning and problem-solving. "
                "This definition has since been rejected by major AI researchers who now "
                "describe AI in terms of rationality and acting rationally."
            )}],
            max_tokens=128,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "long_context"},
    ),

    # ── T-07 流式输出（Streaming）─────────────────────────────────────────
    TestCase(
        name="T-07 流式输出（Streaming）",
        test="streaming",
        description="测试 stream=true 首 token 延迟（TTFT）",
        tags=["streaming", "ttft"],
        required=False,
        build_payload=lambda mid: {
            **_chat_payload(mid, [{"role": "user", "content": "Count from 1 to 5."}], max_tokens=64),
            "stream": True,
        },
        # streaming 响应由 runner 特殊处理，parse_result 接收预处理后结果
        parse_result=lambda r, e: {**r, "test": "streaming"},
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  视觉语言模型  (vision_language)
# ═══════════════════════════════════════════════════════════════════════════════

VLM_CASES: List[TestCase] = [
    # 继承通用对话所有非 streaming 用例
    *[tc for tc in GENERAL_CHAT_CASES if "streaming" not in tc.tags],

    # ── V-01 图文理解（VLM 核心）──────────────────────────────────────────
    TestCase(
        name="V-01 图文理解（VLM 核心）",
        test="vlm_image_understanding",
        description="上传一张图片，测试模型是否能描述图片内容",
        tags=["vlm", "image_understanding"],
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 128,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _TINY_PNG_DATA_URL}},
                    {"type": "text", "text": "What color is this image? Reply in one word."},
                ],
            }],
        },
        parse_result=lambda r, e: (
            lambda p: {**p, "test": "vlm_image_understanding", "supports_vlm": p["success"]}
        )(_parse_chat(r, e)),  # 只调用一次 _parse_chat
    ),

    # ── V-02 多图理解 ──────────────────────────────────────────────────────
    TestCase(
        name="V-02 多图输入支持",
        test="multi_image",
        description="测试模型是否支持多张图片同时输入",
        tags=["vlm", "multi_image"],
        required=False,
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 128,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _TINY_PNG_DATA_URL}},
                    {"type": "image_url", "image_url": {"url": _TINY_PNG_DATA_URL}},
                    {"type": "text", "text": "Are these two images the same? Yes or No."},
                ],
            }],
        },
        parse_result=lambda r, e: (
            lambda p: {**p, "test": "multi_image", "supports_multi_image": p["success"]}
        )(_parse_chat(r, e)),  # 只调用一次 _parse_chat
    ),

    # ── V-03 图片输出（图像生成能力探测）────────────────────────────────────
    TestCase(
        name="V-03 图片输出能力",
        test="image_output",
        description="探测模型是否能输出图片（multimodal output）",
        tags=["image_output", "multimodal_output"],
        required=False,
        build_payload=lambda mid: {
            "model": mid,
            "max_tokens": 256,
            "messages": [{"role": "user", "content": "Generate an image of a blue circle."}],
        },
        parse_result=lambda r, e: {
            **_parse_chat(r, e),
            "test": "image_output",
            "has_image_content": any(
                isinstance(p, dict) and p.get("type") == "image_url"
                for c in (r.get("choices") or [{}])
                for p in ([c.get("message", {}).get("content")] if isinstance(c.get("message", {}).get("content"), str) else (c.get("message", {}).get("content") or []))
            ),
        },
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  推理模型  (reasoning)
# ═══════════════════════════════════════════════════════════════════════════════

REASONING_CASES: List[TestCase] = [
    TestCase(
        name="R-01 基础可用性",
        test="basic",
        description="发送简单问题，验证模型响应",
        tags=["basic"],
        build_payload=lambda mid: _chat_payload(
            mid, [{"role": "user", "content": "What is 2+2?"}], max_tokens=64
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "basic"},
    ),

    TestCase(
        name="R-02 数学推理",
        test="math_reasoning",
        description="测试复杂数学推理能力（需要多步思考）",
        tags=["math", "reasoning"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "A train travels 120 km at 60 km/h, then 180 km at 90 km/h. "
                "What is the average speed for the entire journey? Show your work."
            )}],
            max_tokens=512,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "math_reasoning"},
    ),

    TestCase(
        name="R-03 思维链输出（CoT）",
        test="cot_output",
        description="测试是否输出可见的 reasoning_content / thinking 字段",
        tags=["cot", "think_on"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": "Is 17 a prime number? Reason step by step."}],
            max_tokens=512,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "cot_output"},
    ),

    TestCase(
        name="R-04 逻辑谜题",
        test="logic_puzzle",
        description="测试逻辑推理能力",
        tags=["logic", "reasoning"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "There are 3 boxes: one has apples, one has oranges, one has both. "
                "All labels are wrong. You can pick one fruit from one box. "
                "Which box do you pick from to identify all boxes? Explain."
            )}],
            max_tokens=512,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "logic_puzzle"},
    ),

    # 工具调用（推理模型也可能支持）
    GENERAL_CHAT_CASES[2],  # T-03 工具调用
]


# ═══════════════════════════════════════════════════════════════════════════════
#  代码模型  (code)
# ═══════════════════════════════════════════════════════════════════════════════

CODE_CASES: List[TestCase] = [
    TestCase(
        name="C-01 基础代码生成",
        test="code_generation",
        description="生成 Python 函数，验证代码格式正确",
        tags=["code_gen", "python"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "Write a Python function that returns the nth Fibonacci number. "
                "Return only the code, no explanation."
            )}],
            max_tokens=256,
        ),
        parse_result=lambda r, e: (
            lambda p: {**p, "test": "code_generation", "has_code_block": "def " in p.get("content_preview", "")}
        )(_parse_chat(r, e)),  # 只调用一次 _parse_chat
    ),

    TestCase(
        name="C-02 代码补全（FIM）",
        test="code_completion",
        description="测试前缀/后缀代码补全能力（Fill-in-Middle）",
        tags=["fim", "code_completion"],
        required=False,
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "Complete the following Python code:\n"
                "def add(a, b):\n"
                "    # TODO: return sum\n"
                "    "
            )}],
            max_tokens=64,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "code_completion"},
    ),

    TestCase(
        name="C-03 代码调试",
        test="code_debugging",
        description="给出有 bug 的代码，测试发现并修复能力",
        tags=["debugging"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "Fix the bug in this Python code and return only the fixed code:\n"
                "def divide(a, b):\n"
                "    return a / b\n\n"
                "result = divide(10, 0)\n"
                "print(result)"
            )}],
            max_tokens=256,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "code_debugging"},
    ),

    TestCase(
        name="C-04 代码解释",
        test="code_explanation",
        description="测试代码理解和中文解释能力",
        tags=["code_understanding"],
        build_payload=lambda mid: _chat_payload(
            mid,
            [{"role": "user", "content": (
                "用中文简要解释这段代码的作用（一句话）:\n"
                "list(map(lambda x: x**2, filter(lambda x: x%2==0, range(10))))"
            )}],
            max_tokens=128,
        ),
        parse_result=lambda r, e: {**_parse_chat(r, e), "test": "code_explanation"},
    ),

    # 工具调用（代码模型通常支持）
    GENERAL_CHAT_CASES[2],  # T-03 工具调用
]


# ═══════════════════════════════════════════════════════════════════════════════
#  文本嵌入模型  (text_embedding)
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_embedding(resp: dict, elapsed: float) -> dict:
    data = resp.get("data", [])
    if not data:
        return {"success": False, "elapsed_ms": round(elapsed, 0)}
    vec = data[0].get("embedding", [])
    return {
        "success": True,
        "elapsed_ms": round(elapsed, 0),
        "dimension": len(vec),
        "vector_preview": vec[:4],
        "usage": resp.get("usage", {}),
    }


EMBEDDING_CASES: List[TestCase] = [
    TestCase(
        name="E-01 基础嵌入生成",
        test="basic_embedding",
        description="对单条文本生成嵌入向量，验证维度和格式",
        tags=["embedding", "basic"],
        build_payload=lambda mid: {
            "model": mid,
            "input": ["The quick brown fox jumps over the lazy dog."],
            "input_type": "passage",      # NVIDIA embed API 必填
            "encoding_format": "float",
            "truncate": "END",
        },
        parse_result=lambda r, e: {**_parse_embedding(r, e), "test": "basic_embedding"},
    ),

    TestCase(
        name="E-02 批量嵌入",
        test="batch_embedding",
        description="批量编码多条文本，测试批处理支持",
        tags=["embedding", "batch"],
        build_payload=lambda mid: {
            "model": mid,
            "input": [
                "Hello world",
                "This is a Chinese text sample",
                "The quick brown fox",
            ],
            "input_type": "passage",
            "encoding_format": "float",
            "truncate": "END",
        },
        parse_result=lambda r, e: {
            **_parse_embedding(r, e),
            "test": "batch_embedding",
            "batch_count": len(r.get("data", [])),
        },
    ),

    TestCase(
        name="E-03 查询向量（Query Embedding）",
        test="query_embedding",
        description="使用 query 模式生成检索查询向量",
        tags=["embedding", "query"],
        build_payload=lambda mid: {
            "model": mid,
            "input": ["What is the capital of France?"],
            "input_type": "query",        # 区别于 passage 的检索专用模式
            "encoding_format": "float",
            "truncate": "END",
        },
        parse_result=lambda r, e: {**_parse_embedding(r, e), "test": "query_embedding"},
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  图文嵌入模型  (multimodal_embedding)
# ═══════════════════════════════════════════════════════════════════════════════

MULTIMODAL_EMBEDDING_CASES: List[TestCase] = [
    TestCase(
        name="ME-01 文本嵌入",
        test="text_via_clip",
        description="通过图文嵌入模型对文本生成向量",
        tags=["multimodal_embedding", "text"],
        build_payload=lambda mid: {
            "model": mid,
            "input": ["A photo of a cat"],
            "input_type": "passage",
            "encoding_format": "float",
            "truncate": "END",
        },
        parse_result=lambda r, e: {**_parse_embedding(r, e), "test": "text_via_clip"},
    ),

    TestCase(
        name="ME-02 图文混合嵌入",
        test="image_via_clip",
        description="同时传入图片 URL 和文本，测试多模态编码",
        tags=["multimodal_embedding", "image"],
        build_payload=lambda mid: {
            "model": mid,
            "input": [_TINY_PNG_DATA_URL, "A white image"],
            "input_type": "passage",
            "encoding_format": "float",
            "truncate": "END",
        },
        parse_result=lambda r, e: {**_parse_embedding(r, e), "test": "image_via_clip"},
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  重排序模型  (reranker)
# ═══════════════════════════════════════════════════════════════════════════════

RERANKER_CASES: List[TestCase] = [
    TestCase(
        name="RR-01 基础重排序",
        test="basic_rerank",
        description="给定 query 和候选文档，测试重排序得分",
        tags=["rerank", "basic"],
        build_payload=lambda mid: {
            "model": mid,
            "query": "What is the capital of France?",
            "passages": [
                {"text": "Paris is the capital of France."},
                {"text": "Lyon is a major city in France."},
                {"text": "France is a country in Western Europe."},
            ],
        },
        parse_result=lambda r, e: {
            "success": bool(r.get("rankings") or r.get("data") or r.get("results")),
            "elapsed_ms": round(e, 0),
            "test": "basic_rerank",
            "results_count": len(r.get("rankings") or r.get("data") or r.get("results") or []),
            "top_score": (
                (r.get("rankings") or r.get("data") or r.get("results") or [{}])[0]
                .get("relevance_score", r.get("rankings", [{}])[0].get("score") if r.get("rankings") else None)
            ),
        },
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  图像生成模型  (image_generation)
# ═══════════════════════════════════════════════════════════════════════════════

IMAGE_GEN_CASES: List[TestCase] = [
    TestCase(
        name="IG-01 文生图基础测试",
        test="text2image",
        description="用简单提示词生成图片，验证是否返回 b64/url",
        tags=["image_gen", "text2image"],
        build_payload=lambda mid: {
            "model": mid,
            "prompt": "A simple blue circle on white background",
            "n": 1,
            "size": "256x256",
            "response_format": "b64_json",
        },
        parse_result=lambda r, e: {
            "success": bool(r.get("data")),
            "elapsed_ms": round(e, 0),
            "test": "text2image",
            "has_b64": bool((r.get("data") or [{}])[0].get("b64_json")),
            "has_url": bool((r.get("data") or [{}])[0].get("url")),
        },
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  语音/音频模型  (audio)
# ═══════════════════════════════════════════════════════════════════════════════

AUDIO_CASES: List[TestCase] = [
    TestCase(
        name="AU-01 TTS 文本转语音",
        test="tts",
        description="测试 TTS 接口，验证是否返回音频数据",
        tags=["tts", "audio_output"],
        required=False,
        build_payload=lambda mid: {
            "model": mid,
            "input": "Hello, this is a test.",
            "voice": "alloy",
            "response_format": "mp3",
        },
        parse_result=lambda r, e: {
            "success": isinstance(r, bytes) and len(r) > 0,
            "elapsed_ms": round(e, 0),
            "test": "tts",
            "audio_size_bytes": len(r) if isinstance(r, bytes) else 0,
        },
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
#  映射表：category_key → 测试用例列表
# ═══════════════════════════════════════════════════════════════════════════════

CATEGORY_CASES: Dict[str, List[TestCase]] = {
    "general_chat": GENERAL_CHAT_CASES,
    "vision_language": VLM_CASES,
    "reasoning": REASONING_CASES,
    "code": CODE_CASES,
    "text_embedding": EMBEDDING_CASES,
    "multimodal_embedding": MULTIMODAL_EMBEDDING_CASES,
    "reranker": RERANKER_CASES,
    "image_generation": IMAGE_GEN_CASES,
    "audio": AUDIO_CASES,
}


def get_cases(category: str) -> List[TestCase]:
    """获取指定分类的测试用例（未知分类回退到通用对话用例）"""
    return CATEGORY_CASES.get(category, GENERAL_CHAT_CASES)
