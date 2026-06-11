import { getMetaCache, saveMetaCache } from "./db";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const CATALOG_PATH = join(import.meta.dir, "../../data/model_catalog.json");
const RAW_HF_DIR = join(import.meta.dir, "../../data/hf_raw");

let catalogCache: Record<string, any> = {};
let catalogLoaded = false;

function loadCatalog(): Record<string, any> {
  if (catalogLoaded) {
    return catalogCache;
  }
  if (existsSync(CATALOG_PATH)) {
    try {
      const content = readFileSync(CATALOG_PATH, "utf-8");
      catalogCache = JSON.parse(content);
      console.log(`  [META] 已加载本地目录：${Object.keys(catalogCache).length} 个模型 (${CATALOG_PATH})`);
    } catch (e: any) {
      console.warn(`  [META] catalog 加载失败: ${e.message || e}，将使用 KB + 正则`);
    }
  } else {
    console.log("  [META] data/model_catalog.json 未找到，使用本地 KB + 正则");
  }
  catalogLoaded = true;
  return catalogCache;
}

const LOCAL_KB: Record<string, any> = {
  // Meta Llama 3.x
  "llama-3.1-8b":   { param_count: 8,   max_context: 128000, release_date: "2024-07" },
  "llama-3.1-70b":  { param_count: 70,  max_context: 128000, release_date: "2024-07" },
  "llama-3.1-405b": { param_count: 405, max_context: 128000, release_date: "2024-07" },
  "llama-3.2-1b":   { param_count: 1,   max_context: 128000, release_date: "2024-09" },
  "llama-3.2-3b":   { param_count: 3,   max_context: 128000, release_date: "2024-09" },
  "llama-3.2-11b":  { param_count: 11,  max_context: 128000, release_date: "2024-09" },
  "llama-3.2-90b":  { param_count: 90,  max_context: 128000, release_date: "2024-09" },
  "llama-3.3-70b":  { param_count: 70,  max_context: 128000, release_date: "2024-12" },
  "llama-4-maverick-17b": { param_count: 17, active_params: 17, max_context: 1000000, release_date: "2025-04" },
  "llama2-70b":     { param_count: 70,  max_context: 4096,   release_date: "2023-07" },
  // Mistral
  "mistral-7b":     { param_count: 7,   max_context: 32768,  release_date: "2023-09" },
  "mistral-large":  { param_count: 123, max_context: 128000, release_date: "2024-02" },
  "mixtral-8x7b":   { param_count: 56,  active_params: 14,   max_context: 32768, release_date: "2023-12" },
  "mixtral-8x22b":  { param_count: 176, active_params: 44,   max_context: 65536, release_date: "2024-04" },
  "mistral-large-3-675b": { param_count: 675, max_context: 128000, release_date: "2025-05" },
  "mistral-medium-3.5-128b": { param_count: 128, max_context: 128000, release_date: "2025-04" },
  // Google Gemma
  "gemma-2-2b":     { param_count: 2,   max_context: 8192,   release_date: "2024-06" },
  "gemma-2b":       { param_count: 2,   max_context: 8192,   release_date: "2024-02" },
  "gemma-3-4b":     { param_count: 4,   max_context: 128000, release_date: "2025-03" },
  "gemma-3-12b":    { param_count: 12,  max_context: 128000, release_date: "2025-03" },
  "gemma-4-31b":    { param_count: 31,  max_context: 1000000, release_date: "2025-04" },
  // Microsoft Phi
  "phi-3-vision-128k": { param_count: 4.2, max_context: 128000, release_date: "2024-05" },
  "phi-4-mini":     { param_count: 3.8, max_context: 128000, release_date: "2025-02" },
  "phi-4-multimodal": { param_count: 5.6, max_context: 128000, release_date: "2025-02" },
  "phi-3.5-moe":    { param_count: 42,  active_params: 7,   max_context: 128000, release_date: "2024-08" },
  // NVIDIA Nemotron
  "nemotron-4-340b":     { param_count: 340, max_context: 4096,   release_date: "2024-06" },
  "nemotron-70b":        { param_count: 70,  max_context: 128000, release_date: "2024-10" },
  "nemotron-51b":        { param_count: 51,  max_context: 128000, release_date: "2024-10" },
  "nemotron-mini-4b":    { param_count: 4,   max_context: 4096,   release_date: "2024-09" },
  "nemotron-nano-8b":    { param_count: 8,   max_context: 128000, release_date: "2025-01" },
  "nemotron-super-49b":  { param_count: 49,  max_context: 128000, release_date: "2025-01" },
  "nemotron-ultra-253b": { param_count: 253, max_context: 128000, release_date: "2025-03" },
  "nemotron-nano-12b-v2-vl": { param_count: 12, max_context: 32768, release_date: "2025-03" },
  "nemotron-3-nano-30b": { param_count: 30, active_params: 3, max_context: 128000, release_date: "2025-04" },
  // DeepSeek
  "deepseek-coder-6.7b": { param_count: 6.7, max_context: 16384, release_date: "2023-11" },
  "deepseek-r1":         { param_count: 671, active_params: 37,  max_context: 128000, release_date: "2025-01" },
  "deepseek-v4-flash":   { param_count: 671, active_params: 37,  max_context: 128000, release_date: "2025-05" },
  "deepseek-v4-pro":     { param_count: 671, active_params: 37,  max_context: 128000, release_date: "2025-05" },
  // Embedding
  "bge-m3":              { param_count: 0.57, embed_dim: 1024, max_context: 8192,  release_date: "2024-01" },
  "arctic-embed-l":      { param_count: 0.33, embed_dim: 1024, max_context: 512,   release_date: "2024-04" },
  "nv-embed-v1":         { param_count: 7.8,  embed_dim: 4096, max_context: 32768, release_date: "2024-05" },
  "nv-embedqa-e5-v5":    { param_count: 0.7,  embed_dim: 1024, max_context: 512,   release_date: "2024-06" },
  "llama-3.2-nv-embedqa-1b": { param_count: 1, embed_dim: 2048, max_context: 8192, release_date: "2024-10" },
  // Qwen
  "qwen3-coder-480b":    { param_count: 480, active_params: 35, max_context: 32768, release_date: "2025-05" },
  "qwen3-next-80b":      { param_count: 80,  active_params: 3,  max_context: 128000, release_date: "2025-05" },
  "qwen3.5-122b":        { param_count: 122, active_params: 10, max_context: 128000, release_date: "2025-05" },
  "qwen3.5-397b":        { param_count: 397, active_params: 17, max_context: 128000, release_date: "2025-05" },
  // Starcoder
  "starcoder2-15b":      { param_count: 15, max_context: 16384, release_date: "2024-02" },
  // VLM
  "llava":               { param_count: 13, max_context: 4096,  release_date: "2023-10" },
  "neva-22b":            { param_count: 22, max_context: 4096,  release_date: "2023-12" },
  "fuyu-8b":             { param_count: 8,  max_context: 16384, release_date: "2023-10" },
  "kosmos-2":            { param_count: 1.6, max_context: 4096,  release_date: "2023-06" },
  // Others
  "ibm/granite-34b":     { param_count: 34, max_context: 8192,  release_date: "2024-09" },
};

