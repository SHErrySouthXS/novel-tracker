/**
 * 长佩文学 畅销榜爬虫
 * 
 * 数据源: https://www.gongzicp.com/home/ranking
 * 长佩是 Vue SPA，需要用 Playwright 渲染后抓取
 * 
 * DOM 结构: .novel-item > img区 + .novel区
 *   链接顺序: [状态badge, 书名, 作者, 状态text, 标签1, 标签2, ...]
 *   简介: <p> 标签内
 *   分页: .pages > .page (每页10本，共10页)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { computeRankChange } = require('./rank-change');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'changpei');
const TARGET_COUNT = 50;
const RANK_URL = 'https://www.gongzicp.com/home/ranking';

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
        // 清理：去掉开头的类型标签描述（如"竹马竹马（10-15w）"）
        abstract = abstract.replace(/^[^\n]*?[（(]\d+-\d+w[）)]\s*/, '');
        // 去掉换行，合并为空格
        abstract = abstract.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        // 截取到200字
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

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`长佩文学 畅销榜爬虫 - ${fmtDateTime(now)}`);
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
    // 阶段一：抓取榜单
    console.log('\n📊 阶段一：抓取畅销榜');
    await page.goto(RANK_URL, { waitUntil: 'networkidle', timeout: 30000 });
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
      console.log('  [ERROR] 未能提取到任何书籍数据！');
      await page.screenshot({ path: path.join(DATA_DIR, 'debug_screenshot.png'), fullPage: true });
      process.exit(1);
    }
    
    console.log(`\n  ✅ 共提取 ${allBooks.length} 本`);

    // 计算排名变化
    console.log('\n📈 计算排名变化');
    computeRankChange(allBooks, DATA_DIR, fmtDate(now), 'book_name');

    // 统计
    const tagStats = {};
    for (const b of allBooks) {
      if (b.all_tags.length > 0) tagStats[b.all_tags[0]] = (tagStats[b.all_tags[0]] || 0) + 1;
    }
    const statusStats = {};
    for (const b of allBooks) { statusStats[b.status] = (statusStats[b.status] || 0) + 1; }

    const result = {
      update_time: fmtDateTime(now),
      update_date: fmtDate(now),
      total_count: allBooks.length,
      source: '长佩文学·畅销榜',
      source_url: RANK_URL,
      platform: 'changpei',
      platform_name: '长佩文学',
      tag_stats: tagStats,
      status_stats: statusStats,
      books: allBooks,
    };

    const latestPath = path.join(DATA_DIR, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');
    const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
    fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

    const idxPath = path.join(DATA_DIR, 'history_index.json');
    let idx = [];
    if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
    const today = fmtDate(now);
    if (!idx.includes(today)) idx.unshift(today);
    idx = idx.slice(0, 90);
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 完成！共 ${allBooks.length} 本`);
    console.log(`   状态: ${JSON.stringify(statusStats)}`);
    console.log(`   标签: ${JSON.stringify(tagStats)}`);
    console.log(`   数据: ${latestPath}`);
    console.log(`\n   前5本:`);
    allBooks.slice(0, 5).forEach(b => {
      const abs = b.abstract ? b.abstract.substring(0, 40) + '...' : '无简介';
      console.log(`   ${b.rank}. ${b.book_name} - ${b.author} [${b.status}] ${abs}`);
    });

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
