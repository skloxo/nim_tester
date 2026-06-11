# -*- coding: utf-8 -*-
"""模型分类模块：基于关键词匹配将模型分组"""

import logging
from collections import defaultdict
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


class ModelCategorizer:
    """基于模型 ID 关键词进行智能分组"""

    def __init__(self, config: dict):
        self.rules = config["model_categories"]  # 保持 YAML 中定义的顺序

    def _classify(self, model_id: str) -> str:
        """返回模型所属分类 key"""
        mid = model_id.lower()
        for cat, rule in self.rules.items():
            keywords = rule.get("keywords", [])
            if any(kw in mid for kw in keywords):
                return cat
        # O-4: 兜底分类取 config 中最后一个分类（而非硬编码 general_chat）
        return list(self.rules.keys())[-1] if self.rules else "general_chat"

    def categorize(
        self, models: List[Dict[str, Any]]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """对模型列表进行分组，返回 {category_key: [model_dict, ...]}"""
        groups: Dict[str, List] = defaultdict(list)
        for model in models:
            model_id = model.get("id", "")
            cat = self._classify(model_id)
            groups[cat].append(model)
            logger.debug(f"  [{cat}] {model_id}")

        # 只返回有数据的分组，且按 YAML 定义顺序
        ordered = {}
        for cat in self.rules:
            if groups[cat]:
                ordered[cat] = groups[cat]
        return ordered
