/**
 * 长佩总榜 · 今日流行总结生成器（纯规则引擎，离线，无 API 依赖）
 *
 * 读取 data/changpei/latest.json（总榜·畅销榜 Top200），按三个维度生成流行总结：
 *   🎭 情感主旋律  —— 情感/节奏类二级标签（甜向/虐向/拉扯/强制/轻松/基调）
 *   💑 热门 CP 人设 —— 关系/人设类二级标签（年龄结构/体质模式/设定/职业 + 头部高记忆人设佐证）
 *   📊 题材与结构  —— 一级题材分类 + 连载 vs 完结 的结构差异
 *
 * 行格式：标签名 + 占比（Pct%），部分行以《书名》#排名 作证据。
 * 标签→维度 归类由下方词典驱动，可随平台标签体系持续扩充。
 * 输出：data/changpei/summary.json（blocks[]，每 block 有 title + lines[]）
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'changpei', 'latest.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'changpei', 'summary.json');

function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function pct(n, total) { return Math.round(n / total * 100); }

// ========== 标签 → 维度 词典（可扩充） ==========
// emotion：子组名 → 标签集合（一个标签只归一处；未收录的含攻/受标签进 cp，其余忽略）
const EMOTION_GROUPS = [
  { key: '甜向', tags: ['甜宠', '甜宠互宠', '温馨', '宠溺', '治愈'] },
  { key: '虐向', tags: ['狗血', '虐恋', '恨海情天'] },
  { key: '拉扯', tags: ['破镜重圆', '追妻', '追妻火葬场', '替身', '酸涩', '酸甜', '暗恋', '双向暗恋', '相爱相杀'] },
  { key: '强制', tags: ['强制爱'] },
  { key: '轻松', tags: ['轻松', '搞笑', '沙雕', '爽文'] },
];
const BASE_TAGS = ['HE']; // 基调类单列，不参与上表
const CP_GROUPS = [
  { key: '年龄结构', tags: ['年上', '年下', '年龄差'] },
  { key: '体质模式', tags: ['强强', '弱攻强受', '体型差', '肤色差'] },
  { key: '设定', tags: ['ABO', '竹马竹马', '直掰弯', '青梅', '变猫', '包养出真爱', '金丝雀', '兽人'] },
  { key: '职业身份', tags: ['娱乐圈', '职业', '豪门', '市井生活'] },
];
// 高记忆点人设标签（组合式"xx攻/xx受"）→ 用于书名佐证行
const HEADLINE_PAIR_HINTS = ['攻', '受', '养成', '直球'];

// ========== 统计工具 ==========
function freqOf(books, excludeSet) {
  const freq = {};
  for (const b of books) {
    for (const t of (b.all_tags || [])) {
      if (excludeSet && excludeSet.has(t)) continue; // 排除一级题材分类，只留二级标签
      freq[t] = (freq[t] || 0) + 1;
    }
  }
  return freq;
}
const tagIn = (tag, tagList) => tagList.includes(tag);

// ========== 主逻辑 ==========
function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ 找不到 ${DATA_FILE}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const books = data.books || [];
  if (!books.length) {
    console.error('❌ latest.json 无书籍数据');
    process.exit(1);
  }
  const total = books.length;
  const now = getNowBJT();

  // 一级题材分类（来自 tag_stats）
  const level1 = new Set(Object.keys(data.tag_stats || {}));

  // 二级标签词频（排除一级分类）
  const dimFreq = freqOf(books, level1);

  // —— 分组统计 ——
  const countInGroup = (tagList) => tagList.reduce((s, t) => s + (dimFreq[t] || 0), 0);
  const fmtGroup = (tagList) => tagList.filter(t => dimFreq[t]).map(t => `${t} ${pct(dimFreq[t], total)}%`).join(' · ');

  // ===== 🎭 情感主旋律 =====
  const emotionLines = [];
  for (const g of EMOTION_GROUPS) {
    const c = countInGroup(g.tags);
    if (c === 0) continue;
    const shown = fmtGroup(g.tags);
    const note =
      g.key === '甜向' && countInGroup(['狗血', '虐恋']) > 0 && c >= countInGroup(['狗血', '虐恋']) ? '甜虐并立，甜为主味'
      : g.key === '甜向' ? '甜味基底'
      : g.key === '虐向' ? '强冲突供给'
      : g.key === '拉扯' ? '复合拉扯叙事主流'
      : g.key === '强制' ? '强制爱风格存在感'
      : g.key === '轻松' ? '轻松调剂并行'
      : '';
    emotionLines.push(note ? `${shown}（${note}）` : shown);
  }
  const heCount = countInGroup(BASE_TAGS);
  if (heCount > 0) emotionLines.push(`HE ${pct(heCount, total)}%（完结底线承诺）`);

  // ===== 💑 热门 CP 人设 =====
  const cpLines = [];
  for (const g of CP_GROUPS) {
    const c = countInGroup(g.tags);
    if (c === 0) continue;
    const shown = fmtGroup(g.tags);
    const note =
      g.key === '年龄结构' && (dimFreq['年上'] || 0) >= (dimFreq['年下'] || 0) * 2 ? '年上主导'
      : g.key === '年龄结构' ? '年上略占优'
      : g.key === '体质模式' ? '势均力敌向'
      : g.key === '设定' ? '世界观设定向'
      : g.key === '职业身份' ? '现实感甜剧设定'
      : '';
    cpLines.push(note ? `${shown}（${note}）` : shown);
  }
  // 书名佐证行：头部书中带"xx攻/xx受"等高记忆人设标签的，取 rank 最前 2 本
  const evidenceBooks = books
    .filter(b => (b.all_tags || []).some(t => HEADLINE_PAIR_HINTS.some(h => t.includes(h)) && t.length > 2))
    .slice(0, 2);
  for (const b of evidenceBooks) {
    const t = b.all_tags || [];
    // 先找纯攻/纯受标签（排除"xx攻xx受"混写组合标签），避免同一标签同时命中攻/受槽位造成"XX × XX"重复
    const gong = t.find(x => x.includes('攻') && !x.includes('受'));
    const shou = t.find(x => x.includes('受') && !x.includes('攻'));
    // 攻或受单边缺失时，用同时含攻受的组合标签（如"攻痛受也会痛"）兜底展示一次
    const combo = !gong || !shou ? t.find(x => x.includes('攻') && x.includes('受')) : null;
    const pair = gong && shou ? `${gong} × ${shou}` : combo || gong || shou || t.slice(0, 3).join(' / ');
    cpLines.push(`#${b.rank}《${b.book_name}》：${pair}`);
  }

  // ===== 📊 题材与结构 =====
  const structureLines = [];
  const l1 = Object.entries(data.tag_stats || {}).sort((a, b) => b[1] - a[1]);
  if (l1.length) {
    structureLines.push(`题材底盘：${l1.slice(0, 3).map(([t, n]) => `${t} ${pct(n, total)}%`).join(' · ')}`);
  }
  const fin = books.filter(b => b.status === '完结');
  const ser = books.filter(b => b.status === '连载中');
  if (fin.length && ser.length) {
    const finFreq = freqOf(fin, level1);
    const serFreq = freqOf(ser, level1);
    const topOf = (f, base) => Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} ${pct(n, base)}%`).join(' · ');
    structureLines.push(`完结回榜（${fin.length} 本 / ${pct(fin.length, total)}%）：${topOf(finFreq, fin.length)}`);
    structureLines.push(`连载冲榜（${ser.length} 本 / ${pct(ser.length, total)}%）：${topOf(serFreq, ser.length)}`);
  } else {
    structureLines.push(`连载 ${ser.length} 本 vs 完结 ${fin.length} 本`);
  }

  const blocks = [
    { id: 'emotion', title: '🎭 情感主旋律', lines: emotionLines },
    { id: 'cp', title: '💑 热门 CP 人设', lines: cpLines },
    { id: 'structure', title: '📊 题材与结构', lines: structureLines },
  ];

  const summary = {
    date: fmtDate(now),
    generated_at: fmtDateTime(now),
    platform: 'changpei',
    ranking_name: data.ranking_name || '总榜·畅销榜',
    total_count: total,
    blocks,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2), 'utf-8');

  console.log('='.repeat(60));
  console.log(`长佩总榜流行总结 - ${summary.generated_at}`);
  console.log('='.repeat(60));
  for (const b of blocks) {
    console.log(`\n${b.title}`);
    for (const l of b.lines) console.log(`  - ${l}`);
  }
  console.log(`\n✅ 已保存: ${OUT_FILE}`);
}

main();
