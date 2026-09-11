/**
 * 七猫小说 榜单爬虫
 *
 * 数据源: siweimidu/QiMaoRankTracker2 的公开静态 API
 * API: https://siweimidu.github.io/QiMaoRankTracker2/api/
 *
 * 抓取女频 8 榜（大热/新书/完结/收藏/更新 × 日/月），去重合并成「女频池」。
 *
 * 产出:
 *   data/qimao/boards/<id>.json    每榜 Top20（含官方 major/minor 两级分类）
 *   data/qimao/pool.json           8 榜去重池 —— 题材三栏模块 + 平台列表共用
 *   data/qimao/girl_hot.json       大热日榜单独落一份（兼容 analyze / platform-summary / build-trends）
 *   data/qimao/history/<date>.json 日聚合（rankings）+ 书级快照（books，供在榜天数）
 *
 * 上游字段说明（每本书只有官方两级分类，无自由标签）:
 *   major / minor  = 官方大类 / 官方细分（物理父子 1:1，非交叉）
 *   intro          = 简介（100% 覆盖）
 */

const fs = require('fs');
const path = require('path');
const { computeRankChange } = require('./rank-change');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'qimao');
const API_BASE = 'https://siweimidu.github.io/QiMaoRankTracker2/api';

// 女频 8 榜；--girl / --boy 仅作兼容开关，当前站点只展示女频
//
// heatRank：该榜 `heat` 字段的口径可信度（1 = 采信），null = 该榜 heat 不是「当日热度」不采
//   日榜（大热/完结/新书）三者同口径，live 实测同一本书数值一致 → 一律 heatRank=1
//   月榜 heat 是月累计（实测约日榜 30 倍），收藏榜为空、更新榜实为更新量 → 一律不采，避免混口径抬高均值
const BOARDS = [
  { slug: 'girl-hot-date',     id: 'girl_hot_date',   name: '女生大热日榜', file: 'girl_hot_date.json', heatRank: 1 },
  { slug: 'girl-over-date',    id: 'girl_over_date',  name: '女生完结日榜', file: 'girl_over_date.json', heatRank: 1 },
  { slug: 'girl-new-date',     id: 'girl_new_date',   name: '女生新书日榜', file: 'girl_new_date.json', heatRank: 1 },
  { slug: 'girl-hot-month',    id: 'girl_hot_month',  name: '女生大热月榜', file: 'girl_hot_month.json', heatRank: null },
  { slug: 'girl-over-month',   id: 'girl_over_month', name: '女生完结月榜', file: 'girl_over_month.json', heatRank: null },
  { slug: 'girl-new-month',    id: 'girl_new_month',  name: '女生新书月榜', file: 'girl_new_month.json', heatRank: null },
  { slug: 'girl-collect-date', id: 'girl_collect',    name: '女生收藏日榜', file: 'girl_collect.json', heatRank: null },
  { slug: 'girl-update-date',  id: 'girl_update',     name: '女生更新日榜', file: 'girl_update.json', heatRank: null },
];

// 榜单短名（去掉「女生」前缀，用于池里标注「上过哪些榜」）
function shortName(n) { return String(n || '').replace(/^女生/, ''); }

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

// ========== 标准化：把上游一本 raw book 转成站内字段 ==========
// 站内约定：channel = 官方大类（一级语境），category = 官方细分（列表行）
function normalizeBook(b, boardName, heatRank) {
  const major = b.major || b.category_1_name || '';
  const minor = b.minor || b.category || '';
  const hasHeat = heatRank != null && b.heat != null;
  return {
    rank: b.rank,
    book_name: b.title || '',
    book_url: b.url || '',
    author: b.author || '',
    author_url: b.author_url || '',
    // 官方两级分类
    channel: major,           // 一级：官方大类 major（现代言情/古代言情/幻想言情）
    major: major,
    major_id: b.major_id,
    category: minor,          // 二级：官方细分 minor（总裁豪门/宫闱宅斗…）
    minor: minor,
    minor_id: b.minor_id,
    primary_tag: major,
    // 站内标签数组：两级都放进去，下游 getSubTags 会自动扣掉 channel
    tags: [major, minor].filter(Boolean),
    all_tags: [major, minor].filter(Boolean),
    abstract: b.intro || '',
    word_count: b.word_count_text || '',
    word_count_num: b.word_count || 0,
    // 热度：只有口径可信的榜单才采（收藏榜为空 / 更新榜是更新量 → 留空）
    popularity: hasHeat ? String(b.heat) : '',
    popularity_num: hasHeat ? b.heat : 0,
    heat_rank: hasHeat ? heatRank : null,
    heat_src: hasHeat ? shortName(boardName) : '',
    status: b.status || '连载中',
    update_time: b.updated_at || '',
    cover: b.cover || '',
    badge: b.badge || '',
    latest_chapter: b.latest_chapter || '',
    platform_trend: b.platform_trend || '',
    is_new: b.is_new || false,
    heat_change: hasHeat ? (b.heat_change || 0) : 0,
    boards: [shortName(boardName)],
    boards_count: b.boards_count || 1,
  };
}

