import type { TestCase } from "./types.ts";
import { Buffer } from "buffer";

// ─── 最小 1x1 白色 PNG（Base64），用于 VLM 视觉测试 ────────────────────────────
const _TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8" +
  "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

export const _TINY_PNG_DATA_URL = `data:image/png;base64,${_TINY_PNG_B64}`;

function _chatPayload(modelId: string, messages: any[], extra: Record<string, any> = {}): Record<string, any> {
  return {
    model: modelId,
    messages,
    max_tokens: 256,
    ...extra,
  };
}

function _parseChat(resp: any, elapsedMs: number): Record<string, any> {
  const choices = resp?.choices || [];
  const choice = choices[0] || {};
  const message = choice.message || {};
  const usage = resp?.usage || {};
  const content = message.content || "";
  const finishReason = choice.finish_reason || "";
  const reasoning = message.reasoning_content || message.thinking || "";

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;

  const tps = elapsedMs > 0 ? completionTokens / (elapsedMs / 1000) : 0;

  return {
    success: !!(content || finishReason),
    content_preview: typeof content === "string" ? content.slice(0, 200) : "",
    finish_reason: finishReason,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    tps: Math.round(tps * 10) / 10,
    elapsed_ms: Math.round(elapsedMs),
    has_reasoning: !!reasoning,
    reasoning_preview: typeof reasoning === "string" ? reasoning.slice(0, 100) : "",
  };
}

function _parseEmbedding(resp: any, elapsedMs: number): Record<string, any> {
  const data = resp?.data || [];
  if (data.length === 0) {
    return { success: false, elapsed_ms: Math.round(elapsedMs) };
  }
  const vec = data[0]?.embedding || [];
  return {
    success: true,
    elapsed_ms: Math.round(elapsedMs),
    dimension: vec.length,
    vector_preview: vec.slice(0, 4),
    usage: resp?.usage || {},
  };
}

