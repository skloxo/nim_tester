export class ModelCategorizer {
  private rules: Record<string, { keywords: string[]; exclude_keywords?: string[]; description?: string }>;

  constructor(config: any) {
    this.rules = config.model_categories || {};
  }

  private classify(modelId: string): string {
    const mid = modelId.toLowerCase();
    const categories = Object.keys(this.rules);

    for (const [cat, rule] of Object.entries(this.rules)) {
      const keywords = rule.keywords || [];
      const excludeKeywords = rule.exclude_keywords || [];

      // If keywords list is empty, it should not match directly (it's the fallback)
      if (keywords.length === 0) {
        continue;
      }

      const matchesKeyword = keywords.some((kw) => mid.includes(kw.toLowerCase()));
      const matchesExclude = excludeKeywords.some((ex) => mid.includes(ex.toLowerCase()));

      if (matchesKeyword && !matchesExclude) {
        return cat;
      }
    }

    return (categories.length > 0 ? categories[categories.length - 1] : "general_chat") ?? "general_chat";
  }

  categorize(models: any[]): Record<string, any[]> {
    const groups: Record<string, any[]> = {};
    for (const cat of Object.keys(this.rules)) {
      groups[cat] = [];
    }

    for (const model of models) {
      const modelId = model.id || "";
      const cat = this.classify(modelId);
      if (!groups[cat]) {
        groups[cat] = [];
      }
      groups[cat].push(model);
    }

    const ordered: Record<string, any[]> = {};
    for (const cat of Object.keys(this.rules)) {
      if (groups[cat] && groups[cat].length > 0) {
        ordered[cat] = groups[cat];
      }
    }
    return ordered;
  }
}