// ========== 抓取单个榜单 ==========
async function scrapeBoard(board, now) {
  const url = `${API_BASE}/${board.slug}/latest/all.json`;
  process.stdout.write(`  抓取 ${board.name} ... `);
  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovelTracker/1.0)' } });
    if (!res.ok) { console.log(`[ERROR] HTTP ${res.status}`); return null; }
    data = await res.json();
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    return null;
  }
  const rawBooks = data.books || [];
  if (!rawBooks.length) { console.log('[WARN] 无数据'); return null; }

  const books = rawBooks.map(b => normalizeBook(b, data.board?.name || board.name, board.heatRank));

  // 排名变化（历史聚合已有；书级历史自本次起累积）
  computeRankChange(books, DATA_DIR, fmtDate(now), 'book_name');

  const tagStats = {};
  for (const b of books) if (b.category) tagStats[b.category] = (tagStats[b.category] || 0) + 1;
  const statusStats = {};
  for (const b of books) statusStats[b.status] = (statusStats[b.status] || 0) + 1;

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    source: `七猫小说·${board.name}`,
    source_url: 'https://www.qimao.com/paihang',
    platform: 'qimao',
    platform_name: '七猫小说',
    ranking_id: board.id,
    ranking_name: board.name,
    tag_stats: tagStats,
    status_stats: statusStats,
    keywords: data.keywords || [],
    categories: data.categories || [],
    books,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'boards', board.file), JSON.stringify(result, null, 2), 'utf-8');
  console.log(`✅ ${books.length} 本`);
  return result;
}

