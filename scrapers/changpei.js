/**
 * 长佩文学 多榜单爬虫
 * 
 * 抓取:
 *   1. 总榜畅销榜 Top50
 *   2. 纯爱-畅销榜 Top50
 *   3. 纯爱-新书榜 Top50
 *   4. 纯爱-完结榜 Top50
 * 
 * 数据源: https://www.gongzicp.com/home/ranking (总榜)
 *         https://www.gongzicp.com/home/indexRanking?tid=75 (纯爱)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { computeRankChange } = require('./rank-change');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'changpei');
const TARGET_COUNT = 50;

// 榜单配置
const RANKINGS = [
  { id: 'bestseller', name: '总榜·畅销榜', url: 'https://www.gongzicp.com/home/ranking', file: 'latest.json' },
  { id: 'purelove_bestseller', name: '纯爱·畅销榜', url: 'https://www.gongzicp.com/home/indexRanking?tid=75&rid=1', file: 'purelove_bestseller.json' },
  { id: 'purelove_new', name: '纯爱·新书榜', url: 'https://www.gongzicp.com/home/indexRanking?tid=75&rid=7', file: 'purelove_new.json' },
  { id: 'purelove_completed', name: '纯爱·完结榜', url: 'https://www.gongzicp.com/home/indexRanking?tid=75&rid=5', file: 'purelove_completed.json' },
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

// ========== 从页面 DOM 提取当前页书籍 ==========
async function extractBooksFromDOM(page) {
  return await page.evaluate(() => {
    const items = document.querySelectorAll('.novel-item');
    const books = [];
    
    items.forEach((item, idx) => {
      const links = item.querySelectorAll('a');
      const metaDiv = item.querySelector('.novel');
      const metaText = metaDiv?.textContent || '';
      
      // 提取简介（<p> 标签内）
      const pEl = item.querySelector('p');
      let abstract = '';
      if (pEl) {
        abstract = pEl.textContent.trim();
        abstract = abstract.replace(/^[^\n]*?[（(]\d+-\d+w[）)]\s*/, '');
        abstract = abstract.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        abstract = abstract.substring(0, 200);
      }
      
      if (links.length < 3) return;
      
      const linkData = Array.from(links).map(a => ({
        text: a.textContent.trim(),
        href: a.href || '',
      }));
      
      const meaningful = linkData.filter(l => 
        l.text && l.text !== '连载' && l.text !== '完结'
      );
      
      let bookName = '', author = '', bookUrl = '', authorUrl = '', status = '连载中';
      const tags = [];
      
      if (meaningful.length >= 2) {
        bookName = meaningful[0].text;
        bookUrl = meaningful[0].href;
        author = meaningful[1].text;
        authorUrl = meaningful[1].href;
      } else if (meaningful.length === 1) {
        bookName = meaningful[0].text;
        bookUrl = meaningful[0].href;
      }
      
      if (linkData.some(l => l.text === '完结')) status = '完结';
      
      const usedSet = new Set([bookName, author]);
      for (const l of linkData) {
        if (l.text && !usedSet.has(l.text) && l.text !== '连载' && l.text !== '完结' && l.text.length < 15) {
          tags.push(l.text);
          usedSet.add(l.text);
        }
      }
      
      const wordMatch = metaText.match(/字数:\s*([\d.]+万?)/);
      const wordCount = wordMatch ? wordMatch[1] : '';
      const popMatch = metaText.match(/人气:\s*([\d,.]+万?)/);
      const popularity = popMatch ? popMatch[1] : '';
      const updateMatch = metaText.match(/更新时间:\s*(.+?)$/);
      const updateTime = updateMatch ? updateMatch[1].trim() : '';
      
      if (bookName) {
        books.push({
          rank: 0,
          book_name: bookName,
          book_url: bookUrl || '',
          author,
          author_url: authorUrl || '',
          tags,
          all_tags: tags,
          primary_tag: tags[0] || '',
          abstract,
          word_count: wordCount,
          popularity,
          status,
          update_time: updateTime,
          channel: '',
          gender: '',
        });
      }
    });
    
    return books;
  });
}

