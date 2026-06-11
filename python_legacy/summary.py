# -*- coding: utf-8 -*-
import json, yaml
from pathlib import Path

config = yaml.safe_load(open('config.yaml', encoding='utf-8'))
result_file = sorted(Path('results').glob('*/results.json'))[-1]
results = json.loads(result_file.read_text(encoding='utf-8'))
cat_conf = config['model_categories']

print()
print('=' * 65)
print('{:<20} {:>6} {:>7} {:>6} {:>6} {:>8}'.format(
    '分类', '模型数', '用例数', '通过', '失败', '通过率'))
print('-' * 65)
for category, cat_results in results.items():
    desc = cat_conf.get(category, {}).get('description', category)
    model_ids = list({r['model_id'] for r in cat_results})
    total = len(cat_results)
    passed = sum(1 for r in cat_results if r.get('status') == 'pass')
    failed = total - passed
    rate = '{:.1f}%'.format(passed/total*100) if total > 0 else 'N/A'
    print('{:<20} {:>6} {:>7} {:>6} {:>6} {:>8}'.format(
        desc, len(model_ids), total, passed, failed, rate))
print('=' * 65)
print()
print('报告位置:', result_file.parent.resolve())
