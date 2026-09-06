/**
 * 七猫小说 榜单爬虫
 * 
 * 数据源: siweimidu/QiMaoRankTracker2 的公开静态 API
 * API: https://siweimidu.github.io/QiMaoRankTracker2/api/
 * 
 * 抓取:
 *   1. 女生日榜 Top20（默认 + --girl）
 *   2. 男生日榜 Top20（默认；--girl 时跳过，--boy 时只抓男频）
 */

const fs = require('fs');
const path = require('path');
const { computeRankChange } = require('./rank-change');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'qimao');
const API_BASE = 'https://siweimidu.github.io/QiMaoRankTracker2/api';

// 榜单配置：默认抓女生日榜 + 男生日榜；--girl 只抓女生日榜（当前 daily-scrape 用法）
const RANKINGS = [
  { id: 'boy_hot', name: '男生日榜', slug: 'boy-hot-date', file: 'boy_hot.json' },
  { id: 'girl_hot', name: '女生日榜', slug: 'girl-hot-date', file: 'girl_hot.json' },
];

// ========== 工具函数 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

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

// ========== 抓取单个榜单 ==========
async function scrapeRanking(ranking, now) {
  console.log(`\n📊 抓取: ${ranking.name}`);
  
  const url = `${API_BASE}/${ranking.slug}/latest/all.json`;
  console.log(`  📡 ${url}`);
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovelTracker/1.0)' }
  });
  
  if (!res.ok) {
    console.log(`  [ERROR] HTTP ${res.status}`);
    return null;
  }
  
  const data = await res.json();
  const rawBooks = data.books || [];
  
  if (rawBooks.length === 0) {
    console.log(`  [WARN] ${ranking.name} 无数据`);
    return null;
  }
  
  // 标准化字段
  const books = rawBooks.map(b => ({
    rank: b.rank,
    book_name: b.title || '',
    book_url: b.url || '',
    author: b.author || '',
    author_url: b.author_url || '',
    tags: [b.category || ''].filter(Boolean),
    all_tags: [b.category || ''].filter(Boolean),
    primary_tag: b.category || '',
    abstract: b.intro || '',
    word_count: b.word_count_text || '',
    popularity: b.heat ? String(b.heat) : '',
    status: b.status || '连载中',
    update_time: b.updated_at || '',
    channel: b.major || '',
    gender: b.major === '男频' ? '男' : b.major === '女频' ? '女' : '',
    rank_change: b.is_new ? 'new' : (b.rank_change || null),
    heat_change: b.heat_change || 0,
    is_new: b.is_new || false,
    badge: b.badge || '',
    latest_chapter: b.latest_chapter || '',
    boards_count: b.boards_count || 1,
    category: b.category || '',
  }));
  
  // 计算排名变化（覆盖 API 返回的，保持一致性）
  computeRankChange(books, DATA_DIR, fmtDate(now), 'book_name');
  
  // 统计
  const tagStats = {};
  for (const b of books) {
    const cat = b.category || b.primary_tag;
    if (cat) tagStats[cat] = (tagStats[cat] || 0) + 1;
  }
  const statusStats = {};
  for (const b of books) { statusStats[b.status] = (statusStats[b.status] || 0) + 1; }
  
  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    source: `七猫小说·${ranking.name}`,
    source_url: `https://www.qimao.com/paihang`,
    platform: 'qimao',
    platform_name: '七猫小说',
    ranking_id: ranking.id,
    ranking_name: ranking.name,
    tag_stats: tagStats,
    status_stats: statusStats,
    books,
  };
  
  // 保存文件
  const filePath = path.join(DATA_DIR, ranking.file);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  
  console.log(`  ✅ ${ranking.name}: ${books.length} 本`);
  return result;
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`七猫小说 榜单爬虫 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  // 支持 --girl / --boy 只抓单频榜（daily-scrape 目前只用女频 --girl）
  const onlyFlag = process.argv.find(a => /^--(girl|boy)$/.test(a));
  const rankings = onlyFlag === '--girl' ? RANKINGS.filter(r => r.id.startsWith('girl'))
                 : onlyFlag === '--boy' ? RANKINGS.filter(r => r.id.startsWith('boy'))
                 : RANKINGS;

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  try {
    const results = [];
    for (const ranking of rankings) {
      const result = await scrapeRanking(ranking, now);
      if (result) results.push(result);
      await sleep(1000);
    }
    
    // 保存历史
    const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
    const histData = {};
    for (const r of results) {
      histData[r.ranking_id] = {
        count: r.total_count,
        tag_stats: r.tag_stats,
        status_stats: r.status_stats,
      };
    }
    fs.writeFileSync(histPath, JSON.stringify({
      date: fmtDate(now),
      update_time: fmtDateTime(now),
      rankings: histData,
    }, null, 2), 'utf-8');
    
    // 更新历史索引
    const idxPath = path.join(DATA_DIR, 'history_index.json');
    let idx = [];
    if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
    const today = fmtDate(now);
    if (!idx.includes(today)) idx.unshift(today);
    idx = idx.slice(0, 90);
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 全部完成！`);
    for (const r of results) {
      console.log(`   ${r.ranking_name}: ${r.total_count} 本`);
    }
    console.log(`\n   数据目录: ${DATA_DIR}`);

  } catch(e) {
    console.error('致命错误:', e);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
