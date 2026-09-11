/**
 * 每日 AI 智能分析模块
 * 
 * 在四个爬虫跑完后执行，读取四站（晋江/长佩/番茄/七猫）最新数据，
 * 调用 LLM API 生成深度分析，保存为 analysis.json 供前端概览展示。
 * 
 * 2026-09-09a: 平台清单 fanqie/qidian/jjwxc → jjwxc/changpei/fanqie/qimao
 *   （对齐前端 4 tab；起点 qidian 已无前端展示/无爬虫，停止为其烧 token）
 * 2026-09-09b: 输出从「headline+analysis 自由文本」改为「四维题材总结」：
 *   - 素材注入：逐本注入 书名+频道+全部标签+简介截断（模型自统计共性，绕开 tag_stats 脏标签，
 *     如番茄"未知54%"、长佩频道词都市/架空/综合占79% 等标签失真问题）
 *   - 每平台一次 LLM 调用（避免 4 平台全量素材超上下文窗口），最后再 1 次跨平台总结
 *   - platforms.<id> schema:
 *       headline      一句话总结今日该平台题材主旋律（不加评价性判断）
 *       theme         "总结：…" 题材/设定系共性
 *       conflict      "总结：…" 情节冲突共性
 *       characters    "总结：…" 人设共性
 *       cp            "总结：…" CP 关系结构共性
 *       new_entrants  "总结：…" 今日新上榜共性
 *       rising        "总结：…" 快速上升共性
 *   - 规则：只做基于全榜数据的客观归纳总结（总结：…），禁止写判断/预测/建议/引流话术
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== LLM 配置 ==========
// 默认走通义千问（DashScope OpenAI 兼容端点）；可通过 env 切换任意 OpenAI 兼容服务，
// 如小米 MiMo Token Plan: LLM_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1 LLM_MODEL=mimo-v2.5-pro
const DATA_DIR = path.join(__dirname, '..', 'data');
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.MIMO_API_KEY || process.env.QWEN_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'qwen-plus';
const LLM_API_URL = `${LLM_BASE_URL}/chat/completions`;
const IS_MIMO = /mimo/i.test(LLM_MODEL); // MiMo 用 max_completion_tokens；thinking 下 temperature/top_p 会被其强制覆盖为 1.0/0.95（无碍）

// ========== 工具函数 ==========
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

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch(e) {}
  return null;
}

function extractJSON(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();
  // 若模型前后夹了说明文字，截取首个 { 到最后一个 }
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  return JSON.parse(cleaned);
}

// ========== 调用 LLM API ==========
function callLLM(messages, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    const body = { model: LLM_MODEL, messages, temperature: 0.7 };
    // MiMo 兼容 OpenAI 新字段（含 reasoning tokens 预算，给足防正文被挤占）
    // 2026-09-09c: 8192 → 16000。晋江 36k 素材实测 reasoning 可吃掉上万 token，
    //   8192 预算下 finish_reason=length 且 content=""（正文被推理挤空 → 走降级模板）
    if (IS_MIMO) body.max_completion_tokens = 16000;
    else body.max_tokens = maxTokens;
    const payload = JSON.stringify(body);

    const url = new URL(LLM_API_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 90000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices?.[0]?.message?.content) {
            resolve(json.choices[0].message.content);
          } else if (json.error) {
            reject(new Error(`API Error: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            reject(new Error(`Unexpected response: ${data.slice(0, 500)}`));
          }
        } catch(e) {
          reject(new Error(`Parse error: ${e.message}, raw: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

// ========== 平台定义 ==========
const PLATFORMS = [
  { id: 'jjwxc',    name: '晋江文学城', file: 'latest.json' },
  { id: 'changpei', name: '长佩文学',   file: 'latest.json' },
  { id: 'fanqie',   name: '番茄小说',   file: 'latest.json' },
  { id: 'qimao',    name: '七猫小说',   file: 'pool.json' },
];
const PNAME = Object.fromEntries(PLATFORMS.map(p => [p.id, p.name]));

// 各平台画像（供 system prompt 使用，帮助模型理解榜单口径与平台气质）
const PLATFORM_PROFILE = {
  jjwxc: '女性向原创文学社区，纯爱(BL)与言情为主力，IP 改编价值高，用户年轻女性为主。榜单为积分月榜 Top200，书带频道(channel)、性向(nature)、genre/era/theme 与自由标签(secondary_tags/all_tags)。',
  changpei: '耽美/纯爱向原创站，榜单为畅销榜 Top100。频道词粗放（都市/架空/综合/青春/宫廷…），真正内容差异在 all_tags 人设/情感母题标签（破镜重圆、金丝雀、ABO、年下、强制爱…）与简介设定。',
  fanqie: '字节旗下免费阅读平台，女频最热榜 Top160。primary_tag 常混入自由标签或为"未知"，题材须读简介(abstract)与 all_tags 判断，勿依赖主分类统计。',
  qimao: '免费阅读平台，榜单为女频 8 榜（大热/新书/完结/收藏/更新 × 日/月）去重池约 100 本。书带官方两级：channel 大类（现代言情/古代言情/幻想言情）+ category 细分（总裁豪门/宫闱宅斗/年代重生…），每书各单值；无自由标签字段，人设/情感信息主要在简介里。',
};

// 四维框架说明（system prompt 公共段）
const DIMENSION_GUIDE = `请基于「全部上榜书目」统计共性，按四个维度输出总结（每个维度以"总结："开头，先给共性结论与命中书目数/占比，可举 1 个代表性作品名佐证，但结论必须来自全榜统计而非个别书）：
- 题材：频道/大类分布 + 有存在感的设定系（如 ABO、娱乐圈、武侠、玄幻等）；若某平台大类本身无区分度，请点明并把重心放到简介里识别出的设定系。
- 情节冲突：故事核心冲突类型归纳——区分"关系内部冲突"（破镜重圆/追妻火葬场/暗恋/强制爱/误会分手…）与"外部事件冲突"（权谋夺权/升级打怪/悬疑破案/系统任务…），统计各自占比。
- 人设：全榜高频人设标签/身份/性格组合归纳（如金丝雀×大佬、毒舌×炸毛、疯批×温柔、少爷×乡下人…），指出常见的人物配置模式。
- CP：情感关系结构统计（强强/年上/年下/养成/竹马/破镜重圆/先婚后爱/直掰弯…），以及 HE/Be 倾向、攻受互动模式。

【新上榜与快速上升子样本归纳】——这两个字段必须与上面四维同框架、归纳型总结，禁止列书单：
- 新上榜（new_entrants）：仅以输入中带 [新上榜] 标记的书目为子样本，按四维（题材/情节冲突/人设/CP）统计共性，给出命中书数/占比与代表性题材母题/设定系/关系结构，最多佐证 1 个代表书名（仅作为共性的支撑，禁止列 3 本以上书名单）。无新上榜请写"总结：今日无新上榜"。
- 快速上升（rising）：仅以输入中带 [↑N] 标记且 N≥10 的书目为子样本（下降的书 [↓N] 不属于此字段），同样按四维统计共性，给出命中书数/占比与代表性题材母题，最多佐证 1 个代表书名。无明显上升请写"总结：今日无明显快速上升"。

硬性要求：
1. 只写客观归纳总结，用"总结：…"句式；禁止写判断、预测、建议、引流话术（不要出现"说明平台XX""值得关注""或将持续""建议"等）。
2. 数字必须来自输入的书目清单（自己逐本数），禁止编造。
3. 个别书名只作共性佐证出现一次（最多 1 个），禁止写成单书点评或书单——new_entrants / rising 字段尤其禁止列 3 本以上书名单。
4. headline：用一句话客观总结今日该平台题材主旋律（同样不加评价性判断）。
5. 全部字段为中文，字段值为纯文本字符串（可含标点）。`;

// ========== 构建逐本素材（书名+频道+标签+简介截断） ==========
// 2026-09-09f：简介源升级为完整版（番茄 SSR 完整简介 200-600 字），全长档 140→200、压缩档 60→90，
// 让完整简介的设定/人设/冲突信息更多进入模型（仍防单平台输入过大触发推理挤空输出的坑）
function buildBooksBlock(data, maxIntro = 200) {
  if (!data?.books?.length) return '（无数据）';
  const lines = [];
  for (const b of data.books) {
    const name = b.book_name || '佚名';
    const cat = b.channel || b.primary_tag || b.category || '';
    let intro = String(b.abstract || '').replace(/\s+/g, ' ').trim();
    if (intro.length > maxIntro) intro = intro.slice(0, maxIntro) + '…';
    const tags = [
      ...(b.all_tags || []), ...(b.secondary_tags || []), ...(b.tags || []),
      ...(b.gender ? [b.gender] : []),
    ].filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 12).join('、');
    const chg = b.rank_change === 'new' ? '[新上榜]'
      : (typeof b.rank_change === 'number' && b.rank_change > 0 ? `[↑${b.rank_change}]`
      : (typeof b.rank_change === 'number' && b.rank_change < 0 ? `[↓${Math.abs(b.rank_change)}]` : ''));
    lines.push(`#${b.rank}《${name}》${cat ? `(${cat})` : ''}${chg} 标签:${tags || '-'} 简介:${intro}`);
  }
  return lines.join('\n');
}

// 平台级 system prompt
function platformSystemPrompt(p) {
  return `你是一位资深网络文学题材分析师。你正在分析${PNAME[p.id]}的今日榜单，需要基于榜单里「每一本书」的素材做四维题材共性总结。

【平台背景】${PLATFORM_PROFILE[p.id]}

【今日榜单口径】${p.id === 'qimao' ? '榜单为女频 8 榜去重池（约 100 本），题材(大类)维只有现代/古代/幻想言情三档、区分度低，请把判断重心放到情节冲突/人设/CP 三维，题材维注明大类与官方细分（总裁豪门/宫闱宅斗…）分布即可。' : '榜单为完整 Top 榜（每本都列出），请全部纳入统计。'}

【输出要求】${DIMENSION_GUIDE}

【重要：直接给结果，不要输出推理过程】禁止输出任何思考过程、推理草稿、中间统计或解释说明文字（如"首先/步骤1/我统计了…"）——你的输出必须且只能是那一个合法 JSON 对象本身，正文直接在 content 中返回，不要在 reasoning 中反复枚举每本书。

输出必须是合法 JSON（不要 markdown 代码块标记），结构如下：
{
  "headline": "一句话主旋律总结",
  "theme": "总结：…",
  "conflict": "总结：…",
  "characters": "总结：…",
  "cp": "总结：…",
  "new_entrants": "总结：按四维框架归纳今日新上榜子样本的共性（题材/情节冲突/人设/CP），含命中书数/占比，最多佐证 1 个代表书名，禁止列书单",
  "rising": "总结：按四维框架归纳今日快速上升子样本的共性（题材/情节冲突/人设/CP），含命中书数/占比，最多佐证 1 个代表书名，禁止列书单"
}`;
}

// 跨平台总结 system prompt
const CROSS_SYSTEM_PROMPT = `你是一位资深网络文学题材分析师。以下是今日四个平台（晋江文学城/长佩文学/番茄小说/七猫小说）各自的 AI 四维题材总结。请横向对比后输出 JSON：
{
  "overall_summary": "总结：四平台题材整体图景的总括（150字内，纯归纳）",
  "cross_platform_insights": "总结：四平台在题材/冲突/人设/CP 维度的相同点与差异点（200字内，纯归纳，禁止判断与预测）",
  "notable_signals": ["今日值得记录的题材现象1（客观描述）", "…", "…"]
}
硬性要求：全部为客观归纳总结，禁止"说明/值得关注/或将"等判断预测语；notable_signals 每条只描述现象本身。输出合法 JSON。`;

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`AI 智能分析模块 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  if (!LLM_API_KEY) {
    console.error('❌ 未设置 LLM_API_KEY（或 MIMO_API_KEY / QWEN_API_KEY）环境变量');
    process.exit(1);
  }

  const today = fmtDate(now);

  // 读取四站数据
  const allData = {};
  for (const p of PLATFORMS) {
    allData[p.id] = readJSON(path.join(DATA_DIR, p.id, p.file));
    console.log(`  ${p.name}: ${allData[p.id]?.books?.length || 0} 本`);
  }

  const result = {
    date: today,
    overall_summary: '',
    platforms: {},
    cross_platform_insights: '',
    notable_signals: [],
  };

  // === 逐平台调用（每平台一次，素材=逐本全量） ===
  for (const p of PLATFORMS) {
    const data = allData[p.id];
    if (!data?.books?.length) {
      console.log(`  ⚠️ ${p.name} 无数据，跳过`);
      continue;
    }
    // 素材两级备选：全长（200字简介）→ 超长或失败时压缩（90字简介）
    // 2026-09-09c: 晋江 200 本全量素材 36k chars，mimo-v2.5-pro 推理过重会 length 截断正文为空。
    //   超过 25k 直接首轮就用压缩素材；全长失败时再自动降级压缩素材重试 1 次。
    const fullBlock = buildBooksBlock(data);
    const compactBlock = buildBooksBlock(data, 90);
    let candidates = fullBlock.length > 25000
      ? [{ label: `压缩素材(${Math.round(compactBlock.length/1000)}k)`, block: compactBlock }]
      : [{ label: `全长素材(${Math.round(fullBlock.length/1000)}k)`, block: fullBlock },
         { label: `压缩素材(${Math.round(compactBlock.length/1000)}k)`, block: compactBlock }];

    console.log(`\n🤖 分析 ${PNAME[p.id]} (素材 ${Math.round(fullBlock.length/1000)}k chars)...`);
    let attemptMsg = '';
    for (let ai = 0; ai < candidates.length; ai++) {
      const cand = candidates[ai];
      if (candidates.length > 1) console.log(`   尝试 ${ai+1}/${candidates.length}: ${cand.label}`);
      const userPrompt = `以下是${PNAME[p.id]}今日榜单 ${data.books.length} 本书的完整素材（排名/频道/涨跌/标签/简介）：\n\n${cand.block}\n\n请按四维框架逐本统计共性，输出 JSON。`;
      try {
        const response = await callLLM([
          { role: 'system', content: platformSystemPrompt(p) },
          { role: 'user', content: userPrompt },
        ], 4000);
        let parsed;
        try {
          parsed = extractJSON(response);
        } catch(e) {
          // 兼容模型直接输出字段对象（未套 platforms）
          parsed = { platforms: {} };
        }
        // 平台对象可能在 parsed.platforms[p.id]，也可能模型直接给了字段对象
        const pf = (parsed.platforms && typeof parsed.platforms === 'object' && parsed.platforms[p.id] && typeof parsed.platforms[p.id] === 'object')
          ? parsed.platforms[p.id] : parsed;
        result.platforms[p.id] = {
          headline: String(pf.headline || '').trim(),
          theme: String(pf.theme || '').trim(),
          conflict: String(pf.conflict || '').trim(),
          characters: String(pf.characters || '').trim(),
          cp: String(pf.cp || '').trim(),
          new_entrants: String(pf.new_entrants || '').trim(),
          rising: String(pf.rising || '').trim(),
        };
        console.log(`  ✓ ${p.name} 完成 (headline: ${result.platforms[p.id].headline.slice(0, 50)})`);
        attemptMsg = '';
        break;
      } catch(e) {
        attemptMsg = e.message;
        console.warn(`  [WARN] ${p.name} ${cand.label} 尝试失败: ${e.message.slice(0, 120)}`);
      }
    }
    if (!result.platforms[p.id]) {
      result.platforms[p.id] = fallbackPlatform(p.id, data);
      console.log(`  → ${p.name} 降级为规则模板（${String(attemptMsg).slice(0, 100)}）`);
    }
  }

  // === 跨平台总结（一次调用，喂四平台浓缩文本） ===
  const okIds = Object.keys(result.platforms);
  const crossInput = okIds.map(id => {
    const pf = result.platforms[id];
    const parts = [pf.headline, pf.theme, pf.conflict, pf.characters, pf.cp]
      .filter(s => s).join(' | ');
    return `【${PNAME[id]}】${(parts || '（无 AI 内容）').slice(0, 650)}`;
  }).join('\n\n');

  if (okIds.length >= 2 && crossInput) {
    console.log('\n🤖 生成跨平台总结...');
    try {
      const response = await callLLM([
        { role: 'system', content: CROSS_SYSTEM_PROMPT },
        { role: 'user', content: `以下是今日四平台各自的题材四维总结：\n\n${crossInput}\n\n请横向对比输出 JSON。` },
      ], 2500);
      const parsed = extractJSON(response);
      result.overall_summary = String(parsed.overall_summary || '').trim();
      result.cross_platform_insights = String(parsed.cross_platform_insights || '').trim();
      result.notable_signals = Array.isArray(parsed.notable_signals)
        ? parsed.notable_signals.map(s => String(s)).filter(Boolean).slice(0, 5) : [];
      console.log('  ✓ 跨平台总结完成');
    } catch(e) {
      console.warn(`  [WARN] 跨平台总结失败: ${e.message}`);
      result.overall_summary = okIds.map(id => `${PNAME[id]}：${String(result.platforms[id].headline || '').slice(0, 60)}`).join('；');
      result.cross_platform_insights = '总结：跨平台 AI 总结暂不可用，以上为各平台 headline 摘要。';
    }
  }

  // === 元信息与保存 ===
  result.generated_at = fmtDateTime(now);
  result.model = LLM_MODEL;

  const analysisPath = path.join(DATA_DIR, 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(result, null, 2), 'utf-8');

  const histDir = path.join(DATA_DIR, 'analysis_history');
  if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify(result, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log('🎉 分析完成！');
  console.log(`  文件: ${analysisPath}`);
  console.log(`  平台覆盖: ${okIds.length}/4`);
  if (result.overall_summary) console.log(`\n📋 总览: ${result.overall_summary}`);
  if (result.notable_signals?.length) {
    console.log(`\n🔔 现象:`);
    result.notable_signals.forEach((s, i) => console.log(`  ${i+1}. ${s}`));
  }
}

// ========== 单平台降级模板（AI 失败时使用；保留 headline+analysis 旧结构由前端兼容渲染） ==========
function fallbackPlatform(pid, data) {
  const tags = Object.entries(data.tag_stats || {}).sort((a, b) => b[1] - a[1]);
  const newBooks = data.books.filter(b => b.rank_change === 'new');
  const rising = data.books.filter(b => typeof b.rank_change === 'number' && b.rank_change > 15)
    .sort((a, b) => b.rank_change - a.rank_change).slice(0, 3);
  const topTag = tags[0]?.[0] || '未分类';
  const topPct = tags[0] ? Math.round(tags[0][1] / data.books.length * 100) : 0;
  return {
    headline: `总结：${topTag}标签出现 ${tags[0]?.[1] || 0} 本（${topPct}%）居首，今日新上榜 ${newBooks.length} 本`,
    analysis: `${PNAME[pid]}今日榜单共 ${data.books.length} 本；标签方面，${tags.slice(0, 3).map(([t, c]) => `「${t}」${c}本`).join('、')}位列前三。${newBooks.length > 0 ? `新上榜${newBooks.length}部：${newBooks.slice(0, 5).map(b => `《${b.book_name}》`).join('、')}。` : '今日无新上榜变动。'}${rising.length ? `上升较快：${rising.map(b => `《${b.book_name}》↑${b.rank_change}`).join('、')}。` : ''}`,
  };
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
