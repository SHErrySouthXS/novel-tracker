/**
 * 平台总榜 · 今日流行总结生成器（AI 版 · 晋江 / 七猫 / 番茄女频 / 长佩）
 *
 * 用法: node scrapers/platform-summary.js <jjwxc|qimao|fanqie|changpei>
 *
 * 背景：四平台的「今日流行总结」横幅统一由此脚本生成（AI 归纳，mimo-v2.5-pro）。
 * 原 changpei-summary.js 为纯规则词典（标签词频拼接+逐书点评），2026-09-09d 起长佩也切到
 * 本 AI 管线，与晋江/七猫/番茄同一套 prompt，输出风格统一为「榜单整体归纳」。
 *
 * 内容规范（2026-09-09d 对标 analyze.js 四维"总结："逻辑）：
 *   每条必须是"整体共性结论 + 数字占比"的归纳句，禁止罗列——
 *   ✗ 错误示范：《xx》#3 穿书上位 / #4《跟踪日记》攻痛受也会痛 / 甜宠 23% · 温馨 6%…
 *   ✓ 正确示范：穿书/重生类设定占比突出（穿越19%·重生16%），上位爽感是核心情绪供给
 *   全书单最多 1 处《书名》作共性佐证；禁止逐条挂书名、禁列书单、禁单书点评。
 *
 * 输出 data/<platform>/summary.json（blocks[] 三段：🎭情感主旋律/💑热门CP人设/📊题材与结构，
 * 前端直接复用 summary-banner 版式，栏目结构与版式不变，仅 lines 文案为整体归纳）。
 *
 * 降级：无 key / 网络失败 / 解析失败 → 生成 3 区 fallback（题材结构为真实统计，
 * 情感/CP 两区给占位说明），保证前端每天都有数据不空白。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ===== LLM 配置（默认通义千问；可经 env 切换任意 OpenAI 兼容服务，如小米 MiMo Token Plan:
// LLM_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1 LLM_MODEL=mimo-v2.5-pro） =====
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.MIMO_API_KEY || process.env.QWEN_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'qwen-plus';
const LLM_API_URL = `${LLM_BASE_URL}/chat/completions`;
const IS_MIMO = /mimo/i.test(LLM_MODEL); // MiMo 用 max_completion_tokens；thinking 下 temperature/top_p 强制 1.0/0.95（无碍）

// ========== 平台配置 ==========
const PLATFORM_CONF = {
  changpei: {
    dir: path.join(__dirname, '..', 'data', 'changpei'),
    file: 'latest.json',
    name: '长佩文学',
    ranking: '畅销榜 Top100',
    note: '长佩是耽美/纯爱向原创站，频道词粗放（都市/架空/综合占大头，区分度低），真正的信号在 all_tags 情感母题与人设标签（破镜重圆/追妻火葬场/金丝雀/竹马/ABO/年下/强制爱…）与简介设定；请以 all_tags 高频母题与简介观感为准归纳',
  },
  jjwxc: {
    dir: path.join(__dirname, '..', 'data', 'jjwxc'),
    file: 'latest.json',
    name: '晋江文学城',
    ranking: '积分月榜 Top200',
    note: '晋江以女性向言情/耽美/百合为主，频道与题材标签混合（原创/爱情/近代现代/架空历史…），简介常点明人设与剧情钩子',
  },
  qimao: {
    dir: path.join(__dirname, '..', 'data', 'qimao'),
    file: 'girl_hot.json',
    name: '七猫小说·女频',
    ranking: '女频大热榜 Top20',
    note: '七猫女频大热榜每本只有一个一级题材标签（总裁豪门/宫闱宅斗等），人设/情感信息主要藏在简介里，请从简介提炼 CP 与节奏',
  },
  fanqie: {
    dir: path.join(__dirname, '..', 'data', 'fanqie'),
    file: 'latest.json',
    name: '番茄小说·女频',
    ranking: '女频最热榜 Top200',
    note: '番茄女频最热榜（书库 audience0 频道）每本含频道题材 primary_tag + 多个细分标签（all_tags，如 甜宠/马甲/穿书…），简介信息量大；请从标签与简介提炼情感节奏、CP 人设与题材结构',
  },
};

// ========== 工具 ==========
function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function pct(n, total) { return total > 0 ? Math.round(n / total * 100) : 0; }
function cx(s) { return (s || '').replace(/纯爱/g, '耽美'); }
function readJSON(fp) {
  try { return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : null; } catch { return null; }
}

// 书名归一（jjwxc 用 name，qimao 用 book_name）
const bookName = (b) => cx(b.book_name || b.name || '');
const bookTags = (b) => cx((b.all_tags || b.tags || []).join(' / ')) || '未分类';

// ========== 统计上下文 + 全榜书目素材（喂给模型） ==========
// 2026-09-09e：从「聚合统计 + Top10 画像」升级为「全榜逐本素材注入」（对标 analyze.js buildBooksBlock）——
// 情感/CP/题材的结论必须建立在读全榜每本书的 简介+全部标签 之上，而不是只靠标签词频反推。
function buildBooksBlock(books, maxAbs) {
  return books.map(b => {
    const name = bookName(b);
    const tags = bookTags(b);
    const chg = b.rank_change === 'new' ? '[新上榜]' : (typeof b.rank_change === 'number' && b.rank_change ? `[${b.rank_change > 0 ? '↑' : '↓'}${Math.abs(b.rank_change)}]` : '');
    let abs = String(b.abstract || '').replace(/\s+/g, ' ').trim();
    if (abs.length > maxAbs) abs = abs.slice(0, maxAbs) + '…';
    return `#${b.rank}《${name}》${chg} 标签:${tags} 简介:${abs || '(无简介)'}`;
  }).join('\n');
}

function buildContext(conf, data) {
  const books = data.books || [];
  const total = books.length;

  // 全量标签词频（不分级，直接统计，供模型快速对齐占比；结论仍以逐本素材为准）
  const tagFreq = {};
  for (const b of books) for (const t of (b.all_tags || b.tags || [])) tagFreq[cx(t)] = (tagFreq[cx(t)] || 0) + 1;
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([t, n]) => `${t} ${n}本(${pct(n, total)}%)`).join('、');

  // 一级分布（tag_stats / gender_stats）
  const dist = [];
  for (const key of ['tag_stats', 'gender_stats']) {
    const st = data[key] || {};
    const ent = Object.entries(st).sort((a, b) => b[1] - a[1]);
    if (ent.length) dist.push(`分布(${key}): ${ent.map(([t, n]) => `${cx(t)} ${n}本(${pct(n, total)}%)`).join('、')}`);
  }

  // 状态分布
  const status = {};
  for (const b of books) status[b.status || '未知'] = (status[b.status || '未知'] || 0) + 1;

  // 全榜逐本素材（两档：长 100 字简介 / 压缩 60 字简介；>25k 用压缩档，对标 analyze.js 教训）
  const fullBlock = buildBooksBlock(books, 100);
  const compactBlock = buildBooksBlock(books, 60);

  return {
    total,
    topTags,
    dist: dist.join('\n'),
    status: Object.entries(status).map(([s, n]) => `${s} ${n}本(${pct(n, total)}%)`).join('、'),
    fullBlock,
    compactBlock,
    fullChars: fullBlock.length,
    compactChars: compactBlock.length,
  };
}

// ========== 调用 LLM（OpenAI 兼容） ==========
function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const body = { model: LLM_MODEL, messages, temperature: 0.4 };
    if (IS_MIMO) body.max_completion_tokens = 16000; // 2026-09-09d: 8192→16000（防推理挤空正文，同 analyze.js 教训）
    else body.max_tokens = 1600;
    const payload = JSON.stringify(body);
    const url = new URL(LLM_API_URL);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.choices?.[0]?.message?.content) resolve(json.choices[0].message.content);
          else if (json.error) reject(new Error(`API Error: ${json.error.message || JSON.stringify(json.error)}`));
          else reject(new Error(`Unexpected response: ${raw.slice(0, 300)}`));
        } catch (e) { reject(new Error(`Parse error: ${e.message}, raw: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

// 从模型输出提取 JSON
function extractJSON(text) {
  let s = (text || '').trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// ========== 降级（fallback） ==========
function buildFallback(ctx, conf, data, dateStr) {
  const total = ctx.total;
  const l1 = Object.entries(data.tag_stats || {}).sort((a, b) => b[1] - a[1]);
  const st = data.books.reduce((o, x) => { o[x.status || '未知'] = (o[x.status || '未知'] || 0) + 1; return o; }, {});
  const stLine = Object.entries(st).map(([s, n]) => `${s} ${n}本(${pct(n, total)}%)`).join(' · ');
  const structureLines = [];
  if (l1.length) structureLines.push(`题材底盘：${l1.slice(0, 3).map(([t, n]) => `${cx(t)} ${pct(n, total)}%`).join(' · ')}`);
  if (stLine) structureLines.push(`状态：${stLine}`);
  if (ctx.topTags) structureLines.push(`高频标签：${ctx.topTags.split('、').slice(0, 3).join(' · ')}`);
  const blocks = [
    { id: 'emotion', title: '🎭 情感主旋律', lines: ['（今日标签未含情感维度，AI 生成后自动补充）'] },
    { id: 'cp', title: '💑 热门 CP 人设', lines: ['（今日标签未含人设维度，AI 生成后自动补充）'] },
    { id: 'structure', title: '📊 题材与结构', lines: structureLines },
  ];
  return {
    date: dateStr, platform: conf.id, platform_name: conf.name, ranking_name: conf.ranking,
    total_count: total, blocks, mode: 'fallback',
  };
}

// ========== 主流程 ==========
async function main() {
  const platformId = process.argv[2];
  const conf = PLATFORM_CONF[platformId];
  if (!conf) {
    console.error('❌ 用法: node scrapers/platform-summary.js <jjwxc|qimao|fanqie>');
    process.exit(1);
  }
  const data = readJSON(path.join(conf.dir, conf.file));
  if (!data?.books?.length) {
    console.error(`❌ ${conf.name}: ${conf.file} 无数据`);
    process.exit(1);
  }

  const now = getNowBJT();
  const today = fmtDate(now);
  const ctx = buildContext(conf, data);
  const outPath = path.join(conf.dir, 'summary.json');

  console.log('='.repeat(60));
  console.log(`${conf.name} 今日流行总结 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));
  console.log(`  ${conf.ranking}: ${ctx.total} 本`);

  // ---- AI 路径 ----
  if (LLM_API_KEY) {
    // 全榜素材选档：>25k chars 用压缩简介档（60字/本），否则全长 100字/本（对标 analyze.js 防上下文超限教训）
    ctx.booksBlock = ctx.fullChars > 25000 ? ctx.compactBlock : ctx.fullBlock;
    console.log(`  素材: 全榜 ${ctx.total} 本逐本注入（${Math.round((ctx.booksBlock.length)/1000)}k chars，${ctx.fullChars > 25000 ? '压缩档60字/本' : '全长档100字/本'}）`);
    const systemPrompt = `你是网文榜单分析师。请针对「${conf.name}」${conf.ranking}今日榜单，写"今日流行总结"。
背景：${conf.note}

要求输出三段式总结（与长佩总榜看板同款结构），仅输出合法 JSON，不要 markdown 代码块：
{
  "blocks": [
    { "id": "emotion", "title": "🎭 情感主旋律", "lines": ["2-4条整体归纳：今日榜单的情感基调/叙事节奏主流（甜/虐/拉扯/爽感…），先共性结论后占比"] },
    { "id": "cp", "title": "💑 热门 CP 人设", "lines": ["2-4条整体归纳：流行的人物关系/人设组合模式，先共性结论后占比"] },
    { "id": "structure", "title": "📊 题材与结构", "lines": ["2-3条整体归纳：题材底盘+连载/完结结构信号"] }
  ]
}
行格式硬性要求（对标榜单整体总结，严禁罗列）：
1. 每条是「整体共性结论 + 数字/占比佐证」的归纳句（如"穿书重生设定活跃：穿越19%·重生16%构成上位爽感主力"），读起来像人写的总结而非标签清单。
2. 全书单只允许出现 1 处《书名》作共性佐证（证明该共性的头部代表，格式《书名》#排名）；禁止每条都挂书名、禁止列 2 本以上书单、禁止写成单书点评（如"《xx》#3穿书上位"这类逐书陈列必须改写为整体结论）。
3. 数字占比必须来自对【全榜书目逐本素材】的统计或我给出的标签统计——两处口径不一致时以逐本素材为准；禁止编造素材里不存在的数字/标签/书名。
4. 标签用词与我提供的统计一致（禁用「纯爱」，一律用「耽美」）。
5. 三个维度都要给；每条 1-2 句、≤80 字；某维度信息薄弱时给 1-2 条基于全榜简介观感的印象式整体结论，不要硬凑书名。`;
    const userPrompt = `【${conf.name} · ${conf.ranking} · ${today}】
总本数: ${ctx.total}

【全榜书目逐本素材】（以下为榜单全部 ${ctx.total} 本，每本含 排名/全部标签/简介——请通读后综合归纳，勿只盯头部）
${ctx.booksBlock}

【标签与状态统计】（辅助对齐占比口径；若与逐本素材有出入，以逐本素材为准）
标签词频: ${ctx.topTags}
${ctx.dist}
状态: ${ctx.status}

请基于全榜素材生成三段式流行总结 JSON。`;

    try {
      console.log(`🤖 正在调用 LLM(${LLM_MODEL}) 生成...`);
      const text = await callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      let blocks;
      try {
        blocks = extractJSON(text).blocks;
      } catch (e) {
        throw new Error(`JSON 解析失败: ${e.message} | 原文前120字: ${(text || '').slice(0, 120)}`);
      }
      if (!Array.isArray(blocks) || !blocks.length) throw new Error('模型未返回 blocks');
      const cleaned = blocks.map(b => ({
        id: String(b.id || '').trim(),
        title: cx(String(b.title || '').trim()),
        lines: (Array.isArray(b.lines) ? b.lines : []).map(cx).map(s => String(s).trim()).filter(s => s && s.length > 1 && s.length <= 90).slice(0, 6),
      })).filter(b => b.title && b.lines.length);
      if (!cleaned.length) throw new Error('清洗后无有效 block');

      const summary = {
        date: today,
        generated_at: fmtDateTime(now),
        platform: platformId,
        platform_name: conf.name,
        ranking_name: conf.ranking,
        total_count: ctx.total,
        blocks: cleaned,
        mode: 'ai',
        model: LLM_MODEL,
      };
      fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
      console.log(`  ✓ AI 生成完成: ${outPath}`);
      for (const b of cleaned) {
        console.log(`\n${b.title}`);
        for (const l of b.lines) console.log(`  - ${l}`);
      }
      return;
    } catch (e) {
      console.error(`❌ AI 失败: ${e.message}`);
      console.log('  降级为 fallback...');
    }
  } else {
    console.warn('⚠️ 未设置 LLM_API_KEY（或 MIMO_API_KEY / QWEN_API_KEY），走 fallback（仅为结构占位，AI 版将在 daily-scrape 中生成）');
  }

  const fb = buildFallback(ctx, { id: platformId, name: conf.name, ranking: conf.ranking }, data, today);
  fs.writeFileSync(outPath, JSON.stringify(fb, null, 2), 'utf-8');
  console.log(`  ✓ fallback 已保存: ${outPath} (mode=fallback)`);
  for (const b of fb.blocks) {
    console.log(`\n${b.title}`);
    for (const l of b.lines) console.log(`  - ${l}`);
  }
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