// 定义工具调用测试用例，以便在多个分类中共享
const toolCallingCase: TestCase = {
  name: "T-03 工具调用（Function Calling）",
  description: "测试模型是否支持 function calling / tool use",
  test: "tool_calling",
  required: true,
  tags: ["tool_call", "function_calling"],
  buildPayload: (mid: string) => ({
    model: mid,
    max_tokens: 256,
    messages: [{ role: "user", content: "What's the weather in Beijing?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
  }),
  parseResult: (r: any, e: number) => {
    const p = _parseChat(r, e);
    const choices = r?.choices || [];
    const toolCalls = choices[0]?.message?.tool_calls || [];
    return {
      ...p,
      test: "tool_calling",
      tool_calls: toolCalls,
      supports_tool_call: toolCalls.length > 0,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  通用对话模型  (general_chat)
// ═══════════════════════════════════════════════════════════════════════════════
export const GENERAL_CHAT_CASES: TestCase[] = [
  // ── T-01 基础可用性 ────────────────────────────────────────────────────
  {
    name: "T-01 基础可用性",
    description: "发送简单问候，验证模型是否响应并返回非空内容",
    test: "basic_availability",
    required: true,
    tags: ["basic", "availability"],
    buildPayload: (mid: string) =>
      _chatPayload(mid, [{ role: "user", content: "Hello, reply with exactly: OK" }]),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "basic_availability" }),
  },

  // ── T-02 中文支持 ──────────────────────────────────────────────────────
  {
    name: "T-02 中文支持",
    description: "验证模型是否能正常处理中文输入并返回中文内容",
    test: "chinese_support",
    required: true,
    tags: ["language", "chinese"],
    buildPayload: (mid: string) =>
      _chatPayload(mid, [{ role: "user", content: "用中文回答：你好，你是什么模型？一句话即可。" }]),
    parseResult: (r: any, e: number) => {
      const p = _parseChat(r, e);
      const content = p.content_preview || "";
      const hasChinese = /[\u4e00-\u9fff]/.test(content);
      return { ...p, test: "chinese_support", has_chinese: hasChinese };
    },
  },

  // ── T-03 工具调用（Function Calling） ──────────────────────────────────
  toolCallingCase,

  // ── T-04 Thinking-On（深度推理） ────────────────────────────────────────
  {
    name: "T-04 深度推理（Think On）",
    description: "测试模型是否支持 think/reasoning 模式（CoT 输出）",
    test: "think_on",
    required: false,
    tags: ["reasoning", "think_on"],
    buildPayload: (mid: string) => ({
      model: mid,
      max_tokens: 512,
      messages: [{ role: "user", content: "9.11 and 9.9, which is bigger? Think step by step." }],
      thinking: { type: "enabled", budget_tokens: 512 },
    }),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "think_on" }),
  },

  // ── T-05 Flash/无推理模式 ──────────────────────────────────────────────
  {
    name: "T-05 Flash/快速模式（Think Off）",
    description: "测试模型是否支持关闭推理的快速响应模式",
    test: "think_off",
    required: false,
    tags: ["flash", "think_off"],
    buildPayload: (mid: string) => ({
      model: mid,
      max_tokens: 128,
      messages: [{ role: "user", content: "Say 'FAST' and nothing else." }],
      thinking: { type: "disabled" },
    }),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "think_off" }),
  },

  // ── T-06 长文本/上下文 ─────────────────────────────────────────────────
  {
    name: "T-06 长上下文摘要",
    description: "输入中等长度文本，测试摘要能力 and 速度",
    test: "long_context",
    required: false,
    tags: ["long_context", "summarization"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content:
              "Summarize the following text in one sentence:\n\n" +
              "Artificial intelligence (AI) is intelligence demonstrated by machines, " +
              "as opposed to the natural intelligence displayed by animals including humans. " +
              "AI research has been defined as the field of study of intelligent agents, " +
              "which refers to any system that perceives its environment and takes actions " +
              "that maximize its chance of achieving its goals. " +
              "The term 'artificial intelligence' had previously been used to describe " +
              "machines that mimic and display 'human' cognitive skills associated with " +
              "the human mind, such as learning and problem-solving. " +
              "This definition has since been rejected by major AI researchers who now " +
              "describe AI in terms of rationality and acting rationally.",
          },
        ],
        { max_tokens: 128 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "long_context" }),
  },

  // ── T-07 流式输出（Streaming） ─────────────────────────────────────────
  {
    name: "T-07 流式输出（Streaming）",
    description: "测试 stream=true 首 token 延迟（TTFT）",
    test: "streaming",
    required: false,
    tags: ["streaming", "ttft"],
    buildPayload: (mid: string) => ({
      ..._chatPayload(mid, [{ role: "user", content: "Count from 1 to 5." }], { max_tokens: 64 }),
      stream: true,
    }),
    parseResult: (r: any, e: number) => {
      const base = typeof r === "object" && r !== null ? r : {};
      return { ...base, test: "streaming" };
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  视觉语言模型  (vision_language)
// ═══════════════════════════════════════════════════════════════════════════════
export const VLM_CASES: TestCase[] = [
  // 继承通用对话所有非 streaming 用例
  ...GENERAL_CHAT_CASES.filter((tc) => !tc.tags.includes("streaming")),

  // ── V-01 图文理解（VLM 核心） ──────────────────────────────────────────
  {
    name: "V-01 图文理解（VLM 核心）",
    description: "上传一张图片，测试模型是否能描述图片内容",
    test: "vlm_image_understanding",
    required: true,
    tags: ["vlm", "image_understanding"],
    buildPayload: (mid: string) => ({
      model: mid,
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: _TINY_PNG_DATA_URL } },
            { type: "text", text: "What color is this image? Reply in one word." },
          ],
        },
      ],
    }),
    parseResult: (r: any, e: number) => {
      const p = _parseChat(r, e);
      return { ...p, test: "vlm_image_understanding", supports_vlm: p.success };
    },
  },

  // ── V-02 多图输入支持 ──────────────────────────────────────────────────────
  {
    name: "V-02 多图输入支持",
    description: "测试模型是否支持多张图片同时输入",
    test: "multi_image",
    required: false,
    tags: ["vlm", "multi_image"],
    buildPayload: (mid: string) => ({
      model: mid,
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: _TINY_PNG_DATA_URL } },
            { type: "image_url", image_url: { url: _TINY_PNG_DATA_URL } },
            { type: "text", text: "Are these two images the same? Yes or No." },
          ],
        },
      ],
    }),
    parseResult: (r: any, e: number) => {
      const p = _parseChat(r, e);
      return { ...p, test: "multi_image", supports_multi_image: p.success };
    },
  },

  // ── V-03 图片输出（图像生成能力探测） ────────────────────────────────────
  {
    name: "V-03 图片输出能力",
    description: "探测模型是否能输出图片（multimodal output）",
    test: "image_output",
    required: false,
    tags: ["image_output", "multimodal_output"],
    buildPayload: (mid: string) => ({
      model: mid,
      max_tokens: 256,
      messages: [{ role: "user", content: "Generate an image of a blue circle." }],
    }),
    parseResult: (r: any, e: number) => {
      const p = _parseChat(r, e);
      const choices = r?.choices || [];
      let hasImageContent = false;
      for (const choice of choices) {
        const content = choice?.message?.content;
        if (content) {
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === "object" && part.type === "image_url") {
                hasImageContent = true;
                break;
              }
            }
          }
        }
        if (hasImageContent) break;
      }
      return {
        ...p,
        test: "image_output",
        has_image_content: hasImageContent,
      };
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  推理模型  (reasoning)
// ═══════════════════════════════════════════════════════════════════════════════
export const REASONING_CASES: TestCase[] = [
  {
    name: "R-01 基础可用性",
    description: "发送简单问题，验证模型响应",
    test: "basic",
    required: true,
    tags: ["basic"],
    buildPayload: (mid: string) => _chatPayload(mid, [{ role: "user", content: "What is 2+2?" }], { max_tokens: 64 }),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "basic" }),
  },
  {
    name: "R-02 数学推理",
    description: "测试复杂数学推理能力（需要多步思考）",
    test: "math_reasoning",
    required: true,
    tags: ["math", "reasoning"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content:
              "A train travels 120 km at 60 km/h, then 180 km at 90 km/h. " +
              "What is the average speed for the entire journey? Show your work.",
          },
        ],
        { max_tokens: 512 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "math_reasoning" }),
  },
  {
    name: "R-03 思维链输出（CoT）",
    description: "测试是否输出可见的 reasoning_content / thinking 字段",
    test: "cot_output",
    required: true,
    tags: ["cot", "think_on"],
    buildPayload: (mid: string) =>
      _chatPayload(mid, [{ role: "user", content: "Is 17 a prime number? Reason step by step." }], { max_tokens: 512 }),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "cot_output" }),
  },
  {
    name: "R-04 逻辑谜题",
    description: "测试逻辑推理能力",
    test: "logic_puzzle",
    required: true,
    tags: ["logic", "reasoning"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content:
              "There are 3 boxes: one has apples, one has oranges, one has both. " +
              "All labels are wrong. You can pick one fruit from one box. " +
              "Which box do you pick from to identify all boxes? Explain.",
          },
        ],
        { max_tokens: 512 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "logic_puzzle" }),
  },
  // 工具调用（推理模型也可能支持）
  toolCallingCase,
];