function matchKb(modelId: string): Record<string, any> {
  const mid = modelId.toLowerCase();
  let bestMatch: Record<string, any> = {};
  let bestLen = 0;
  for (const [fragment, data] of Object.entries(LOCAL_KB)) {
    if (mid.includes(fragment.toLowerCase()) && fragment.length > bestLen) {
      bestMatch = { ...data };
      bestLen = fragment.length;
    }
  }
  return bestMatch;
}

function parseFromId(modelId: string): Record<string, any> {
  const mid = modelId.toLowerCase();
  const result: Record<string, any> = {};

  const moeMatch = /(\d+(?:\.\d+)?)b[_-]?a(\d+(?:\.\d+)?)b/.exec(mid);
  if (moeMatch) {
    result.param_count = parseFloat(moeMatch[1] ?? "");
    result.active_params = parseFloat(moeMatch[2] ?? "");
  } else {
    const moe2 = /(\d+)x(\d+(?:\.\d+)?)b/.exec(mid);
    if (moe2) {
      result.param_count = parseInt(moe2[1] ?? "", 10) * parseFloat(moe2[2] ?? "");
      result.active_params = parseFloat(moe2[2] ?? "");
    } else {
      let paramMatch = /(\d+(?:\.\d+)?)b(?:[_\-]|$|\d)/.exec(mid);
      if (!paramMatch) {
        paramMatch = /(\d+(?:\.\d+)?)b/.exec(mid);
      }
      if (paramMatch) {
        result.param_count = parseFloat(paramMatch[1] ?? "");
      }
    }
  }

  const ctxMatch = /(\d+)k(?:[_\-]|$)/.exec(mid);
  if (ctxMatch) {
    result.max_context = parseInt(ctxMatch[1] ?? "", 10) * 1024;
  }

  return result;
}

export async function fetchModelMeta(modelId: string): Promise<Record<string, any>> {
  const cached = getMetaCache(modelId);
  if (cached) {
    return cached;
  }

  const meta: Record<string, any> = {};

  const catalog = loadCatalog();
  if (catalog[modelId]) {
    const entry = catalog[modelId];
    const keys = [
      "param_count", "active_params", "max_context", "embed_dim",
      "release_date", "hf_pipeline_tag", "hf_category", "description",
      "languages", "display_name"
    ];
    for (const k of keys) {
      if (entry[k] !== undefined) {
        meta[k] = entry[k];
      }
    }
  }

  const kbData = matchKb(modelId);
  for (const [k, v] of Object.entries(kbData)) {
    if (meta[k] === undefined) {
      meta[k] = v;
    }
  }

  const parsed = parseFromId(modelId);
  for (const [k, v] of Object.entries(parsed)) {
    if (meta[k] === undefined) {
      meta[k] = v;
    }
  }

  const releaseDate = meta.release_date || "";
  if (releaseDate && typeof releaseDate === "string") {
    try {
      const parts = releaseDate.slice(0, 7).split("-");
      const ry = parseInt(parts[0] ?? "", 10);
      const rm = parseInt(parts[1] ?? "", 10);
      const now = new Date();
      meta.age_months = (now.getFullYear() - ry) * 12 + (now.getMonth() + 1 - rm);
    } catch {
      // ignore
    }
  }

  if (Object.keys(meta).length > 0) {
    saveMetaCache(modelId, meta);
  }

  return meta;
}

