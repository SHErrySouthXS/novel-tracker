/**
 * 题材趋势聚合器 —— 把各平台 history 书级/聚合数据 → 每日题材序列
 *
 * 输出 data/trends/<platform>.json：
 *   dates / totals / tags[{tag,counts,shares,delta_7d_share,delta_30d_share,latest}] / flows / summary
 *
 * 维度口径（与各平台自家 tag_stats 语义一致）：
 *   changpei: 总榜 bestseller · primary_tag（官方 11 大类）
 *   fanqie  : 女频榜（单榜）· primary_tag（题材一级池词）
 *   jjwxc   : 月榜 · primary_tag（=channel：言情/纯爱/百合/无CP/多元）
 *   qimao   : 女生日榜 girl_hot · minor（官方细分；history 无书级，先吃聚合 tag_stats）
 *
 * 用法: node scrapers/build-trends.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'trends');
fs.mkdirSync(OUT, { recursive: true });

// ========== 平台配置 ==========
const CONFIGS = [
  {
    platform: 'changpei', platform_name: '长佩文学', dim: 'primary_tag',
    dim_note: '官方 11 大类（青春/都市/架空/综合…）', dim_name: '官方主题材',
    read: (d, dateStr) => {
      const rk = d.rankings && d.rankings.bestseller;
      if (!rk) return null;
      const total = rk.count || 0;
      if (rk.books && rk.books.length) {
        const books = rk.books.filter(b => b && b.primary_tag);
        return { total: books.length, books, getTag: b => b.primary_tag, getName: b => b.book_name };
      }
      return { total, tagStats: rk.tag_stats || {}, tagName: 'tag' };
    },
  },
  {
    platform: 'fanqie', platform_name: '番茄小说', dim: 'primary_tag',
    dim_note: '题材池一级词（豪门总裁/历史古代/科幻末世…）', dim_name: '主题材',
    read: (d) => {
      const books = (d.books || []).filter(b => b && b.primary_tag);
      return { total: books.length, books, getTag: b => b.primary_tag, getName: b => b.book_name };
    },
  },
  {
    platform: 'jjwxc', platform_name: '晋江文学城', dim: 'primary_tag',
    dim_note: '频道（言情/纯爱/百合/无CP/多元）', dim_name: '频道',
    read: (d) => {
      const books = (d.books || []).filter(b => b && b.primary_tag);
      return { total: books.length, books, getTag: b => b.primary_tag, getName: b => b.book_name };
    },
  },
  {
    platform: 'qimao', platform_name: '七猫小说', dim: 'minor',
    dim_note: '官方细分（总裁豪门/宫闱宅斗…）', dim_name: '官方细分',
    read: (d) => {
      const rk = d.rankings && d.rankings.girl_hot;
      if (!rk) return null;
      return { total: rk.count || 0, tagStats: rk.tag_stats || {}, tagName: 'tag' };
    },
  },
];

// ========== 工具 ==========
function loadHistory(platform) {
  const dir = path.join(DATA, platform, 'history');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) {
    const dateStr = f.replace('.json', '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
    try { out.push({ dateStr, d: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) }); }
    catch (e) { console.warn(`  跳过 ${f}: ${e.message}`); }
  }
  return out;
}

const fmt = n => Math.round(n * 10) / 10;

function build(conf) {
  const hist = loadHistory(conf.platform);
  if (!hist.length) return null;
  const dates = [];
  const totals = [];
  const dayCounts = [];   // {tag -> count}
  const dayBooks = [];    // [{name, tag}]（有书级时）
  for (const { dateStr, d } of hist) {
    const got = conf.read(d, dateStr);
    if (!got) continue;
    const counts = {};
    if (got.books) {
      for (const b of got.books) {
        const t = got.getTag(b);
        counts[t] = (counts[t] || 0) + 1;
      }
      dayBooks.push(got.books.map(b => ({ name: got.getName(b), tag: got.getTag(b) })));
    } else {
      for (const [t, n] of Object.entries(got.tagStats)) counts[t] = n;
      dayBooks.push(null);
    }
    dates.push(dateStr);
    totals.push(got.total || Object.values(counts).reduce((s, v) => s + v, 0));
    dayCounts.push(counts);
  }
  if (dates.length < 2) return null;

  // 全部 tag（按最新日 count 排序，保留全量；前端自选 Top N）
  const tags = new Set();
  for (const c of dayCounts) for (const t of Object.keys(c)) tags.add(t);
  const latest = dayCounts[dayCounts.length - 1];
  const allTags = [...tags].filter(t => t).sort((a, b) => (latest[b] || 0) - (latest[a] || 0));

  const n = dates.length;
  const series = allTags.map(tag => {
    const counts = dayCounts.map(c => c[tag] || 0);
    const shares = counts.map((c, i) => (totals[i] ? fmt(c / totals[i] * 100) : 0));
    const latestCount = counts[n - 1];
    const latestShare = shares[n - 1];
    // 窗口差：≥15 天用 7d/30d；≥6 天用前半~后半均值；否则末-首
    let d7 = null, d30 = null;
    const windowPP = (back) => {
      const a = shares[n - 1];
      const from = Math.max(0, n - 1 - back);
      const b = shares.slice(from, n - 1);
      const avg = b.length ? b.reduce((s, v) => s + v, 0) / b.length : shares[from];
      return fmt(a - avg);
    };
    if (n >= 15) { d7 = windowPP(7); d30 = windowPP(30); }
    else if (n >= 6) {
      const half = Math.floor(n / 2);
      const early = shares.slice(0, half).reduce((s, v) => s + v, 0) / half;
      const late = shares.slice(half).reduce((s, v) => s + v, 0) / (n - half);
      d7 = fmt(late - early);
    } else {
      d7 = fmt(shares[n - 1] - shares[0]);
    }
    return { tag, counts, shares, delta_share: d7, delta_share_30d: d30, latest: { count: latestCount, share: latestShare } };
  }).sort((a, b) => b.latest.count - a.latest.count);

  // 每日流入/流出（书级平台才有；对"近 7 日窗口"取差集，抗榜单单日扩容伪影）
  const flows = { dates: [], new_in: [], left_out: [] };
  if (dayBooks[0]) {
    let windowSets = [];   // 最近 7 天书名集合
    dayBooks.forEach((books, i) => {
      const curSet = new Set(books.map(b => b.name));
      if (windowSets.length) {
        const prevWin = new Set();
        windowSets.forEach(s => s.forEach(nm => prevWin.add(nm)));
        const newIn = books.filter(b => !prevWin.has(b.name)).map(b => b.name);
        const left = [...prevWin].filter(nm => !curSet.has(nm));
        flows.new_in.push({ date: dates[i], count: newIn.length, books: newIn.slice(0, 5) });
        flows.left_out.push({ date: dates[i], count: left.length, books: left.slice(0, 5) });
      } else {
        flows.new_in.push({ date: dates[i], count: null, books: [] });
        flows.left_out.push({ date: dates[i], count: null, books: [] });
      }
      windowSets.push(curSet);
      if (windowSets.length > 7) windowSets.shift();
    });
  }

  // ===== 规则版题材摘要（离线；生产可换 LLM 润色）=====
  const summary = makeSummary(conf, dates, totals, series, flows, latest);

  return {
    platform: conf.platform,
    platform_name: conf.platform_name,
    generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    dimension: { key: conf.dim, name: conf.dim_name, note: conf.dim_note },
    list: conf.list || null,
    days: n,
    dates,
    totals,
    tags: series,
    flows,
    summary,
  };
}

function makeSummary(conf, dates, totals, series, flows, latest) {
  const n = dates.length;
  const today = dates[n - 1];
  const top3 = series.slice(0, 3).map(s => `${s.tag} ${s.latest.count} 本(${s.latest.share}%)`);
  // 显著变动：|Δ|≥3pp 的题材
  const movers = series.filter(s => s.latest.count >= 2 && Math.abs(s.delta_share) >= 3)
    .sort((a, b) => Math.abs(b.delta_share) - Math.abs(a.delta_share)).slice(0, 3);
  const moverTxt = movers.length
    ? movers.map(s => `${s.tag} ${s.delta_share > 0 ? '升' : '降'} ${Math.abs(s.delta_share)}pp`).join('、')
    : '各题材占比稳定';
  let parts = [];
  if (n < 3) {
    parts.push(`${conf.platform_name}「${conf.dim_name}」追踪仅 ${n} 天（${dates[0]} 起），构成初现：${top3.slice(0, 2).join('、')}。趋势图随每日归档自动积累。`);
  } else {
    const newToday = flows.new_in.length ? flows.new_in[flows.new_in.length - 1] : null;
    parts.push(`${today} 榜单${conf.dim_name}构成：${top3.join('、')}。`);
    parts.push(`近窗口变动：${moverTxt}。`);
    if (newToday && newToday.count) {
      parts.push(`今日新上榜（近7日不在榜）${newToday.count} 本，含 ${newToday.books.slice(0, 3).map(b => `《${b}》`).join('')}。`);
    } else if (newToday && newToday.count === 0) {
      parts.push('今日榜内均为近 7 日在榜作品，零新面孔。');
    }
  }
  return { date: today, text: parts.join('') };
}

// ========== 主流程 ==========
const indexMeta = [];
for (const conf of CONFIGS) {
  const res = build(conf);
  if (!res) { console.log(`[skip] ${conf.platform}: 历史不足 2 天`); continue; }
  const file = path.join(OUT, `${conf.platform}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 1), 'utf-8');
  const topNow = res.tags.slice(0, 3).map(s => `${s.tag}:${s.latest.count}本/${s.latest.share}%`);
  console.log(`✓ ${conf.platform}  ${res.days} 天 (${res.dates[0]} ~ ${res.dates[res.days - 1]}) | 题材数 ${res.tags.length} | Top: ${topNow.join('  ')}`);
  indexMeta.push({ platform: res.platform, platform_name: res.platform_name, days: res.days, updated: res.dates[res.days - 1], dim: res.dimension.name });
}
fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify({ generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '), platforms: indexMeta }, null, 1), 'utf-8');
console.log('\n写入 data/trends/ 完成');