// ═══════════════════════════════════════════════════════════════════════════════
//  代码模型  (code)
// ═══════════════════════════════════════════════════════════════════════════════
export const CODE_CASES: TestCase[] = [
  {
    name: "C-01 基础代码生成",
    description: "生成 Python 函数，验证代码格式正确",
    test: "code_generation",
    required: true,
    tags: ["code_gen", "python"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content: "Write a Python function that returns the nth Fibonacci number. " + "Return only the code, no explanation.",
          },
        ],
        { max_tokens: 256 }
      ),
    parseResult: (r: any, e: number) => {
      const p = _parseChat(r, e);
      const content = p.content_preview || "";
      return { ...p, test: "code_generation", has_code_block: content.includes("def ") };
    },
  },
  {
    name: "C-02 代码补全（FIM）",
    description: "测试前缀/后缀代码补全能力（Fill-in-Middle）",
    test: "code_completion",
    required: false,
    tags: ["fim", "code_completion"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content: "Complete the following Python code:\n" + "def add(a, b):\n" + "    # TODO: return sum\n" + "    ",
          },
        ],
        { max_tokens: 64 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "code_completion" }),
  },
  {
    name: "C-03 代码调试",
    description: "给出有 bug 的代码，测试发现并修复能力",
    test: "code_debugging",
    required: true,
    tags: ["debugging"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content:
              "Fix the bug in this Python code and return only the fixed code:\n" +
              "def divide(a, b):\n" +
              "    return a / b\n\n" +
              "result = divide(10, 0)\n" +
              "print(result)",
          },
        ],
        { max_tokens: 256 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "code_debugging" }),
  },
  {
    name: "C-04 代码解释",
    description: "测试代码理解和中文解释能力",
    test: "code_explanation",
    required: true,
    tags: ["code_understanding"],
    buildPayload: (mid: string) =>
      _chatPayload(
        mid,
        [
          {
            role: "user",
            content:
              "用中文简要解释这段代码的作用（一句话）:\n" + "list(map(lambda x: x**2, filter(lambda x: x%2==0, range(10))))",
          },
        ],
        { max_tokens: 128 }
      ),
    parseResult: (r: any, e: number) => ({ ..._parseChat(r, e), test: "code_explanation" }),
  },
  // 工具调用（代码模型通常支持）
  toolCallingCase,
];

