/**
 * 晋江文学城月榜爬虫
 * 
 * 数据源: https://www.jjwxc.net/topten.php?orderstr=5&t=0
 * 晋江是传统 HTML 渲染，可以直接用 HTTP 请求 + HTML 解析
 * 
 * 抓取字段: 排名、书名、作者、文章属性（分类标签）、积分、状态
 * 详情页补充: 简介、字数、标签、封面
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { computeRankChange } = require('./rank-change');
const { withRetry } = require('./retry');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'jjwxc');
const TARGET_COUNT = 50;
const RANK_URL = 'https://www.jjwxc.net/topten.php?orderstr=5&t=2';
const REQUEST_DELAY = 800;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Charset': 'utf-8, gbk;q=0.7, gb2312;q=0.7',
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
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function httpGet(url, encoding = 'gbk') {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: HEADERS, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (redirect.startsWith('/')) {
          const parsed = new URL(url);
          redirect = `${parsed.protocol}//${parsed.host}${redirect}`;
        }
        return httpGet(redirect, encoding).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // 晋江使用 GBK 编码
        if (encoding === 'gbk') {
          try {
            const { TextDecoder } = require('util');
            const decoder = new TextDecoder('gbk');
            resolve({ status: res.statusCode, data: decoder.decode(buffer) });
          } catch(e) {
            // fallback: 如果 TextDecoder 不支持 gbk，尝试 utf-8
            resolve({ status: res.statusCode, data: buffer.toString('utf-8') });
          }
        } else {
          resolve({ status: res.statusCode, data: buffer.toString('utf-8') });
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ========== 解析月榜列表页 ==========
function parseRankPage(html) {
  const books = [];
  
  // 晋江月榜表格结构（8列）:
  // 序号 | 作者 | 作品 | 类型 | 进度 | 字数 | 作品积分 | 发表时间
  
  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  let rank = 0;
  
  for (const row of rows) {
    const rowHtml = row[1];
    
    // 跳过表头行（含 "序号"/"作品"/"积分" 等文字但无 <a> 链接）
    if (rowHtml.includes('序号') || rowHtml.includes('作品积分')) continue;
    // 跳过没有作品链接的行
    if (!rowHtml.includes('onebook.php')) continue;
    
    const cells = [];
    const cellMatches = rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    for (const cell of cellMatches) {
      cells.push(cell[1]);
    }
    
    if (cells.length < 7) continue;
    
    rank++;
    if (rank > TARGET_COUNT) break;
    
    // 列0: 排名序号
    const rankNum = parseInt(cells[0]?.replace(/<[^>]*>/g, '').trim()) || rank;
    
    // 列1: 作者 — 从 <a> 标签的 title 属性提取（最可靠）
    const authorTitleMatch = cells[1]?.match(/<a[^>]*title="([^"]*)"/) || cells[1]?.match(/<a[^>]*>([^<]+)<\/a>/);
    const author = authorTitleMatch ? authorTitleMatch[1].trim() : '';
    const authorIdMatch = cells[1]?.match(/authorid=(\d+)/);
    const authorUrl = authorIdMatch ? `https://www.jjwxc.net/oneauthor.php?authorid=${authorIdMatch[1]}` : '';
    
    // 列2: 作品标题 — 从 <a> 标签的 title 属性提取（避免 tooltip 污染）
    const bookTitleMatch = cells[2]?.match(/<a[^>]*href="onebook\.php\?novelid=(\d+)"[^>]*title="([^"]*)"/) 
      || cells[2]?.match(/<a[^>]*title="([^"]*)"[^>]*href="onebook\.php\?novelid=(\d+)"/);
    
    let bookName = '';
    let bookId = '';
    
    if (bookTitleMatch) {
      // 第一个正则: href 在前, groups = [全, novelid, title]
      // 第二个正则: title 在前, groups = [全, title, novelid]
      if (bookTitleMatch[0].indexOf('href') < bookTitleMatch[0].indexOf('title')) {
        bookId = bookTitleMatch[1];
        bookName = bookTitleMatch[2];
      } else {
        bookName = bookTitleMatch[1];
        bookId = bookTitleMatch[2];
      }
    } else {
      // fallback: 直接取 novelid 和 <a> 文字
      const idFallback = cells[2]?.match(/novelid=(\d+)/);
      if (idFallback) bookId = idFallback[1];
      const nameFallback = cells[2]?.match(/<a[^>]*>([^<]+)<\/a>/);
      if (nameFallback) bookName = nameFallback[1].trim();
    }
    
    // 清理书名中可能残留的 HTML 实体
    bookName = bookName.replace(/&nbsp;/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    
    const bookUrl = bookId ? `https://www.jjwxc.net/onebook.php?novelid=${bookId}` : '';
    
    // 列3: 类型 (原创-言情-幻想未来-爱情)
    const attrText = cells[3]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim() || '';
    const attrParts = attrText.split('-').map(s => s.trim()).filter(Boolean);
    
    // 列4: 进度（连载/完结）
    const statusText = cells[4]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim() || '';
    let status = '未知';
    if (statusText.includes('连载')) status = '连载中';
    else if (statusText.includes('完结') || statusText.includes('完成')) status = '完结';
    
    // 列5: 字数
    const wordCountText = cells[5]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/,/g, '').trim() || '';
    const wordCount = parseInt(wordCountText) || 0;
    
    // 列6: 作品积分
    const scoreText = cells[6]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/,/g, '').replace(/\s/g, '').trim() || '0';
    const score = parseInt(scoreText) || 0;
    
    // 列7: 发表时间
    const publishTime = cells[7]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim() || '';
    
    // 分类解析: [性质, 类型, 时代, 题材]
    // 忽略第一个（原创/衍生），以第二个 genre 为主分类
    const nature = attrParts[0] || '';     // 原创/衍生（不计入主分类）
    const genre = attrParts[1] || '';       // 纯爱/言情/百合/无CP → 主分类
    const era = attrParts[2] || '';         // 近代现代/架空历史/古色古香/幻想未来
    const theme = attrParts[3] || '';       // 爱情/剧情/仙侠 等
    
    const contentTags = [genre, era, theme].filter(Boolean);
    const primaryTag = genre || era || theme || '未分类';
    const secondaryTags = contentTags.filter(t => t !== primaryTag);
    const allTags = [nature, ...contentTags].filter(Boolean);
    
    // 频道判断
    let channel = '未知';
    if (genre === '纯爱') channel = '纯爱';
    else if (genre === '言情') channel = '言情';
    else if (genre === '百合') channel = '百合';
    else if (genre === '无CP') channel = '无CP';
    else if (genre === '多元') channel = '多元';
    else channel = genre || '未知';
    
    if (bookName && bookName !== '作品') {
      books.push({
        rank: rankNum,
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
        abstract: '',
        status,
        word_count: wordCount > 0 ? formatWordCount(wordCount) : '',
        update_time: publishTime,
        thumb_url: '',
        book_url: bookUrl,
        author_url: authorUrl,
        rank_change: null,
      });
    }
  }
  
  return books;
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

// ========== 从详情页获取简介、字数、封面 ==========
async function fetchBookDetail(bookUrl, bookId) {
  try {
    const url = bookUrl || `https://www.jjwxc.net/onebook.php?novelid=${bookId}`;
    const res = await httpGet(url, 'gbk');
    const html = res.data;
    const info = {};
    
    // 简介
    const introMatch = html.match(/<div[^>]*id="novelintro"[^>]*>([\s\S]*?)<\/div>/i);
    if (introMatch) {
      info.intro = introMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim()
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 300);
    }
    
    // 字数
    const wordMatch = html.match(/字数[：:]\s*([\d,]+)/);
    if (wordMatch) {
      info.wordCount = wordMatch[1].replace(/,/g, '');
    }
    
    // 封面图
    const coverMatch = html.match(/<img[^>]*class="noveldefaultimage"[^>]*src="([^"]*)"/)
      || html.match(/novelimage[^>]*src="([^"]*)"/);
    if (coverMatch) {
      let coverUrl = coverMatch[1];
      if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;
      info.thumbUrl = coverUrl;
    }
    
    // 状态
    if (html.includes('完结') || html.includes('[已完成]')) {
      info.status = '完结';
    } else if (html.includes('连载') || html.includes('[连载中]')) {
      info.status = '连载中';
    }
    
    // 额外标签（详情页可能有更多标签）
    const tagMatches = html.matchAll(/<a[^>]*class="[^"]*bluetip[^"]*"[^>]*>([^<]+)<\/a>/gi);
    const extraTags = [];
    for (const m of tagMatches) {
      const t = m[1].trim();
      if (t && t.length < 10) extraTags.push(t);
    }
    if (extraTags.length > 0) info.extraTags = extraTags;
    
    return info;
  } catch(e) {
    console.log(`    [WARN] 详情页失败: ${e.message}`);
    return null;
  }
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`晋江文学城月榜爬虫 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  // 阶段一：抓取月榜列表
  console.log('\n📊 阶段一：抓取月榜列表');
  let res;
  try {
    res = await withRetry(() => httpGet(RANK_URL, 'gbk'), { name: '晋江月榜', maxAttempts: 3, baseDelay: 5000 });
  } catch(e) {
    console.error('  获取榜单失败（重试后仍失败）:', e.message);
    process.exit(1);
  }
  
  const listBooks = parseRankPage(res.data);
  console.log(`  解析到 ${listBooks.length} 本`);
  
  if (listBooks.length === 0) {
    console.log('  [ERROR] 未能解析到任何书籍数据！');
    console.log('  尝试保存原始 HTML 用于调试...');
    fs.writeFileSync(path.join(DATA_DIR, 'debug_rank_page.html'), res.data, 'utf-8');
    
    // 如果有历史数据就不报错
    const latestPath = path.join(DATA_DIR, 'latest.json');
    if (fs.existsSync(latestPath)) {
      console.log('  已有历史数据，跳过本次');
      process.exit(0);
    }
    process.exit(1);
  }

  // 阶段二：获取详情
  console.log(`\n📖 阶段二：获取 ${listBooks.length} 本书详情`);
  
  for (let i = 0; i < listBooks.length; i++) {
    const book = listBooks[i];
    process.stdout.write(`  [${i+1}/${listBooks.length}] ${book.book_name} `);
    
    if (book.book_id) {
      const detail = await fetchBookDetail(book.book_url, book.book_id);
      if (detail) {
        if (detail.intro) book.abstract = detail.intro;
        if (detail.wordCount) book.word_count = detail.wordCount;
        if (detail.thumbUrl) book.thumb_url = detail.thumbUrl;
        if (detail.status && book.status === '未知') book.status = detail.status;
        if (detail.extraTags?.length > 0) {
          for (const t of detail.extraTags) {
            if (!book.all_tags.includes(t)) {
              book.all_tags.push(t);
              book.secondary_tags.push(t);
            }
          }
        }
        process.stdout.write('✓');
      } else {
        process.stdout.write('✗');
      }
    }
    
    console.log(` [${book.primary_tag}]`);
    if (i < listBooks.length - 1) await sleep(REQUEST_DELAY);
  }

  // 阶段三：计算排名变化
  console.log('\n📈 阶段三：计算排名变化（严格新书：全 history 比对）');
  computeRankChange(listBooks, DATA_DIR, fmtDate(now), 'book_id');

  const latestPath = path.join(DATA_DIR, 'latest.json');

  // 统计
  const tagStats = {};
  for (const b of listBooks) { tagStats[b.primary_tag] = (tagStats[b.primary_tag] || 0) + 1; }
  const channelStats = {};
  for (const b of listBooks) { channelStats[b.channel] = (channelStats[b.channel] || 0) + 1; }

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: listBooks.length,
    source: '晋江文学城·积分月榜',
    source_url: RANK_URL,
    platform: 'jjwxc',
    platform_name: '晋江文学城',
    tag_stats: tagStats,
    gender_stats: channelStats,  // 晋江用 channel 代替 gender
    books: listBooks,
  };

  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');
  const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
  fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

  // 更新历史索引
  const idxPath = path.join(DATA_DIR, 'history_index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
  const today = fmtDate(now);
  if (!idx.includes(today)) idx.unshift(today);
  idx = idx.slice(0, 90);
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 完成！共 ${listBooks.length} 本`);
  console.log(`   频道分布: ${JSON.stringify(channelStats)}`);
  console.log(`   主标签分布: ${JSON.stringify(tagStats)}`);
  console.log(`   数据: ${latestPath}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  const latestPath = path.join(__dirname, '..', 'data', 'jjwxc', 'latest.json');
  if (fs.existsSync(latestPath)) {
    console.log('⚠️ 本次运行失败，但已有历史数据可用，退出码 0');
    process.exit(0);
  } else {
    process.exit(1);
  }
});
