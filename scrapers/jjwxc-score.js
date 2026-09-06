/**
 * 晋江文学城·积分榜 Top1000 爬虫
 *
 * 数据源: https://www.jjwxc.net/bookbase.php?s_typeid=1&page=N
 *   - 晋江作品库总榜，默认按【作品总积分】降序排列
 *   - 每页 100 本，抓 10 页 = Top1000
 *   - 传统 HTML(GBK)，纯 HTTP 请求即可，无需浏览器
 *   - 注意：不要带 sign/time/submit 参数（那是一次性签名，过期会返回空页）
 *
 * 列表页 7 列结构:
 *   [0]作者 [1]作品 [2]类型(原创-纯爱-架空历史-爱情-主受) [3]进度 [4]字数 [5]作品积分 [6]发表时间
 *
 * 输出（与起点收藏榜同构，每月 1 号更新，按月份保留历史）:
 *   data/jjwxc/score1000.json                    —— 最新版（前端默认加载）
 *   data/jjwxc/score1000_history/YYYY-MM.json     —— 月度存档
 *   data/jjwxc/score1000_index.json               —— 月份索引 ["2026-08","2026-07",...]
 *
 * 字段命名与 jjwxc.js（月榜）保持一致，前端可复用渲染逻辑。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { withRetry } = require('./retry');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'jjwxc');
const TARGET_COUNT = 1000;
const PAGES_TO_SCRAPE = 10;      // 100 本/页 × 10 = 1000
const BASE_URL = 'https://www.jjwxc.net/bookbase.php?s_typeid=1';
const REQUEST_DELAY = 1200;      // 页间礼貌延时
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.jjwxc.net/',
};

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
function fmtMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function httpGet(url, encoding = 'gbk') {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (redirect.startsWith('/')) {
          const parsed = new URL(url);
          redirect = `${parsed.protocol}//${parsed.host}${redirect}`;
        }
        return httpGet(redirect, encoding).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let data;
        try { data = new (require('util').TextDecoder)(encoding).decode(buffer); }
        catch(e) { data = buffer.toString('utf-8'); }
        resolve({ status: res.statusCode, data });
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function formatScore(n) {
  if (!n) return '0';
  if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'G';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function formatWordCount(n) {
  if (!n || n <= 0) return '';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

// ========== 解析榜单页（复用月榜的分类解析逻辑）==========
function parsePage(html) {
  const books = [];
  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const row of rows) {
    const rowHtml = row[1];
    // 只保留含作品链接的行
    if (!rowHtml.includes('onebook.php')) continue;
    // 跳过表头
    if (rowHtml.includes('作品积分')) continue;

    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 7) continue;

    // 列0: 作者 —— 优先取 <a> 文本内容（bookbase.php 作者列无 title）
    let author = '';
    const authorTextMatch = cells[0]?.match(/<a[^>]*oneauthor\.php[^>]*>([\s\S]*?)<\/a>/);
    if (authorTextMatch) author = authorTextMatch[1].replace(/<[^>]*>/g,'').trim();
    if (!author) author = cells[0].replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').trim();
    const authorIdMatch = cells[0]?.match(/authorid=(\d+)/);
    const authorUrl = authorIdMatch ? `https://www.jjwxc.net/oneauthor.php?authorid=${authorIdMatch[1]}` : '';

    // 列1: 作品名 + novelid
    // 注意：bookbase.php 的 <a title="..."> 存的是 tooltip(简介+标签)，不是书名！
    // 真正的书名在 <a>...</a> 的文本内容里。故优先取标签文本。
    let bookName = '', bookId = '';
    const idMatch = cells[1]?.match(/novelid=(\d+)/);
    if (idMatch) bookId = idMatch[1];
    // 取 onebook 链接的文本内容作为书名
    const nameMatch = cells[1]?.match(/<a[^>]*href="onebook\.php\?novelid=\d+"[^>]*>([\s\S]*?)<\/a>/)
      || cells[1]?.match(/<a[^>]*onebook\.php[^>]*>([\s\S]*?)<\/a>/);
    if (nameMatch) {
      bookName = nameMatch[1].replace(/<[^>]*>/g, '').trim();
    }
    // 若文本为空，退回 title（个别情况）
    if (!bookName) {
      const titleMatch = cells[1]?.match(/<a[^>]*onebook\.php[^>]*title="([^"]*)"/);
      if (titleMatch) bookName = titleMatch[1].split(/简介|标签/)[0].trim();
    }
    bookName = bookName.replace(/&nbsp;/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#\d+;/g,'').trim();
    const bookUrl = bookId ? `https://www.jjwxc.net/onebook.php?novelid=${bookId}` : '';

    // 从作品链接的 title 属性提取【轻量简介 + 精细标签】—— 列表页自带，零额外请求
    // title 格式: "简介：为你，所向披靡！&#10;标签：灵异神怪 情有独钟 仙侠修真 励志 轻松"
    let tooltipIntro = '', fineTags = [];
    const titleAttr = cells[1]?.match(/<a[^>]*onebook\.php[^>]*title="([^"]*)"/);
    if (titleAttr) {
      const raw = titleAttr[1]
        .replace(/&#10;/g, '\n').replace(/&#13;/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const introM = raw.match(/简介[：:]\s*([\s\S]*?)(?:\n|标签[：:]|$)/);
      if (introM) tooltipIntro = introM[1].trim();
      const tagM = raw.match(/标签[：:]\s*([^\n]*)/);
      if (tagM) fineTags = tagM[1].trim().split(/\s+/).filter(t => t && t.length < 12);
    }

    // 列2: 类型 (原创-纯爱-架空历史-爱情-主受)
    const attrText = cells[2]?.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').trim() || '';
    const attrParts = attrText.split('-').map(s => s.trim()).filter(Boolean);

    // 列3: 进度
    const statusText = cells[3]?.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').trim() || '';
    let status = '未知';
    if (statusText.includes('连载')) status = '连载中';
    else if (statusText.includes('完结') || statusText.includes('完成')) status = '完结';

    // 列4: 字数
    const wordCountText = cells[4]?.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').replace(/,/g,'').trim() || '';
    const wordCount = parseInt(wordCountText) || 0;

    // 列5: 作品积分
    const scoreText = cells[5]?.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').replace(/,/g,'').replace(/\s/g,'').trim() || '0';
    const score = parseInt(scoreText) || 0;

    // 列6: 发表时间（首发时间）
    const publishTime = cells[6]?.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').trim() || '';

    // 分类解析（与月榜一致）
    const nature = attrParts[0] || '';   // 原创/衍生
    const genre  = attrParts[1] || '';   // 纯爱/言情/百合/无CP → 主分类
    const era    = attrParts[2] || '';   // 近代现代/架空历史/古色古香/幻想未来
    const theme  = attrParts[3] || '';   // 爱情/剧情/仙侠 等

    const contentTags = [genre, era, theme].filter(Boolean);
    const primaryTag = genre || era || theme || '未分类';
    // 精细标签并入次级标签（去重，排除已有分类词）
    const mergedFine = fineTags.filter(t => !contentTags.includes(t) && t !== nature);
    const secondaryTags = [...contentTags.filter(t => t !== primaryTag), ...mergedFine];
    const allTags = [nature, ...contentTags, ...mergedFine].filter(Boolean);

    let channel = genre || '未知';

    if (bookName && bookName !== '作品') {
      books.push({
        book_id: bookId,
        book_name: bookName,
        author,
        channel,
        nature,
        genre,
        era,
        theme,
        primary_tag: primaryTag,
        secondary_tags: secondaryTags,
        all_tags: allTags,
        score,
        score_display: formatScore(score),
        abstract: tooltipIntro || '',
        status,
        word_count: wordCount > 0 ? formatWordCount(wordCount) : '',
        publish_time: publishTime,   // 首发时间
        thumb_url: '',
        book_url: bookUrl,
        author_url: authorUrl,
      });
    }
  }
  return books;
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`晋江文学城·积分榜 Top1000 爬虫 - ${fmtDateTime(now)}`);
  console.log(`目标: ${TARGET_COUNT} 本 (${PAGES_TO_SCRAPE} 页)`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);

  let allBooks = [];
  let consecutiveEmpty = 0;

  for (let pageNum = 1; pageNum <= PAGES_TO_SCRAPE && allBooks.length < TARGET_COUNT; pageNum++) {
    const url = `${BASE_URL}&page=${pageNum}`;
    process.stdout.write(`  [${pageNum}/${PAGES_TO_SCRAPE}] `);
    try {
      const res = await withRetry(
        () => httpGet(url, 'gbk'),
        { name: `积分榜第${pageNum}页`, maxAttempts: 3, baseDelay: 5000 }
      );
      const pageBooks = parsePage(res.data);
      console.log(`${pageBooks.length} 本 (累计 ${allBooks.length + pageBooks.length})`);
      if (pageBooks.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) { console.log('  ⚠️ 连续3页空，停止'); break; }
      } else {
        consecutiveEmpty = 0;
        allBooks.push(...pageBooks);
      }
    } catch(e) {
      console.log(`失败: ${e.message.slice(0, 80)}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    }
    if (pageNum < PAGES_TO_SCRAPE) await sleep(REQUEST_DELAY + Math.random() * 500);
  }

  allBooks = allBooks.slice(0, TARGET_COUNT);
  console.log(`\n📖 总计抓取: ${allBooks.length} 本`);

  if (allBooks.length === 0) {
    console.log('⚠️ 未抓到任何数据，保留历史数据');
    if (fs.existsSync(path.join(DATA_DIR, 'score1000.json'))) process.exit(0);
    process.exit(1);
  }

  // 附加排名
  const books = allBooks.map((b, i) => ({ rank: i + 1, ...b }));

  // 统计
  const tagStats = {};
  for (const b of books) { tagStats[b.primary_tag] = (tagStats[b.primary_tag] || 0) + 1; }
  const channelStats = {};
  for (const b of books) { channelStats[b.channel] = (channelStats[b.channel] || 0) + 1; }

  const month = fmtMonth(now);
  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    update_month: month,
    total_count: books.length,
    source: '晋江文学城·积分榜Top1000',
    source_url: BASE_URL,
    platform: 'jjwxc',
    platform_name: '晋江文学城',
    rank_type: 'score1000',
    tag_stats: tagStats,
    gender_stats: channelStats,   // 晋江用 channel 代替 gender（与月榜一致）
    books,
  };

  // 1) 最新版
  const latestPath = path.join(DATA_DIR, 'score1000.json');
  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');

  // 2) 月度存档
  const histDir = path.join(DATA_DIR, 'score1000_history');
  ensureDir(histDir);
  const histPath = path.join(histDir, `${month}.json`);
  fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

  // 3) 月份索引（倒序）
  const idxPath = path.join(DATA_DIR, 'score1000_index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
  if (!idx.includes(month)) idx.unshift(month);
  idx.sort((a, b) => b.localeCompare(a));
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 完成！共 ${books.length} 本`);
  console.log(`   频道分布: ${JSON.stringify(channelStats)}`);
  console.log(`   主标签分布: ${JSON.stringify(tagStats)}`);
  console.log(`   最新版: ${latestPath}`);
  console.log(`   月度存档: ${histPath}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  if (fs.existsSync(path.join(__dirname, '..', 'data', 'jjwxc', 'score1000.json'))) {
    console.log('⚠️ 本次失败，但已有历史数据，退出码 0');
    process.exit(0);
  }
  process.exit(1);
});