// ═══════════════════════════════════════════════════════════════════════════════
//  文本嵌入模型  (text_embedding)
// ═══════════════════════════════════════════════════════════════════════════════
export const EMBEDDING_CASES: TestCase[] = [
  {
    name: "E-01 基础嵌入生成",
    description: "对单条文本生成嵌入向量，验证维度和格式",
    test: "basic_embedding",
    required: true,
    tags: ["embedding", "basic"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: ["The quick brown fox jumps over the lazy dog."],
      input_type: "passage",
      encoding_format: "float",
      truncate: "END",
    }),
    parseResult: (r: any, e: number) => ({ ..._parseEmbedding(r, e), test: "basic_embedding" }),
  },
  {
    name: "E-02 批量嵌入",
    description: "批量编码多条文本，测试批处理支持",
    test: "batch_embedding",
    required: true,
    tags: ["embedding", "batch"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: ["Hello world", "This is a Chinese text sample", "The quick brown fox"],
      input_type: "passage",
      encoding_format: "float",
      truncate: "END",
    }),
    parseResult: (r: any, e: number) => {
      const p = _parseEmbedding(r, e);
      const data = r?.data || [];
      return {
        ...p,
        test: "batch_embedding",
        batch_count: data.length,
      };
    },
  },
  {
    name: "E-03 查询向量（Query Embedding）",
    description: "使用 query 模式生成检索查询向量",
    test: "query_embedding",
    required: true,
    tags: ["embedding", "query"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: ["What is the capital of France?"],
      input_type: "query",
      encoding_format: "float",
      truncate: "END",
    }),
    parseResult: (r: any, e: number) => ({ ..._parseEmbedding(r, e), test: "query_embedding" }),
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  图文嵌入模型  (multimodal_embedding)
// ═══════════════════════════════════════════════════════════════════════════════
export const MULTIMODAL_EMBEDDING_CASES: TestCase[] = [
  {
    name: "ME-01 文本嵌入",
    description: "通过图文嵌入模型对文本生成向量",
    test: "text_via_clip",
    required: true,
    tags: ["multimodal_embedding", "text"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: ["A photo of a cat"],
      input_type: "passage",
      encoding_format: "float",
      truncate: "END",
    }),
    parseResult: (r: any, e: number) => ({ ..._parseEmbedding(r, e), test: "text_via_clip" }),
  },
  {
    name: "ME-02 图文混合嵌入",
    description: "同时传入图片 URL 和文本，测试多模态编码",
    test: "image_via_clip",
    required: true,
    tags: ["multimodal_embedding", "image"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: [_TINY_PNG_DATA_URL, "A white image"],
      input_type: "passage",
      encoding_format: "float",
      truncate: "END",
    }),
    parseResult: (r: any, e: number) => ({ ..._parseEmbedding(r, e), test: "image_via_clip" }),
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  重排序模型  (reranker)
// ═══════════════════════════════════════════════════════════════════════════════
export const RERANKER_CASES: TestCase[] = [
  {
    name: "RR-01 基础重排序",
    description: "给定 query 和候选文档，测试重排序得分",
    test: "basic_rerank",
    required: true,
    tags: ["rerank", "basic"],
    buildPayload: (mid: string) => ({
      model: mid,
      query: "What is the capital of France?",
      passages: [
        { text: "Paris is the capital of France." },
        { text: "Lyon is a major city in France." },
        { text: "France is a country in Western Europe." },
      ],
    }),
    parseResult: (r: any, e: number) => {
      const rankings = r?.rankings || r?.data || r?.results || [];
      const success = rankings.length > 0;
      const firstRanking = rankings[0] || {};
      let topScore = firstRanking.relevance_score;
      if (topScore === undefined) {
        topScore = firstRanking.score;
      }
      return {
        success,
        elapsed_ms: Math.round(e),
        test: "basic_rerank",
        results_count: rankings.length,
        top_score: topScore,
      };
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  图像生成模型  (image_generation)
// ═══════════════════════════════════════════════════════════════════════════════
export const IMAGE_GEN_CASES: TestCase[] = [
  {
    name: "IG-01 文生图基础测试",
    description: "用简单提示词生成图片，验证是否返回 b64/url",
    test: "text2image",
    required: true,
    tags: ["image_gen", "text2image"],
    buildPayload: (mid: string) => ({
      model: mid,
      prompt: "A simple blue circle on white background",
      n: 1,
      size: "256x256",
      response_format: "b64_json",
    }),
    parseResult: (r: any, e: number) => {
      const data = r?.data || [];
      const success = data.length > 0;
      const first = data[0] || {};
      return {
        success,
        elapsed_ms: Math.round(e),
        test: "text2image",
        has_b64: !!first.b64_json,
        has_url: !!first.url,
      };
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  语音/音频模型  (audio)
// ═══════════════════════════════════════════════════════════════════════════════
export const AUDIO_CASES: TestCase[] = [
  {
    name: "AU-01 TTS 文本转语音",
    description: "测试 TTS 接口，验证是否返回音频数据",
    test: "tts",
    required: false,
    tags: ["tts", "audio_output"],
    buildPayload: (mid: string) => ({
      model: mid,
      input: "Hello, this is a test.",
      voice: "alloy",
      response_format: "mp3",
    }),
    parseResult: (r: any, e: number) => {
      const isBinary = Buffer.isBuffer(r) || r instanceof Uint8Array || r instanceof ArrayBuffer;
      const length = Buffer.isBuffer(r) || r instanceof Uint8Array ? r.length : r instanceof ArrayBuffer ? r.byteLength : 0;
      const success = isBinary && length > 0;
      return {
        success,
        elapsed_ms: Math.round(e),
        test: "tts",
        audio_size_bytes: length,
      };
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  映射表：category_key → 测试用例列表
// ═══════════════════════════════════════════════════════════════════════════════
export const CATEGORY_CASES: Record<string, TestCase[]> = {
  general_chat: GENERAL_CHAT_CASES,
  vision_language: VLM_CASES,
  reasoning: REASONING_CASES,
  code: CODE_CASES,
  text_embedding: EMBEDDING_CASES,
  multimodal_embedding: MULTIMODAL_EMBEDDING_CASES,
  reranker: RERANKER_CASES,
  image_generation: IMAGE_GEN_CASES,
  audio: AUDIO_CASES,
};

/**
 * 获取指定分类的测试用例（未知分类回退到通用对话用例）
 */
export function getCases(category: string): TestCase[] {
  return CATEGORY_CASES[category] || GENERAL_CHAT_CASES;
}