// ========== 合并去重成池 ==========
function buildPool(results, now) {
  const map = new Map();   // book_name -> book
  for (const r of results) {
    if (!r) continue;
    const bn = shortName(r.ranking_name);
    for (const b of r.books) {
      const key = b.book_name;
      if (!key) continue;
      if (!map.has(key)) { map.set(key, { ...b, boards: [] }); }
      const cur = map.get(key);
      if (!cur.boards.includes(bn)) cur.boards.push(bn);
      // 热度：按榜单口径可信度取（heatRank 小者优先；同口径取较大值）。
      // 收藏榜 heat 为空、更新榜 heat 是更新量 → heatRank=null，一律不参与。
      const nrk = b.heat_rank == null ? 99 : b.heat_rank;
      const crk = cur.heat_rank == null ? 99 : cur.heat_rank;
      if (nrk < crk || (nrk === crk && nrk < 99 && (b.popularity_num || 0) > (cur.popularity_num || 0))) {
        cur.popularity = b.popularity; cur.popularity_num = b.popularity_num;
        cur.heat_rank = b.heat_rank; cur.heat_src = b.heat_src;
      }
      if ((b.word_count_num || 0) > (cur.word_count_num || 0)) {
        cur.word_count = b.word_count; cur.word_count_num = b.word_count_num;
      }
      if (!cur.abstract && b.abstract) cur.abstract = b.abstract;
      if (!cur.badge && b.badge) cur.badge = b.badge;
      if (!cur.cover && b.cover) cur.cover = b.cover;
    }
  }
  // 排序：上榜数 desc → 热度 desc → 书名
  const books = [...map.values()].sort((a, b) =>
    (b.boards.length - a.boards.length)
    || ((b.popularity_num || 0) - (a.popularity_num || 0))
    || a.book_name.localeCompare(b.book_name));
  books.forEach((b, i) => {
    b.rank = i + 1;
    b.boards_count = b.boards.length;
    b.tags = [b.channel, b.category].filter(Boolean);
    b.all_tags = b.tags.slice();
  });

  // 合并热词 / 分类聚合
  const kwMap = new Map();
  const catMap = new Map();
  for (const r of results) {
    if (!r) continue;
    for (const k of r.keywords || []) kwMap.set(k.word, (kwMap.get(k.word) || 0) + (k.count || 0));
    for (const c of r.categories || []) {
      const key = `${c.major}|${c.name}`;
      const cur = catMap.get(key) || { name: c.name, major: c.major, count: 0, total_heat: 0 };
      cur.count += c.count || 0; cur.total_heat += c.total_heat || 0;
      catMap.set(key, cur);
    }
  }

  const tagStats = {};
  const majorStats = {};
  const statusStats = {};
  for (const b of books) {
    if (b.category) tagStats[b.category] = (tagStats[b.category] || 0) + 1;
    if (b.channel) majorStats[b.channel] = (majorStats[b.channel] || 0) + 1;
    statusStats[b.status] = (statusStats[b.status] || 0) + 1;
  }

  return {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    source: '七猫小说·女频 8 榜去重',
    source_url: 'https://www.qimao.com/paihang',
    platform: 'qimao',
    platform_name: '七猫小说',
    ranking_id: 'girl_pool',
    ranking_name: '女频 8 榜去重',
    tag_stats: tagStats,
    major_stats: majorStats,
    status_stats: statusStats,
    heat_cover: books.filter(b => (b.popularity_num || 0) > 0).length,   // 有可信热度的书数（右栏均值样本）
    boards: results.filter(Boolean).map(r => ({
      id: r.ranking_id, name: r.ranking_name, count: r.total_count, date: r.update_date,
    })),
    keywords: [...kwMap.entries()].map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count).slice(0, 60),
    categories: [...catMap.values()].sort((a, b) => b.count - a.count),
    books,
  };
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`七猫小说 女频 8 榜爬虫 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  // --girl / --boy 兼容开关：当前站点只展示女频，两者均抓女频 8 榜
  const flag = process.argv.find(a => /^--(girl|boy)$/.test(a));
  if (flag === '--boy') console.log('  [提示] 站点仅展示女频，--boy 亦抓女频 8 榜');

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'boards'));
  ensureDir(path.join(DATA_DIR, 'history'));

  try {
    const results = [];
    for (const board of BOARDS) {
      const r = await scrapeBoard(board, now);
      if (r) results.push(r);
      await sleep(400);
    }
    if (!results.length) throw new Error('全部榜单抓取失败');

    // 1) 去重池
    const pool = buildPool(results, now);
    fs.writeFileSync(path.join(DATA_DIR, 'pool.json'), JSON.stringify(pool, null, 2), 'utf-8');
    console.log(`\n  池：8 榜去重 ${pool.total_count} 本（${Object.keys(pool.major_stats).length} 大类 / ${Object.keys(pool.tag_stats).length} 细分）`);

    // 2) 大热日榜单独落一份，兼容 analyze.js / platform-summary.js / build-trends.js
    const hotDate = results.find(r => r.ranking_id === 'girl_hot_date');
    if (hotDate) {
      fs.writeFileSync(path.join(DATA_DIR, 'girl_hot.json'), JSON.stringify(hotDate, null, 2), 'utf-8');
    }

    // 3) 历史：保留 rankings 聚合（build-trends 依赖）+ 新增书级快照（在榜天数）
    const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
    const histData = {};
    for (const r of results) {
      histData[r.ranking_id] = {
        count: r.total_count, tag_stats: r.tag_stats, status_stats: r.status_stats, major_stats: majorStatsOf(r),
      };
    }
    fs.writeFileSync(histPath, JSON.stringify({
      date: fmtDate(now),
      update_time: fmtDateTime(now),
      rankings: histData,
      books: pool.books.map(b => ({ book_name: b.book_name, rank: b.rank })),
    }, null, 2), 'utf-8');

    // 4) 历史索引
    const idxPath = path.join(DATA_DIR, 'history_index.json');
    let idx = [];
    if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
    const today = fmtDate(now);
    if (!idx.includes(today)) idx.unshift(today);
    idx = idx.slice(0, 90);
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log('🎉 全部完成！');
    for (const r of results) console.log(`   ${r.ranking_name}: ${r.total_count} 本`);
    console.log(`   去重池: ${pool.total_count} 本 → data/qimao/pool.json`);
    console.log(`   数据目录: ${DATA_DIR}`);

  } catch(e) {
    console.error('致命错误:', e);
    process.exit(1);
  }
}

// 单榜的大类分布（历史快照用）
function majorStatsOf(r) {
  const m = {};
  for (const b of r.books) if (b.channel) m[b.channel] = (m[b.channel] || 0) + 1;
  return m;
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
