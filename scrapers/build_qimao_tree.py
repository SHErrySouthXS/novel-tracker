#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从飞书《novel-tracker 分类池》09_七猫分类池 tab 生成 trio-embed 树形布局词典
data/qimao_tree.json（幂等，零臆造）。

数据源（sheet xiRvLn）：
  行 6-8    一级池 L1：官方大类 major 3 词
  行 12-22  二级池 L2：官方细分 minor 11 词，列 A 形如「L2·现代言情 细分」标明所属 major

口径（sherry 2026-09-08 拍板 · 2026-09-12 用于站点模块）：
  七猫无 free-tag 字段、详情页无标签区，唯一题材维度 = 官方 major→minor 两级树；
  major/minor 每书各单值，minor 物理归属 major（1:1 父子，非交叉）
  → major 即天然互斥的赛道轴，无需再分组。

用法：
  lark-cli sheets +csv-get --url https://my.feishu.cn/sheets/Jus1sNfDihnlaettxjrcqhyDnWf \
    --sheet-id xiRvLn --range A1:E30 > /tmp/qm_raw.json
  python3 scrapers/build_qimao_tree.py /tmp/qm_raw.json
"""
import json
import re
import csv
import io
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/qm_raw.json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "qimao_tree.json")

# --- 1. 解析飞书 annotated_csv ---
d = json.load(open(SRC))
rows = []
for line in d["data"]["annotated_csv"].split("\n"):
    m = re.match(r"\[row=(\d+)\]\s?(.*)$", line)
    if not m:
        continue
    parts = next(csv.reader(io.StringIO(m.group(2))))
    rows.append((int(m.group(1)), parts))

# --- 2. L1：行 6-8 官方大类 ---
MAJORS = []
for rn, p in rows:
    if 6 <= rn <= 8 and len(p) > 1 and p[1].strip():
        MAJORS.append(p[1].strip())
assert len(MAJORS) == 3, f"官方大类应为 3 词，实得 {len(MAJORS)}: {MAJORS}"

# --- 3. L2：行 12-22 官方细分，列 A 前向填充「所属 major」 ---
TREE = {m: [] for m in MAJORS}
cur_major = None
for rn, p in rows:
    if rn < 12:
        continue
    a = (p[0] if len(p) > 0 else "").strip()
    b = (p[1] if len(p) > 1 else "").strip()
    m = re.match(r"^L2·(.+?)\s*细分$", a)
    if m:
        cur_major = m.group(1).strip()
        assert cur_major in TREE, f"二级块「{cur_major}」不在官方大类里：{MAJORS}"
    if not b or b == "具体 tag":
        continue
    assert cur_major, f"第 {rn} 行的细分「{b}」没有所属 major"
    if b not in TREE[cur_major]:
        TREE[cur_major].append(b)

MINORS = [x for v in TREE.values() for x in v]
assert len(MINORS) == 11, f"官方细分应为 11 词，实得 {len(MINORS)}: {MINORS}"
assert len(set(MINORS)) == len(MINORS), f"细分出现重复：{MINORS}"
for m in MAJORS:
    assert TREE[m], f"大类「{m}」下没有细分"

# --- 4. 组装词典 ---
out = {
    "platform": "qimao",
    "version": "v1",
    "layout": "tree",                 # 树形布局：官方两级树 + 书籍明细 + 结构画像
    "l1Field": "tree",
    "l1Tabs": {"field": "channel"},   # 一级：官方大类 major（= 站内 channel 字段）
    "l2Bars": {"field": "category"},  # 二级：官方细分 minor（= 站内 category 字段）
    "tabUnit": "大类",
    "defaultTab": MAJORS[0],
    "L1": [{"name": m} for m in MAJORS],
    "tree": TREE,
    "meta": {
        "source": "飞书《novel-tracker 分类池》09_七猫分类池（v1，官方树直建）",
        "source_url": "https://my.feishu.cn/sheets/Jus1sNfDihnlaettxjrcqhyDnWf?sheet=xiRvLn",
        "note": (
            "七猫无自由标签字段、详情页无标签区，唯一题材维度 = 官方 major→minor 两级树"
            "（major 每书单值、minor 物理归属 major，1:1 父子非交叉）→ major 即天然互斥赛道轴。"
            "口径经 sherry 2026-09-08 拍板，2026-09-12 落地为站点题材模块。"
        ),
        "counts": {"majors": len(MAJORS), "minors": len(MINORS)},
    },
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")

print(f"✅ {OUT}")
print(f"   L1 大类 {len(MAJORS)}：{' / '.join(MAJORS)}")
for m in MAJORS:
    print(f"   {m} → {' / '.join(TREE[m])}")
