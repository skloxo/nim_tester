import { describe, it, expect } from "bun:test";
import { ModelCategorizer } from "./categorizer.ts";

describe("ModelCategorizer", () => {
  const defaultConfig = {
    model_categories: {
      text_embedding: {
        keywords: ["embed", "embedding", "e5-", "bge-"],
        description: "文本嵌入模型",
      },
      vision_language: {
        keywords: ["vision", "vlm", "llava"],
        description: "视觉语言模型",
      },
      code: {
        keywords: ["code", "codex", "starcoder"],
        description: "代码专用模型",
      },
      reasoning: {
        keywords: ["o1", "o3", "r1", "think"],
        description: "推理模型",
      },
      general_chat: {
        keywords: [],
        description: "通用对话模型",
      },
    },
  };

  describe("categorize", () => {
    it("should categorize embedding models", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "nvidia/e5-large" },
        { id: "bge-base-en" },
        { id: "embed-v1" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.text_embedding).toHaveLength(3);
    });

    it("should categorize vision models", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "llava-1.5" },
        { id: "vision-transformer" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.vision_language).toHaveLength(2);
    });

    it("should categorize code models", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "codex-large" },
        { id: "starcoder-15b" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.code).toHaveLength(2);
    });

    it("should categorize reasoning models", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "o1-preview" },
        { id: "o3-mini" },
        { id: "deepseek-r1" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.reasoning).toHaveLength(3);
    });

    it("should categorize unmatched models to general_chat", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "llama-3.1-70b" },
        { id: "gpt-4" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.general_chat).toHaveLength(2);
    });

    it("should handle empty model list", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const groups = categorizer.categorize([]);
      expect(Object.keys(groups)).toHaveLength(0);
    });

    it("should respect keyword priority", () => {
      const config = {
        model_categories: {
          specific: {
            keywords: ["my-model"],
            description: "Specific model",
          },
          general: {
            keywords: ["model"],
            description: "General model",
          },
        },
      };
      const categorizer = new ModelCategorizer(config);
      const models = [{ id: "my-model-v1" }];
      const groups = categorizer.categorize(models);
      expect(groups.specific).toHaveLength(1);
      // general is not in groups because no models matched it
      expect(groups.general).toBeUndefined();
    });

    it("should handle case-insensitive matching", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [
        { id: "EMBED-V1" },
        { id: "BGE-Large" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.text_embedding).toHaveLength(2);
    });

    it("should only return non-empty groups", () => {
      const categorizer = new ModelCategorizer(defaultConfig);
      const models = [{ id: "llama-3.1-70b" }];
      const groups = categorizer.categorize(models);
      expect(Object.keys(groups)).toHaveLength(1);
      expect(groups.general_chat).toHaveLength(1);
    });
  });

  describe("exclude keywords", () => {
    it("should exclude models matching exclude_keywords", () => {
      const config = {
        model_categories: {
          text_embedding: {
            keywords: ["embed"],
            exclude_keywords: ["vision"],
            description: "文本嵌入模型",
          },
          general_chat: {
            keywords: [],
            description: "通用对话模型",
          },
        },
      };
      const categorizer = new ModelCategorizer(config);
      const models = [
        { id: "embed-vision-model" },
        { id: "embed-text-model" },
      ];
      const groups = categorizer.categorize(models);
      expect(groups.text_embedding).toHaveLength(1);
      expect(groups.text_embedding?.[0]?.id).toBe("embed-text-model");
      expect(groups.general_chat).toHaveLength(1);
      expect(groups.general_chat?.[0]?.id).toBe("embed-vision-model");
    });
  });
});
