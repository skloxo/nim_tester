# -*- coding: utf-8 -*-
"""
API 模型测试框架 - 核心入口
支持多密钥轮换、代理/直连自动选速、模型自动分组、分类测试用例
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

import yaml

# ─── Windows 终端 UTF-8 修复（必须在 logging 配置之前）──────────────────────────
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from tester.network import NetworkSelector
from tester.model_fetcher import ModelFetcher
from tester.categorizer import ModelCategorizer
from tester.runner import TestRunner
from tester.reporter import Reporter
from tester.scorer import score_model, rank_category
from tester.use_case import infer_use_cases

# ─── 日志配置 ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

BANNER = """
╔══════════════════════════════════════════════════════════╗
║          API 模型全量测试框架  v1.1.0                    ║
║          支持 NVIDIA / OpenAI 兼容接口                   ║
╚══════════════════════════════════════════════════════════╝
"""


def load_config(path: str = "config.yaml") -> dict:
    """加载 YAML 配置文件"""
    config_path = Path(path)
    if not config_path.exists():
        logger.error(f"❌ 配置文件不存在: {path}")
        sys.exit(1)
    with open(config_path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _build_scored(results: dict, config: dict) -> dict:
    """对每个分类的模型计算评分、排名、使用场景（与 web_server 共享逻辑）"""
    cat_conf = config["model_categories"]
    output = {}
    for category, cat_results in results.items():
        desc = cat_conf.get(category, {}).get("description", category)
        by_model: dict = {}
        for r in cat_results:
            by_model.setdefault(r["model_id"], []).append(r)
        model_scores = {mid: score_model(rs) for mid, rs in by_model.items()}
        ranked = rank_category(model_scores)
        for mid, rs in by_model.items():
            ranked[mid]["use_cases"] = infer_use_cases(rs, category)
            ranked[mid]["results"] = rs
        output[category] = {"description": desc, "models": ranked}
    return output


def _print_scored(scored: dict):
    """在终端打印评分排名汇总表"""
    for cat, data in scored.items():
        desc = data["description"]
        models = data["models"]
        print(f"\n{'='*60}")
        print(f"  {desc}（{len(models)} 个模型）")
        print(f"{'='*60}")
        print(f"  {'排名':<5} {'评分':<7} {'等级':<5} {'通过/总':<9} {'TPS':<8} 推荐场景")
        print(f"  {'-'*75}")
        for mid, m in sorted(models.items(), key=lambda x: x[1]["rank"]):
            rank_icon = {1: "🥇", 2: "🥈", 3: "🥉"}.get(m["rank"], f"#{m['rank']}")
            short_id = mid.split("/")[-1][:30]
            print(
                f"  {rank_icon:<5} {m['score']:<7} {m['grade']:<5} "
                f"{m['passed']}/{m['total']:<7} {m['avg_tps']:<8} {m['use_cases']}"
            )


async def main():
    print(BANNER)
    config = load_config()

    # ── 1. 网络选速 ─────────────────────────────────────────────────────────
    logger.info("🌐 Step 1/5  自动测速，选择最优网络路径...")
    selector = NetworkSelector(config)
    best_mode, latency = await selector.select_best()
    logger.info(f"  ✅ 最优路径：{best_mode}（平均延迟 {latency:.0f}ms）")

    # ── 2. 拉取全量模型 ─────────────────────────────────────────────────────
    logger.info("📋 Step 2/5  拉取全量模型列表...")
    fetcher = ModelFetcher(config, best_mode)
    models = await fetcher.fetch_all()
    logger.info(f"  ✅ 共获取 {len(models)} 个模型")

    # ── 3. 模型分组 ─────────────────────────────────────────────────────────
    logger.info("🗂️  Step 3/5  模型智能分组...")
    categorizer = ModelCategorizer(config)
    groups = categorizer.categorize(models)
    for cat, items in groups.items():
        desc = config["model_categories"][cat]["description"]
        logger.info(f"  📂 {desc}：{len(items)} 个")

    # ── 4. 执行分类测试 ─────────────────────────────────────────────────────
    logger.info("🧪 Step 4/5  开始分类测试（并发={}）...".format(
        config["testing"]["concurrency"]
    ))
    runner = TestRunner(config, best_mode)
    results = await runner.run_all(groups)

    # ── 5. 评分 + 报告 ──────────────────────────────────────────────────────
    logger.info("📊 Step 5/5  生成评分报告...")
    scored = _build_scored(results, config)
    _print_scored(scored)

    # 同时保存 JSON
    from datetime import datetime
    import json
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("results") / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (out_dir / "scored.json").write_text(
        json.dumps(
            {cat: {**d, "models": {mid: {k: v for k, v in m.items() if k != "results"}
                                   for mid, m in d["models"].items()}}
             for cat, d in scored.items()},
            ensure_ascii=False, indent=2, default=str,
        ), encoding="utf-8"
    )
    logger.info(f"  ✅ 结果已保存至：{out_dir}")

    # 旧 Reporter 仍可生成 Excel
    try:
        reporter = Reporter(config)
        output_dir = reporter.save(results)
        logger.info(f"  ✅ Excel 报告：{output_dir}")
    except Exception as e:
        logger.warning(f"Excel 生成跳过：{e}")


if __name__ == "__main__":
    asyncio.run(main())
