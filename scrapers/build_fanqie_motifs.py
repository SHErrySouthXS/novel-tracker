#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从飞书《novel-tracker 分类池》08_番茄分类池 tab 生成 trio-embed 词典 data/fanqie_motifs.json。

数据源（sheet bxYkwm，行 1-223）：
  行 4-28   一级池 L1（23 词）+ 说明
  行 30-223 二级池（192 词，12 词性维度分块；列 A 形如「题材背景·现言」表示子分组）

生成规则（零臆造）：
  L1 = 08 tab 一级池 23 词 + 动漫衍生（官方主分类，sherry 2026-09-11 拍板补进 L1）= 24 词
  L2 = 08 tab 二级池 192 词 - 动漫衍生（已升 L1）= 191 词
  dims 顺序 = 题材背景 / 情节走向 / 衍生创作 / 基调风格 / 结局标签 / 叙事结构（S）
              / CP设定 / 人物设定（P）   ← sherry 2026-09-11 拍板：第三栏 CP设定 在前

赛道（tab）= 互斥分组（sherry 2026-09-12 拍板）：
  原「全部 / 双男主 / 双女主 / 无CP / 纯爱」有重复感 ——
  ① 「全部」里会列出「双男主」行，与同名 tab 重复；
  ② 「纯爱」91% ⊂ 「双男主」，两者重叠。
  改为按取向轴互斥划分：BG（男女，兜底）/ 双男主（含纯爱）/ 双女主 / 无CP。
  书归且仅归一组（组内可多词命中，组间不相交），live 实测 双男主 ∩ 无CP = 0。
  这 4 词标 status="tab" 退出「一级词列表池」，避免列表再出现同名行。

用法：
  lark-cli sheets +csv-get --url <url> --sheet-id bxYkwm --range A1:F223 > /tmp/fq_raw.json
  python3 scrapers/build_fanqie_motifs.py /tmp/fq_raw.json
"""
import json
import re
import csv
import io
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fq_raw.json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "fanqie_motifs.json")

# --- 1. 解析飞书 annotated_csv ---
d = json.load(open(SRC))
rows = []
for line in d["data"]["annotated_csv"].split("\n"):
    m = re.match(r"\[row=(\d+)\]\s?(.*)$", line)
    if not m:
        continue
    parts = next(csv.reader(io.StringIO(m.group(2))))
    rows.append((int(m.group(1)), parts))

# 一级池：行 6-28（行 4/5 是标题与表头）
L1 = []
for rn, p in rows:
    if 6 <= rn <= 28 and len(p) > 1 and p[1].strip():
        L1.append(p[1].strip())
assert len(L1) == 23, f"一级池应为 23 词，实得 {len(L1)}: {L1}"

# 二级池：行 32-223，列 A 前向填充维度名（形如 题材背景·现言 = 维度·子分组）
blocks = []
cur = None
for rn, p in rows:
    if rn < 32:
        continue
    a = p[0].strip() if len(p) > 0 else ""
    tag = p[1].strip() if len(p) > 1 else ""
    if a:
        cur = {"dim": a, "tags": []}
        blocks.append(cur)
    if tag and cur is not None:
        cur["tags"].append(tag)

# --- 2. 维度归并（· 前为父维度，· 后为子分组）---
DIM_ORDER = ["题材背景", "情节走向", "衍生创作", "基调风格", "结局标签", "叙事结构",
             "CP设定", "人物设定"]
DIM_GROUP = {"CP设定": "P", "人物设定": "P"}

motifs = []
subs_of = {}
seen_dim = []
for g in blocks:
    base, _, sub = g["dim"].partition("·")
    if base not in seen_dim:
        seen_dim.append(base)
    if sub:
        subs_of.setdefault(base, []).append(sub)
    for t in g["tags"]:
        motifs.append({"name": t, "dim": base, "sub": sub or None})

# --- 3. 动漫衍生升 L1，从二级池移出 ---
L1_FINAL = L1 + ["动漫衍生"]
L1SET = set(L1_FINAL)
motifs = [m for m in motifs if m["name"] not in L1SET]

# --- 4. 赛道互斥分组（取向轴）---
# 顺序即判定优先级；match 为空的组是兜底组（未命中任何其他组时归属）。
# 双男主组收编「纯爱」（原「纯爱」赛道 91% ⊂ 双男主）。
TAB_GROUPS = [
    {"name": "BG", "match": []},
    {"name": "双男主", "match": ["双男主", "纯爱"]},
    {"name": "双女主", "match": ["双女主"]},
    {"name": "无CP", "match": ["无CP"]},
]
TAB_WORDS = [w for g in TAB_GROUPS for w in g["match"]]
assert len(TAB_WORDS) == len(set(TAB_WORDS)), f"赛道词重复: {TAB_WORDS}"
assert set(TAB_WORDS) <= L1SET, f"赛道词必须属于一级池: {set(TAB_WORDS) - L1SET}"
assert sum(1 for g in TAB_GROUPS if not g["match"]) == 1, "必须恰有一个兜底组"
DEFAULT_TAB = TAB_GROUPS[0]["name"]

dims = []
for name in DIM_ORDER:
    dims.append({"name": name, "group": DIM_GROUP.get(name, "S"),
                 "subs": subs_of.get(name) or None})
missing = [d for d in seen_dim if d not in DIM_ORDER]
assert not missing, f"08 tab 出现未登记维度: {missing}"

dict_obj = {
    "platform": "fanqie",
    "version": "v2",
    "meta": {
        "source": "飞书《novel-tracker 分类池》08_番茄分类池 tab（sheet bxYkwm）",
        "generated_by": "scrapers/build_fanqie_motifs.py",
        "L1_note": "24 词 = 08 tab 一级池 23 + 动漫衍生（官方主分类，升入 L1）",
        "note": "二级池 192 词 - 动漫衍生 = 191；合计词表 215。"
                "赛道词（双男主/纯爱/双女主/无CP）标 status=tab，退出列表池。",
    },
    "l1Field": "tagmatch",
    "l1Tabs": {"field": "taghit", "groups": TAB_GROUPS},
    "l2Bars": {"field": "taghit", "mode": "firsthit"},
    "baseline": "global",
    "defaultTab": DEFAULT_TAB,
    "tabUnit": "赛道",
    "barsNote": "该赛道在番茄即为一级题材本身，赛道内无题材细分；细分见右侧母题",
    "defaultDim": "题材背景",
    "L1": [dict({"name": x}, **({"status": "tab"} if x in TAB_WORDS else {})) for x in L1_FINAL],
    "dims": dims,
    "motifs": motifs,
    "ignore": [],
}

json.dump(dict_obj, open(OUT, "w"), ensure_ascii=False, indent=2)

print(f"✅ {os.path.normpath(OUT)}")
print(f"   L1 {len(L1_FINAL)} 词: {' '.join(L1_FINAL)}")
print(f"   L2 {len(motifs)} 词 / {len(dims)} 维")
for x in dims:
    n = sum(1 for m in motifs if m["dim"] == x["name"])
    print(f"     [{x['group']}] {x['name']:6} {n:3} 词  subs={x['subs']}")
print(f"   合计词表 {len(L1_FINAL) + len(motifs)}")
print(f"   赛道 {len(TAB_GROUPS)} 组: " +
      " / ".join(f"{g['name']}({'+'.join(g['match']) or '兜底'})" for g in TAB_GROUPS) +
      f"  默认={DEFAULT_TAB}")
print(f"   列表池 {len([x for x in L1_FINAL if x not in TAB_WORDS])} 词（一级池 {len(L1_FINAL)} 扣除 {len(TAB_WORDS)} 个赛道词）")
