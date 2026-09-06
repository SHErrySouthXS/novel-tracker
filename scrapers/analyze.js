/**
 * 每日 AI 智能分析模块
 * 
 * 在三个爬虫跑完后执行，读取三站最新数据，
 * 调用通义千问 API 生成深度分析，保存为 analysis.json 供前端展示
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data');
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

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
function callQwenAPI(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'qwen-plus',
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    });

    const url = new URL(QWEN_API_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
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
  
  const sortedTags = Object.entries(tagStats).sort((a, b) => b[1] - a[1]);
  const sortedGenders = Object.entries(genderStats).sort((a, b) => b[1] - a[1]);
  const newBooks = books.filter(b => b.rank_change === 'new');
  const risingBooks = books.filter(b => typeof b.rank_change === 'number' && b.rank_change > 3);
  const fallingBooks = books.filter(b => typeof b.rank_change === 'number' && b.rank_change < -3);
  
  let summary = `【${platformName}】(来源: ${data.source})\n`;
  summary += `总计: ${books.length}本\n`;
  summary += `频道分布: ${sortedGenders.map(([g, c]) => `${g}${c}本(${Math.round(c/books.length*100)}%)`).join('、')}\n`;
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

  if (!QWEN_API_KEY) {
    console.error('❌ 未设置 QWEN_API_KEY 环境变量');
    process.exit(1);
  }

  // 读取三站数据
  const platforms = [
    { id: 'fanqie', name: '番茄小说' },
    { id: 'qidian', name: '起点中文网' },
    { id: 'jjwxc', name: '晋江文学城' },
  ];

  const allData = {};
  const summaries = [];

  for (const p of platforms) {
    const data = readJSON(path.join(DATA_DIR, p.id, 'latest.json'));
    allData[p.id] = data;
    summaries.push(buildDataSummary(p.name, data));
    console.log(`  ${p.name}: ${data?.books?.length || 0} 本`);
  }

  // 构建 Prompt
  const today = fmtDate(now);
  const dataBlock = summaries.join('\n\n');

  const systemPrompt = `你是一位资深的网络文学行业分析师，对中国网文市场有深入了解。你熟悉番茄小说、起点中文网、晋江文学城三大平台的定位和用户画像差异：

- **番茄小说**：字节跳动旗下免费阅读平台，用户以下沉市场为主，年龄层较广，男女均衡，偏好快节奏、易入坑的内容，广告变现模式。
- **起点中文网**：阅文集团核心平台，付费阅读模式，男频为传统强势领域，用户付费意愿强、忠诚度高，是网文精品化的标杆。
- **晋江文学城**：女性向原创文学社区，以纯爱(BL)、言情为主力品类，IP改编价值极高，用户以年轻女性为主，社区氛围浓厚。

请基于以下今日数据进行专业分析，输出格式为 JSON：
{
  "date": "${today}",
  "overall_summary": "一段总括性分析（100-150字）",
  "platforms": {
    "fanqie": {
      "headline": "一句话概括今日番茄特点",
      "analysis": "2-3段深度分析（200-300字），包含题材趋势、新上榜亮点、与平台用户画像的关联、潜在信号"
    },
    "qidian": {
      "headline": "...",
      "analysis": "..."
    },
    "jjwxc": {
      "headline": "...",
      "analysis": "..."
    }
  },
  "cross_platform_insights": "跨平台对比分析（150-200字），指出三站差异背后的市场逻辑",
  "notable_signals": ["信号1", "信号2", "信号3"]
}

注意：
1. 分析要有信息增量，不要泛泛而谈，要结合具体数据（题材占比、新上榜作品名等）
2. 尝试解读数据背后的原因（为什么这个题材在这个平台火？用户需求是什么？）
3. 如果某个题材或作品表现异常，给出可能的解释
4. 输出必须是合法 JSON，不要包含 markdown 代码块标记`;

  const userPrompt = `以下是${today}三大小说平台的Top50榜单数据：\n\n${dataBlock}\n\n请进行深度分析并以JSON格式输出。`;

  console.log('\n🤖 正在调用 AI 分析...');
  
  try {
    const response = await callQwenAPI([
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
    analysis.model = 'qwen-plus';

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

  const pNames = { fanqie: '番茄小说', qidian: '起点中文网', jjwxc: '晋江文学城' };
  
  for (const [pid, pname] of Object.entries(pNames)) {
    const data = allData[pid];
    if (!data?.books?.length) {
      result.platforms[pid] = { headline: '暂无数据', analysis: '未获取到数据。' };
      continue;
    }
    
    const tags = Object.entries(data.tag_stats || {}).sort((a, b) => b[1] - a[1]);
    const genders = Object.entries(data.gender_stats || {}).sort((a, b) => b[1] - a[1]);
    const newBooks = data.books.filter(b => b.rank_change === 'new');
    
    const topTag = tags[0]?.[0] || '未知';
    const topPct = tags[0] ? Math.round(tags[0][1] / data.books.length * 100) : 0;
    
    result.platforms[pid] = {
      headline: `${topTag}题材以${topPct}%领跑，${newBooks.length}部新作上榜`,
      analysis: `${pname}今日Top50中，${genders.map(([g, c]) => `${g}${c}本`).join('、')}。题材方面，${tags.slice(0, 3).map(([t, c]) => `「${t}」${c}本`).join('、')}位列前三。${newBooks.length > 0 ? `新上榜${newBooks.length}部，包括${newBooks.slice(0, 3).map(b => `《${b.book_name}》(#${b.rank})`).join('、')}。` : '今日无新上榜变动。'}`,
    };
  }

  return result;
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