// ========== 抓取单个榜单 ==========
async function scrapeRanking(page, ranking, now) {
  console.log(`\n📊 抓取: ${ranking.name}`);
  await page.goto(ranking.url, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3000);
  
  let allBooks = [];
  const totalPages = Math.ceil(TARGET_COUNT / 10);
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`  📄 第 ${pageNum} 页...`);
    
    const pageBooks = await extractBooksFromDOM(page);
    allBooks = allBooks.concat(pageBooks);
    console.log(`    本页 ${pageBooks.length} 本，累计 ${allBooks.length} 本`);
    
    if (allBooks.length >= TARGET_COUNT) break;
    
    if (pageNum < totalPages) {
      const nextPageNum = String(pageNum + 1);
      const clicked = await page.evaluate((targetNum) => {
        const pages = document.querySelectorAll('.pages .page');
        for (const p of pages) {
          if (p.textContent.trim() === targetNum) {
            p.click();
            return true;
          }
        }
        return false;
      }, nextPageNum);
      
      if (clicked) {
        await sleep(2000);
        await page.waitForSelector('.novel-item', { timeout: 10000 }).catch(() => {});
        await sleep(1000);
      } else {
        break;
      }
    }
  }
  
  allBooks = allBooks.slice(0, TARGET_COUNT);
  allBooks.forEach((b, i) => b.rank = i + 1);
  
  if (allBooks.length === 0) {
    console.log(`  [WARN] ${ranking.name} 未提取到数据`);
    return null;
  }
  
  // 计算排名变化
  computeRankChange(allBooks, DATA_DIR, fmtDate(now), 'book_name');
  
  // 统计
  const tagStats = {};
  for (const b of allBooks) {
    if (b.all_tags.length > 0) tagStats[b.all_tags[0]] = (tagStats[b.all_tags[0]] || 0) + 1;
  }
  const statusStats = {};
  for (const b of allBooks) { statusStats[b.status] = (statusStats[b.status] || 0) + 1; }

  // 题材洞察分析
  // 1. 蓝海题材：人气高但竞争少的 tag（上榜<3本，平均人气>整体中位数）
  const tagPopularity = {};
  for (const b of allBooks) {
    const pop = parseFloat(b.popularity.replace(/,/g, '')) || 0;
    for (const tag of b.all_tags) {
      if (!tagPopularity[tag]) tagPopularity[tag] = [];
      tagPopularity[tag].push(pop);
    }
  }
  const allPops = allBooks.map(b => parseFloat(b.popularity.replace(/,/g, '')) || 0).sort((a,b) => b-a);
  const medianPop = allPops[Math.floor(allPops.length / 2)] || 0;
  const blueOcean = [];
  for (const [tag, pops] of Object.entries(tagPopularity)) {
    const avg = pops.reduce((s,v) => s+v, 0) / pops.length;
    if (pops.length <= 3 && avg > medianPop * 1.5) {
      blueOcean.push({ tag, count: pops.length, avg_popularity: Math.round(avg) });
    }
  }
  blueOcean.sort((a,b) => b.avg_popularity - a.avg_popularity);

  // 2. 爆款新书：rank_change === 'new' 的书
  const viralBooks = allBooks.filter(b => b.rank_change === 'new').map(b => ({
    rank: b.rank,
    book_name: b.book_name,
    author: b.author,
    tags: b.all_tags,
    word_count: b.word_count,
    popularity: b.popularity,
    abstract: b.abstract,
  }));

  // 3. 题材趋势（读历史数据计算）
  const trendData = { tag_trends_7d: {}, tag_trends_30d: {} };
  try {
    const histDir = path.join(DATA_DIR, 'history');
    if (fs.existsSync(histDir)) {
      const histFiles = fs.readdirSync(histDir).filter(f => f.endsWith('.json')).sort().reverse();
      const todayStr = fmtDate(now);
      
      for (const daysBack of [7, 30]) {
        const targetDate = new Date(now.getTime() - daysBack * 86400000);
        const targetStr = fmtDate(targetDate);
        const histFile = histFiles.find(f => f.replace('.json', '') <= targetStr);
        
        if (histFile && histFile.replace('.json', '') !== todayStr) {
          try {
            const histData = JSON.parse(fs.readFileSync(path.join(histDir, histFile), 'utf-8'));
            const histTagStats = histData.rankings?.[ranking.id]?.tag_stats || {};
            const trends = {};
            
            for (const [tag, count] of Object.entries(tagStats)) {
              const histCount = histTagStats[tag] || 0;
              trends[tag] = { current: count, previous: histCount, change: count - histCount };
            }
            
            if (daysBack === 7) trendData.tag_trends_7d = trends;
            else trendData.tag_trends_30d = trends;
          } catch(e) {}
        }
      }
    }
  } catch(e) {}

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: allBooks.length,
    source: `长佩文学·${ranking.name}`,
    source_url: ranking.url,
    platform: 'changpei',
    platform_name: '长佩文学',
    ranking_id: ranking.id,
    ranking_name: ranking.name,
    tag_stats: tagStats,
    status_stats: statusStats,
    books: allBooks,
    // 题材洞察
    insights: {
      blue_ocean: blueOcean.slice(0, 5),
      viral_books: viralBooks,
      tag_trends_7d: trendData.tag_trends_7d,
      tag_trends_30d: trendData.tag_trends_30d,
    },
  };
  
  // 保存文件
  const filePath = path.join(DATA_DIR, ranking.file);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  
  console.log(`  ✅ ${ranking.name}: ${allBooks.length} 本`);
  return result;
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`长佩文学 多榜单爬虫 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  // 启动浏览器
  console.log('\n🌐 启动浏览器...');
  const launchOpts = { 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  const localChrome = '/home/ubuntu/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
  if (fs.existsSync(localChrome)) {
    launchOpts.executablePath = localChrome;
    launchOpts.proxy = { server: 'socks5://127.0.0.1:7890' };
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    // 抓取所有榜单
    const results = [];
    for (const ranking of RANKINGS) {
      const result = await scrapeRanking(page, ranking, now);
      if (result) results.push(result);
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
    await page.screenshot({ path: path.join(DATA_DIR, 'debug_error.png'), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
