/**
 * 番茄小说·巅峰榜 Top30 爬虫（月度）
 *
 * 数据源：https://fanqienovel.com/api/author/misc/top_book_list/v1/
 *   —— 即官网首页「番茄巅峰榜」（根据作品好评、人气、互动等综合得分排行，不分垂类，男女频混合）
 *   返回固定 Top30，纯 HTTP、无签名、无需登录。
 *
 * 每本自带：book_id / book_name / author / category(单一主分类) / creation_status / thumb_url
 * 简介 + 多标签需逐本抓详情页补齐（30 本，秒级）。
 * 标签口径：详情页 JSON-LD 的 genre 只吐一个主分类 → 完整标签走浏览器渲染取 DOM
 *   （playwright-core + 本机 Chrome，不可用时静默降级，不影响月度任务）。
 * 注意：巅峰榜是全站「男女频混合」榜（2026-09 为男频 20 / 女频 10），
 *   与女频口径的 08 分类池不同源，前端三栏按「频道 → 主分类」呈现。
 *
 * 巅峰榜每月 1 号更新一次，本爬虫每月 2 号跑（保险起见）。
 *
 * 输出（对齐起点收藏榜 / 晋江积分榜Top1000 的月度模式）：
 *   data/fanqie/peak.json                  —— 最新版（前端默认加载）
 *   data/fanqie/peak_history/YYYY-MM.json  —— 月度存档
 *   data/fanqie/peak_index.json            —— 月份索引 ["2026-08","2026-07",...]（倒序）
 *
 * 排名变化（rank_change）：与上一个月度存档比对
 *   - 'new'：上月存档里不存在该 book_id
 *   - 数字：上月rank - 本月rank（正数=上升）
 *   - null：无上月存档可比
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'fanqie');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://fanqienovel.com/?enter_from=menu',
};
const PEAK_API = 'https://fanqienovel.com/api/author/misc/top_book_list/v1/';
const REQUEST_DELAY = 500;

// ========== 男女频判定 ==========
// 番茄接口只给单一 category（无性别字段），用分类映射表判定男女频。
// 优先级：GENDER_OVERRIDE(按 book_id 人工修正) > CATEGORY_GENDER(精确分类映射) > 关键词兜底

// 1) 精确分类 → 频道映射（番茄官方分类，中性分类不列入，交给关键词兜底或 override）
const CATEGORY_GENDER = {
  // ===== 男频 =====
  '都市高武': '男频', '玄幻脑洞': '男频', '传统玄幻': '男频', '东方仙侠': '男频',
  '悬疑脑洞': '男频', '悬疑灵异': '男频', '历史古代': '男频', '西方奇幻': '男频',
  '都市异能': '男频', '科幻脑洞': '男频', '末世危机': '男频', '铁血战争': '男频',
  '游戏竞技': '男频', '体育竞技': '男频', '都市生活': '男频', '娱乐明星': '男频',
  '武侠江湖': '男频', '现实百态': '男频', '玄幻': '男频', '仙侠': '男频',
  '奇幻': '男频', '历史': '男频', '军事': '男频', '科幻': '男频', '悬疑': '男频',
  // ===== 女频 =====
  '现言脑洞': '女频', '青春甜宠': '女频', '玄幻言情': '女频', '豪门总裁': '女频',
  '星光璀璨': '女频', '古代言情': '女频', '现代言情': '女频', '古言脑洞': '女频', '幻想言情': '女频',
  '甜宠': '女频', '宫斗宅斗': '女频', '婚恋豪门': '女频', '青春校园': '女频',
  '仙侠情缘': '女频', '穿越奇情': '女频', '女性成长': '女频', '古装言情': '女频',
  '言情': '女频',
};

// 2) book_id 人工修正表（分类中性或分类无法判定的个案，此处最高优先级）
//    key = book_id, value = '男频' | '女频'
const GENDER_OVERRIDE = {
  '7361653460183288894': '女频', // 游戏入侵：抢男女主机缘会上瘾诶（category=游戏体育，实为女频言情向）
  '7448581895861849112': '女频', // 公路求生榜一说她要走到公路尽头（category=游戏体育，女强/无CP女主向）
};

// 女频关键词兜底（映射表未覆盖的新分类时用）
const FEMALE_KWS = ['言情', '古言', '现言', '甜宠', '宫斗', '宅斗', '豪门', '总裁', '青春', '世情', '快穿', '穿书', '穿越', '重生', '虐恋', '婚恋', '校园', '女频'];

function judgeGender(category, bookId) {
  // 1) 人工修正表最高优先
  if (GENDER_OVERRIDE[bookId]) return GENDER_OVERRIDE[bookId];
  // 2) 精确分类映射
  if (CATEGORY_GENDER[category]) return CATEGORY_GENDER[category];
  // 3) 关键词兜底
  if (category && FEMALE_KWS.some(k => category.includes(k))) return '女频';
  if (category) return '男频';
  return '未知';
}

// ========== 工具函数 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// ========== 从详情页补简介 + 多标签 ==========
function parseDetailPage(html) {
  const info = { tags: [] };

  // 简介
  const dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  if (dm) {
    info.abstract = dm[1].replace(/^番茄小说提供.*?番茄小说网[。.]?\s*/, '').trim();
  }

  // JSON-LD 里的 genre（多标签）
  const ldm = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ldm) {
    try {
      const ld = JSON.parse(ldm[1]);
      if (ld.genre) {
        const genres = Array.isArray(ld.genre) ? ld.genre : [ld.genre];
        for (const g of genres) {
          if (g && !info.tags.includes(g)) info.tags.push(g);
        }
      }
      if (ld.image?.[0]) info.hdImage = ld.image[0];
    } catch (e) {}
  }

  return info;
}