async function fetchHfOnline(modelId: string, proxy?: string): Promise<Record<string, any>> {
  try {
    const url = `https://huggingface.co/api/models/${modelId}`;
    const options: any = {
      method: "GET",
    };
    if (proxy) {
      options.proxy = proxy;
    }

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 12000);
    options.signal = controller.signal;

    const resp = await fetch(url, options);
    clearTimeout(id);

    if (resp.status === 200) {
      const data = await resp.json() as any;
      const meta: Record<string, any> = {};
      if (data.pipeline_tag) {
        meta.hf_pipeline_tag = data.pipeline_tag;
      }
      if (data.createdAt) {
        meta.release_date = data.createdAt.slice(0, 7);
      }
      const tags = data.tags || [];
      const langs = tags.filter((t: any) => typeof t === "string" && t.length === 2 && /^[a-zA-Z]+$/.test(t));
      if (langs.length > 0) {
        meta.languages = langs.slice(0, 5);
      }
      return meta;
    }
  } catch (e: any) {
    console.log(`  [HF] ${modelId} fetch failed:`, e.message || e);
  }
  return {};
}

async function incrementalUpdateCatalog(newModelIds: string[], proxy?: string): Promise<Record<string, any>> {
  const newEntries: Record<string, any> = {};
  if (newModelIds.length === 0) {
    return newEntries;
  }

  const limit = 5;
  for (let i = 0; i < newModelIds.length; i += limit) {
    const chunk = newModelIds.slice(i, i + limit);
    await Promise.all(
      chunk.map(async (mid) => {
        const entry: Record<string, any> = {
          id: mid,
          updated_at: new Date().toISOString().slice(0, 19),
        };

        const kb = matchKb(mid);
        Object.assign(entry, kb);

        const parsed = parseFromId(mid);
        for (const [k, v] of Object.entries(parsed)) {
          if (entry[k] === undefined) {
            entry[k] = v;
          }
        }

        try {
          const hf = await fetchHfOnline(mid, proxy);
          for (const [k, v] of Object.entries(hf)) {
            if (entry[k] === undefined || (k === "release_date" && !kb.release_date)) {
              entry[k] = v;
            }
          }
        } catch {
          // ignore
        }

        newEntries[mid] = entry;
      })
    );
  }

  if (Object.keys(newEntries).length > 0) {
    try {
      let catalog: Record<string, any> = {};
      if (existsSync(CATALOG_PATH)) {
        try {
          catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
        } catch {
          catalog = {};
        }
      } else {
        const dir = join(CATALOG_PATH, "..");
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      Object.assign(catalog, newEntries);
      writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
      Object.assign(catalogCache, newEntries);
      console.log(`  [META] catalog 增量更新：新增 ${Object.keys(newEntries).length} 个模型 → ${CATALOG_PATH}`);
    } catch (e: any) {
      console.warn(`  [META] catalog 回写失败: ${e.message || e}`);
    }
  }

  return newEntries;
}

export async function bulkInitMeta(modelIds: string[], proxy: string = ""): Promise<Record<string, any>> {
  const catalog = loadCatalog();

  const newModels = modelIds.filter((mid) => !catalog[mid]);
  if (newModels.length > 0) {
    console.log(`  [META] 发现 ${newModels.length} 个新模型，增量获取元数据...`);
    await incrementalUpdateCatalog(newModels, proxy);
  } else {
    console.log(`  [META] 全部 ${modelIds.length} 个模型已在 catalog 中`);
  }

  const out: Record<string, any> = {};
  for (const mid of modelIds) {
    try {
      out[mid] = await fetchModelMeta(mid);
    } catch (e: any) {
      console.warn(`  [META] ${mid}: ${e.message || e}`);
      out[mid] = {};
    }
  }

  const hasParams = Object.values(out).filter((m) => m.param_count).length;
  const hasDate = Object.values(out).filter((m) => m.release_date).length;
  console.log(`  [META] 汇总: ${Object.keys(out).length} 个模型 | 参数量 ${hasParams} | 发布日期 ${hasDate}`);
  return out;
}

export async function fetchAllMeta(modelIds: string[], proxy: string = ""): Promise<Record<string, any>> {
  return await bulkInitMeta(modelIds, proxy);
}
