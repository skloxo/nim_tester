# -*- coding: utf-8 -*-
"""模型评分模块：同分类内横向评分 + 排名"""

# 各测试用例权重（满分 90，另 10 分来自速度）
TEST_WEIGHTS = {
    "basic_availability": 30, "chinese_support": 10, "tool_calling": 20,
    "streaming": 10, "think_on": 8, "think_off": 4, "long_context": 8,
    "code_generation": 30, "code_completion": 15, "code_debugging": 30,
    "code_explanation": 15, "basic_embedding": 40, "batch_embedding": 30,
    "query_embedding": 30, "vlm_image_understanding": 30, "multi_image": 15,
    "basic_rerank": 100, "text2image": 100,
    "basic": 20, "math_reasoning": 30, "cot_output": 30, "logic_puzzle": 20,
    "text_via_clip": 50, "image_via_clip": 50, "tts": 100,
}
GRADE_MAP = [(85, "S"), (70, "A"), (55, "B"), (40, "C"), (20, "D"), (0, "F")]


def score_model(results: list) -> dict:
    """计算单个模型的综合评分（0-100）"""
    weighted_sum, total_weight, tps_list, elapsed_list = 0, 0, [], []
    for r in results:
        status = r.get("status", "")
        if status == "skip":
            continue  # skip = 模型不支持该功能，不计入评分分母
        w = TEST_WEIGHTS.get(r.get("test", ""), 0)
        if w:
            total_weight += w
            if status == "pass":
                weighted_sum += w
        tps = r.get("tps", 0)
        if tps and tps > 0:
            tps_list.append(tps)
        elapsed = r.get("elapsed_ms", 0)
        if elapsed and elapsed > 0:
            elapsed_list.append(elapsed)

    base = (weighted_sum / total_weight * 90) if total_weight else 0
    avg_tps = sum(tps_list) / len(tps_list) if tps_list else 0
    # D-2: 对无 TPS 的模型（embedding/reranker），用 elapsed_ms 倒数作速度指标
    avg_elapsed = sum(elapsed_list) / len(elapsed_list) if elapsed_list else 0
    score = round(base, 1)
    grade = next(g for threshold, g in GRADE_MAP if score >= threshold)
    passed = sum(1 for r in results if r.get("status") == "pass")
    skipped = sum(1 for r in results if r.get("status") == "skip")
    return {
        "score": score,
        "grade": grade,
        "avg_tps": round(avg_tps, 1),
        "avg_elapsed": round(avg_elapsed, 1),  # 供 rank_category 使用
        "passed": passed,
        "skipped": skipped,
        "total": len(results),
    }


def rank_category(model_score_map: dict) -> dict:
    """
    输入: {model_id: score_dict}
    输出: {model_id: {rank, score, grade, ...}}，按分类内分数排名
    """
    if not model_score_map:
        return {}

    # 速度归一化加分（类内最快 +10，最慢 +0）
    # TPS 模型（chat/code/vlm）按 avg_tps 归一化
    # D-2: 无 TPS 的模型（embedding/reranker）按 avg_elapsed 倒数归一化
    tps_values = [v["avg_tps"] for v in model_score_map.values() if v["avg_tps"] > 0]
    max_tps = max(tps_values) if tps_values else 0

    if max_tps > 0:
        # 有 TPS 数据的分类（如对话/推理/代码等）。avg_tps == 0 的模型在此分类中不给速度奖励分，防止因流式失败反而拿满分。
        min_elapsed = 0
    else:
        # 纯非 TPS 分类（如 embedding/reranker）。使用 avg_elapsed 倒数归一化速度分。
        elapsed_values = [v["avg_elapsed"] for v in model_score_map.values() if v["avg_elapsed"] > 0]
        min_elapsed = min(elapsed_values) if elapsed_values else 0

    scored = {}
    for mid, s in model_score_map.items():
        if s["avg_tps"] > 0 and max_tps > 0:
            speed_bonus = s["avg_tps"] / max_tps * 10
        elif max_tps == 0 and s["avg_elapsed"] > 0 and min_elapsed > 0:
            # 仅在非 TPS 分类下才使用延迟倒数加分
            speed_bonus = min_elapsed / s["avg_elapsed"] * 10
        else:
            speed_bonus = 0
        final = min(100, round(s["score"] + speed_bonus, 1))
        grade = next(g for threshold, g in GRADE_MAP if final >= threshold)
        scored[mid] = {**s, "score": final, "grade": grade}

    # 排名（分数相同并列）
    sorted_ids = sorted(scored, key=lambda m: scored[m]["score"], reverse=True)
    rank, prev_score, prev_rank = 1, None, 1
    for i, mid in enumerate(sorted_ids):
        if scored[mid]["score"] != prev_score:
            prev_rank = i + 1
        scored[mid]["rank"] = prev_rank
        prev_score = scored[mid]["score"]

    return scored