// ========== 详情页完整标签（浏览器渲染） ==========
// 番茄详情页 JSON-LD 的 genre 现在只吐一个主分类，抓不到完整标签；需渲染后从 DOM 取
// （与 tag-study 语料同一口径）。依赖本机 Chrome；不可用时静默降级，不阻塞月度任务。
function loadChromium() {
  const cands = [
    process.env.PW_MODULE,
    'playwright',
    'playwright-core',
    path.join(process.env.HOME || '', '.workbuddy/binaries/node/workspace/node_modules/playwright-core'),
  ].filter(Boolean);
  for (const c of cands) { try { return require(c).chromium; } catch (e) {} }
  return null;
}
function findChromeExe() {
  const cands = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
const TAG_DENY = ['连载中', '已完结', '完结', '连载', '开始阅读', '下载', '免费', '最近更新'];

async function fetchTagsViaBrowser(books) {
  const chromium = loadChromium();
  if (!chromium) { console.log('  ⚠️ playwright 不可用 → 跳过（保留 HTTP 路径标签）'); return; }
  const exe = findChromeExe();
  let browser;
  try {
    const opts = { headless: true, args: ['--disable-blink-features=AutomationControlled'] };
    if (exe) opts.executablePath = exe;
    browser = await chromium.launch(opts);
  } catch (e) {
    console.log(`  ⚠️ 浏览器启动失败（${String(e.message).slice(0, 50)}）→ 跳过`);
    return;
  }
  let ok = 0;
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1600, height: 900 },
    });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    const page = await ctx.newPage();
    // 先过首页建会话（绕过 WAF）
    await page.goto('https://fanqienovel.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1200);

    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      process.stdout.write(`  [${i + 1}/${books.length}] ${b.book_name} `);
      let tags = [];
      try {
        await page.goto(`https://fanqienovel.com/page/${b.book_id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1000);
        tags = await page.evaluate((deny) => {
          const res = [];
          const title = document.title.replace(/(完整版|全文|_番茄.*|_.*)/, '').trim();
          const bad = t => !t || t.length > 8 || deny.indexOf(t) >= 0 || t.indexOf('万字') >= 0 || t.indexOf('番茄') >= 0;
          const sels = ['.info-label .label-tag', '.book-info .tag', '.page-header-info .tag', '[class*="tag"]', '[class*="label"]'];
          for (const sel of sels) {
            document.querySelectorAll(sel).forEach(el => { const t = el.textContent.trim(); if (!bad(t)) res.push(t); });
            if (res.length) break;
          }
          if (!res.length) {
            const h1 = document.querySelector('h1');
            if (h1) {
              const tr = h1.getBoundingClientRect();
              document.querySelectorAll('span,a').forEach(el => {
                const rc = el.getBoundingClientRect();
                if (rc.top > tr.bottom && rc.top < tr.bottom + 110 && rc.height < 40 && rc.width < 150 && rc.width > 20) {
                  const t = el.textContent.trim();
                  if (!bad(t)) res.push(t);
                }
              });
            }
          }
          return [...new Set(res)].filter(t => t !== title);
        }, TAG_DENY);
      } catch (e) { /* 保留原标签 */ }

      if (tags.length) {
        const merged = [];
        for (const t of [b.primary_tag, ...tags]) { if (t && merged.indexOf(t) < 0) merged.push(t); }
        b.all_tags = merged;
        b.secondary_tags = merged.filter(t => t !== b.primary_tag);
        ok++;
        console.log(`✓ ${merged.length} 个 [${merged.join(', ')}]`);
      } else {
        console.log('✗ (未取到 → 保留原标签)');
      }
      await sleep(700);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`  → 补标签成功 ${ok}/${books.length} 本`);
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  const month = fmtMonth(now);
  console.log('='.repeat(60));
  console.log(`番茄巅峰榜 Top30 爬虫（月度 ${month}） - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  const histDir = path.join(DATA_DIR, 'peak_history');
  ensureDir(histDir);

  // 1) 拉取巅峰榜列表
  console.log('\n📊 拉取巅峰榜列表...');
  let rawList = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpGet(PEAK_API, { Accept: 'application/json' });
      const json = JSON.parse(res.data);
      if (json.code === 0 && Array.isArray(json.book_list) && json.book_list.length) {
        rawList = json.book_list;
        break;
      }
      throw new Error(`空列表 code=${json.code}`);
    } catch (e) {
      console.log(`  [尝试 ${attempt}/3] 失败: ${e.message}`);
      if (attempt < 3) await sleep(3000);
    }
  }

  if (rawList.length === 0) {
    console.log('⚠️ 巅峰榜接口无数据。');
    if (fs.existsSync(path.join(DATA_DIR, 'peak.json'))) {
      console.log('   已有历史数据，退出码 0（不覆盖）。');
      process.exit(0);
    }
    process.exit(1);
  }
  console.log(`  → 获取 ${rawList.length} 本`);

  // 2) 逐本抓详情页补简介 + 多标签
  console.log(`\n📖 补充简介与多标签（${rawList.length} 本）...`);
  const books = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    const bookId = String(raw.book_id);
    const rank = i + 1;
    process.stdout.write(`  [${rank}/${rawList.length}] ${raw.book_name} `);

    let detail = {};
    try {
      const res = await httpGet(`https://fanqienovel.com/page/${bookId}`);
      detail = parseDetailPage(res.data);
      process.stdout.write('✓\n');
    } catch (e) {
      process.stdout.write(`✗ (${e.message.slice(0, 30)})\n`);
    }

    const category = raw.category || '';
    // 多标签：主分类 + 详情页 genre（去重、去掉与主分类重复的、过滤状态词）
    const extraTags = (detail.tags || []).filter(t =>
      t && t !== category && !['连载中', '已完结', '完结', '连载'].includes(t)
    );
    const allTags = [category, ...extraTags].filter(Boolean);
    const primaryTag = category || (allTags[0] || '未分类');
    const secondaryTags = allTags.filter(t => t !== primaryTag);

    // 性别频道（分类映射表 + book_id 人工修正，见顶部 judgeGender）
    const gender = judgeGender(category, bookId);

    books.push({
      rank,
      book_id: bookId,
      book_name: raw.book_name,
      author: raw.author,
      gender,
      primary_tag: primaryTag,
      secondary_tags: secondaryTags,
      all_tags: allTags,
      abstract: detail.abstract || '暂无简介',
      status: raw.creation_status === 0 ? '完结' : (raw.creation_status === 1 ? '连载中' : '未知'),
      rank_score: raw.rank_score || '',
      thumb_url: detail.hdImage || raw.thumb_url || '',
      book_url: `https://fanqienovel.com/page/${bookId}`,
      rank_change: null,
    });

    if (i < rawList.length - 1) await sleep(REQUEST_DELAY);
  }

  // 2b) 浏览器渲染补完整标签（HTTP 只能拿到 JSON-LD 的单一 genre）
  console.log('\n🌐 浏览器渲染补完整标签...');
  await fetchTagsViaBrowser(books);

  // 3) 计算月度排名变化（与最近一个已存月份比对）
  console.log('\n📈 计算月度排名变化...');
  computeMonthlyRankChange(books, histDir, month);

  // 4) 统计
  const tagStats = {};
  for (const b of books) { tagStats[b.primary_tag] = (tagStats[b.primary_tag] || 0) + 1; }
  const genderStats = {};
  for (const b of books) { genderStats[b.gender] = (genderStats[b.gender] || 0) + 1; }

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    update_month: month,
    total_count: books.length,
    source: '番茄小说·巅峰榜',
    source_url: 'https://fanqienovel.com/?enter_from=menu',
    platform: 'fanqie',
    platform_name: '番茄小说',
    rank_type: 'peak',
    tag_stats: tagStats,
    gender_stats: genderStats,
    books,
  };

  // 5) 写文件：最新版 + 月度存档 + 月份索引
  const peakPath = path.join(DATA_DIR, 'peak.json');
  fs.writeFileSync(peakPath, JSON.stringify(result, null, 2), 'utf-8');

  const histPath = path.join(histDir, `${month}.json`);
  fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

  const idxPath = path.join(DATA_DIR, 'peak_index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch (e) {} }
  if (!idx.includes(month)) idx.unshift(month);
  idx.sort((a, b) => b.localeCompare(a));
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 完成！共 ${books.length} 本`);
  console.log(`   性别分布: ${JSON.stringify(genderStats)}`);
  console.log(`   主标签分布: ${JSON.stringify(tagStats)}`);
  console.log(`   最新版: ${peakPath}`);
  console.log(`   月度存档: ${histPath}`);
}

// 月度排名变化：与最近一个已存的历史月份比对
function computeMonthlyRankChange(books, histDir, currentMonth) {
  let prevMap = null;
  if (fs.existsSync(histDir)) {
    const months = fs.readdirSync(histDir)
      .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .filter(m => m < currentMonth)   // 只比当前月之前的
      .sort((a, b) => b.localeCompare(a));
    if (months.length) {
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(histDir, `${months[0]}.json`), 'utf-8'));
        prevMap = {};
        for (const b of prev.books || []) {
          if (b.book_id) prevMap[String(b.book_id)] = b.rank;
        }
        console.log(`  与 ${months[0]} 比对（${Object.keys(prevMap).length} 本）`);
      } catch (e) {}
    }
  }

  let newCount = 0, changed = 0;
  for (const b of books) {
    const id = String(b.book_id);
    if (!prevMap) { b.rank_change = null; continue; }
    if (id in prevMap) { b.rank_change = prevMap[id] - b.rank; changed++; }
    else { b.rank_change = 'new'; newCount++; }
  }
  if (prevMap) console.log(`  新上榜 ${newCount} / 有变化 ${changed}`);
  else console.log('  无历史月份可比，rank_change 全部 null');
}

main().catch(e => {
  console.error('致命错误:', e);
  const peakPath = path.join(DATA_DIR, 'peak.json');
  if (fs.existsSync(peakPath)) {
    console.log('⚠️ 本次失败，但已有历史数据，退出码 0');
    process.exit(0);
  }
  process.exit(1);
});
