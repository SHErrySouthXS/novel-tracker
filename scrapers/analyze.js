/**
 * 每日 AI 智能分析模块
 * 
 * 在四个爬虫跑完后执行，读取四站（晋江/长佩/番茄/七猫）最新数据，
 * 调用 LLM API 生成深度分析，保存为 analysis.json 供前端概览展示
 * （各站内容特点 = platforms.<id>.headline + analysis）
 * 
 * 2026-09-09: 平台清单 fanqie/qidian/jjwxc → jjwxc/changpei/fanqie/qimao
 * （对齐前端 4 tab；起点 qidian 已无前端展示/无爬虫，停止为其烧 token）
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

// ========== 调用通义千问 API ==========
function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const body = { model: LLM_MODEL, messages, temperature: 0.7 };
    // MiMo 兼容 OpenAI 新字段（含 reasoning tokens 预算，给足防正文被挤占）
    if (IS_MIMO) body.max_completion_tokens = 8192; // thinking 可能消耗数千 tokens，预算不足会 length 截断正文为空
    else body.max_tokens = 2000;
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
      timeout: 60000,
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

// ========== 构建数据摘要（控制 token 量） ==========
function buildDataSummary(platformName, data) {
  if (!data?.books?.length) return `${platformName}: 暂无数据`;
  
  const books = data.books;
  const tagStats = data.tag_stats || {};
  const genderStats = data.gender_stats || {};
  // 部分平台（长佩/七猫）无 gender_stats 顶层字段 → 用书的 channel（大类）字段兜底聚合
  const chanStats = {};
  for (const b of books) {
    const ch = (b.channel || '').trim();
    if (ch) chanStats[ch] = (chanStats[ch] || 0) + 1;
  }
  
  const sortedTags = Object.entries(tagStats).sort((a, b) => b[1] - a[1]);
  const sortedGenders = Object.entries(genderStats).sort((a, b) => b[1] - a[1]);
  const sortedChans = Object.entries(chanStats).sort((a, b) => b[1] - a[1]);
  const newBooks = books.filter(b => b.rank_change === 'new');
  const risingBooks = books.filter(b => typeof b.rank_change === 'number' && b.rank_change > 3);
  const fallingBooks = books.filter(b => typeof b.rank_change === 'number' && b.rank_change < -3);
  
  let summary = `【${platformName}】(来源: ${data.source})\n`;
  summary += `总计: ${books.length}本\n`;
  const genderLine = sortedGenders.length > 0
    ? sortedGenders.map(([g, c]) => `${g}${c}本(${Math.round(c/books.length*100)}%)`).join('、')
    : sortedChans.map(([g, c]) => `${g}${c}本(${Math.round(c/books.length*100)}%)`).join('、');
  if (genderLine) summary += `频道/大类分布: ${genderLine}\n`;
  summary += `题材分布(Top8): ${sortedTags.slice(0, 8).map(([t, c]) => `${t}${c}本`).join('、')}\n`;
  
  // Top5 书目
  summary += `Top5: ${books.slice(0, 5).map(b => `《${b.book_name}》(${b.primary_tag || '未分类'}, ${b.author})`).join('、')}\n`;
  
  // 新上榜
  if (newBooks.length > 0) {
    summary += `新上榜(${newBooks.length}本): ${newBooks.slice(0, 8).map(b => `《${b.book_name}》#${b.rank}(${b.primary_tag || ''})`).join('、')}\n`;
  } else {
    summary += `新上榜: 无（或首次运行）\n`;
  }
  
  // 涨跌幅
  if (risingBooks.length > 0) {
    summary += `涨幅较大: ${risingBooks.slice(0, 5).map(b => `《${b.book_name}》↑${b.rank_change}`).join('、')}\n`;
  }
  if (fallingBooks.length > 0) {
    summary += `跌幅较大: ${fallingBooks.slice(0, 5).map(b => `《${b.book_name}》↓${Math.abs(b.rank_change)}`).join('、')}\n`;
  }
  
  // 连载/完结分布
  const statusCounts = {};
  books.forEach(b => { statusCounts[b.status || '未知'] = (statusCounts[b.status || '未知'] || 0) + 1; });
  summary += `状态: ${Object.entries(statusCounts).map(([s, c]) => `${s}${c}本`).join('、')}\n`;
  
  return summary;
}

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

  // 读取四站数据（与前端概览 PLATFORMS 对齐）
  const platforms = [
    { id: 'jjwxc',   name: '晋江文学城', file: 'latest.json' },
    { id: 'changpei', name: '长佩文学',   file: 'latest.json' },
    { id: 'fanqie',  name: '番茄小说',   file: 'latest.json' },
    { id: 'qimao',   name: '七猫小说',   file: 'girl_hot.json' },
  ];

  const allData = {};
  const summaries = [];

  for (const p of platforms) {
    const data = readJSON(path.join(DATA_DIR, p.id, p.file));
    allData[p.id] = data;
    summaries.push(buildDataSummary(p.name, data));
    console.log(`  ${p.name}: ${data?.books?.length || 0} 本`);
  }

  // 构建 Prompt
  const today = fmtDate(now);
  const dataBlock = summaries.join('\n\n');

  const systemPrompt = `你是一位资深的网络文学行业分析师，对中国网文市场有深入了解。你熟悉晋江文学城、长佩文学、番茄小说、七猫小说四大平台的定位和用户画像差异：

- **晋江文学城**：女性向原创文学社区，以纯爱(BL)、言情为主力品类，IP改编价值极高，用户以年轻女性为主，社区氛围浓厚。榜单是积分月榜（Top200）。
- **长佩文学**：偏耽美向原创文学网站，标签体系为 15 个频道词（都市/架空/综合/青春/宫廷…）+ 大量人设/情感母题标签（竹马竹马、甜宠、破镜重圆…），用户偏好情感浓度高、人设鲜明的作品。
- **番茄小说**：字节跳动旗下免费阅读平台，用户以下沉市场为主，年龄层较广，男女均衡，偏好快节奏、易入坑的内容，广告变现模式。榜单为女频最热榜。
- **七猫小说**：免费阅读平台，女频大热榜每本书带官方两级题材：大类 major（现代言情/古代言情/幻想言情）+ 细分 minor（总裁豪门/宫闱宅斗/年代重生…），用户偏好豪门、宫斗等强戏剧冲突题材。

请基于以下今日数据进行专业分析，输出格式为 JSON：
{
  "date": "${today}",
  "overall_summary": "一段总括性分析（100-150字）",
  "platforms": {
    "jjwxc": {
      "headline": "一句话概括今日晋江特点",
      "analysis": "2-3段深度分析（200-300字），包含题材趋势、新上榜亮点、与平台用户画像的关联、潜在信号"
    },
    "changpei": {
      "headline": "...",
      "analysis": "..."
    },
    "fanqie": {
      "headline": "...",
      "analysis": "..."
    },
    "qimao": {
      "headline": "...",
      "analysis": "..."
    }
  },
  "cross_platform_insights": "跨平台对比分析（150-200字），指出四站差异背后的市场逻辑",
  "notable_signals": ["信号1", "信号2", "信号3"]
}

注意：
1. 分析要有信息增量，不要泛泛而谈，要结合具体数据（题材占比、新上榜作品名等）
2. 尝试解读数据背后的原因（为什么这个题材在这个平台火？用户需求是什么？）
3. 如果某个题材或作品表现异常，给出可能的解释
4. 七猫榜单只有 20 本，样本小，分析时注意不要过度归纳
5. 输出必须是合法 JSON，不要包含 markdown 代码块标记`;

  const userPrompt = `以下是${today}四个平台的Top榜单数据：\n\n${dataBlock}\n\n请进行深度分析并以JSON格式输出。`;

  console.log('\n🤖 正在调用 AI 分析...');
  
  try {
    const response = await callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    console.log('  ✓ AI 分析完成');

    // 尝试解析 JSON
    let analysis;
    try {
      // 清理可能的 markdown 代码块标记
      let cleaned = response.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();
      
      analysis = JSON.parse(cleaned);
    } catch(e) {
      console.log('  [WARN] JSON 解析失败，保存原始文本');
      analysis = {
        date: today,
        overall_summary: response.slice(0, 500),
        platforms: {},
        cross_platform_insights: '',
        notable_signals: [],
        raw_response: response,
        parse_error: true,
      };
    }

    // 添加元信息
    analysis.generated_at = fmtDateTime(now);
    analysis.model = LLM_MODEL;

    // 保存
    const analysisPath = path.join(DATA_DIR, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');

    // 也保存历史
    const histDir = path.join(DATA_DIR, 'analysis_history');
    if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify(analysis, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log('🎉 分析完成！');
    console.log(`  文件: ${analysisPath}`);
    if (analysis.overall_summary) {
      console.log(`\n📋 总览: ${analysis.overall_summary}`);
    }
    if (analysis.notable_signals?.length > 0) {
      console.log(`\n🔔 关键信号:`);
      analysis.notable_signals.forEach((s, i) => console.log(`  ${i+1}. ${s}`));
    }

  } catch(e) {
    console.error('❌ AI 分析失败:', e.message);
    
    // 失败时生成一个降级版本（使用预置模板）
    console.log('  降级为预置模板分析...');
    const fallback = generateFallbackAnalysis(allData, today);
    const analysisPath = path.join(DATA_DIR, 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(fallback, null, 2), 'utf-8');
    console.log('  ✓ 降级分析已保存');
  }
}

// ========== 降级分析（预置模板，AI失败时使用） ==========
function generateFallbackAnalysis(allData, today) {
  const result = {
    date: today,
    overall_summary: '今日数据已更新，AI 分析暂时不可用，以下为自动统计摘要。',
    platforms: {},
    cross_platform_insights: '',
    notable_signals: [],
    fallback: true,
  };

  const pNames = { jjwxc: '晋江文学城', changpei: '长佩文学', fanqie: '番茄小说', qimao: '七猫小说' };
  
  for (const [pid, pname] of Object.entries(pNames)) {
    const data = allData[pid];
    if (!data?.books?.length) {
      result.platforms[pid] = { headline: '暂无数据', analysis: '未获取到数据。' };
      continue;
    }
    
    const tags = Object.entries(data.tag_stats || {}).sort((a, b) => b[1] - a[1]);
    let genders = Object.entries(data.gender_stats || {}).sort((a, b) => b[1] - a[1]);
    // 无 gender_stats 平台用 channel 兜底（长佩/七猫）
    if (genders.length === 0) {
      const cs = {};
      for (const b of data.books) { const ch = (b.channel || '').trim(); if (ch) cs[ch] = (cs[ch] || 0) + 1; }
      genders = Object.entries(cs).sort((a, b) => b[1] - a[1]);
    }
    const newBooks = data.books.filter(b => b.rank_change === 'new');
    
    const topTag = tags[0]?.[0] || '未知';
    const topPct = tags[0] ? Math.round(tags[0][1] / data.books.length * 100) : 0;
    
    result.platforms[pid] = {
      headline: `${topTag}题材以${topPct}%领跑，${newBooks.length}部新作上榜`,
      analysis: `${pname}今日榜单中，${genders.length ? genders.map(([g, c]) => `${g}${c}本`).join('、') + '。' : ''}题材方面，${tags.slice(0, 3).map(([t, c]) => `「${t}」${c}本`).join('、')}位列前三。${newBooks.length > 0 ? `新上榜${newBooks.length}部，包括${newBooks.slice(0, 3).map(b => `《${b.book_name}》(#${b.rank})`).join('、')}。` : '今日无新上榜变动。'}`,
    };
  }

  return result;
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
