/**
 * 起点中文网每日畅销榜爬虫 (Playwright 版 v2)
 * 
 * 改进：
 * - 更强的反检测配置（stealth headers, viewport, webdriver override）
 * - 详细日志便于调试
 * - 从列表页直接提取完整数据（减少详情页请求）
 */

const { chromium } = require('playwright');
const { computeRankChange } = require('./rank-change');
const { withRetry } = require('./retry');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'qidian');
const TARGET_COUNT = 50;
const BASE_URL = 'https://www.qidian.com/rank/hotsales/';

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

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`起点中文网畅销榜爬虫 v2 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  // 注入反检测脚本
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    let allBooks = [];

    // 起点畅销榜每页约20本，抓3页
    for (let pageNum = 1; pageNum <= 3 && allBooks.length < TARGET_COUNT; pageNum++) {
      const url = pageNum === 1 ? BASE_URL : `${BASE_URL}page${pageNum}/`;
      console.log(`\n📊 第${pageNum}页: ${url}`);
      
      await withRetry(
        () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }),
        { name: `起点第${pageNum}页`, maxAttempts: 3, baseDelay: 5000 }
      );
      
      // 等待内容加载
      try {
        await page.waitForSelector('.book-img-text li, .rank-body li, .book-list li, [class*="book"]', { timeout: 10000 });
      } catch(e) {
        console.log('  等待选择器超时，尝试延时后继续...');
      }
      await sleep(3000);
      
      // 调试：打印页面标题和元素数量
      const title = await page.title();
      console.log(`  页面标题: ${title}`);
      
      const pageBooks = await page.evaluate(() => {
        const items = [];
        
        // 起点畅销榜的常见结构
        const bookElements = document.querySelectorAll('.book-img-text ul li');
        console.log(`找到 book-img-text li: ${bookElements.length}`);
        
        if (bookElements.length === 0) {
          // 尝试其他选择器
          const altElements = document.querySelectorAll('.rank-body .book-list .book-item, .rank-list li, [class*="rankList"] li');
          console.log(`备选选择器: ${altElements.length}`);
        }
        
        bookElements.forEach((el) => {
          try {
            const nameEl = el.querySelector('h2 a, h4 a, .book-mid-info h2 a, .book-mid-info h4 a');
            const bookName = nameEl ? nameEl.textContent.trim() : '';
            const bookUrl = nameEl ? nameEl.href || nameEl.getAttribute('href') || '' : '';
            
            let bookId = '';
            const idMatch = bookUrl.match(/\/book\/(\d+)/) || bookUrl.match(/\/(\d+)\/?$/);
            if (idMatch) bookId = idMatch[1];
            
            // 作者（在 .author 下面找 .name）
            const authorEl = el.querySelector('.author .name, .author > a:first-child, p.author a.name');
            const author = authorEl ? authorEl.textContent.trim() : '';
            
            // 分类标签
            const tags = [];
            // 作者行通常有: 作者名 | 分类 | 状态
            const authorP = el.querySelector('.author, p.author');
            if (authorP) {
              const allLinks = authorP.querySelectorAll('a');
              allLinks.forEach(a => {
                const t = a.textContent.trim();
                if (t && t !== author && t.length < 10) tags.push(t);
              });
              const spans = authorP.querySelectorAll('span');
              spans.forEach(s => {
                const t = s.textContent.trim();
                if (t && !['|', '·'].includes(t) && t.length < 10) tags.push(t);
              });
            }
            
            // 简介
            const introEl = el.querySelector('.intro, .book-mid-info .intro, p.intro');
            const intro = introEl ? introEl.textContent.trim() : '';
            
            // 更新信息
            const updateEl = el.querySelector('.update, p.update');
            let wordCount = '';
            let status = '连载中';
            if (updateEl) {
              const updateText = updateEl.textContent;
              const wcMatch = updateText.match(/([\d.]+万字)/);
              if (wcMatch) wordCount = wcMatch[1];
              if (updateText.includes('完本') || updateText.includes('完结')) status = '完结';
            }
            
            // 封面
            const imgEl = el.querySelector('img');
            let thumbUrl = '';
            if (imgEl) {
              thumbUrl = imgEl.src || imgEl.getAttribute('data-src') || '';
              if (thumbUrl.startsWith('//')) thumbUrl = 'https:' + thumbUrl;
            }
            
            if (bookName) {
              items.push({ bookName, bookId, bookUrl, author, tags, intro, wordCount, status, thumbUrl });
            }
          } catch(e) {}
        });
        
        return items;
      });
      
      console.log(`  抓到: ${pageBooks.length} 本`);
      
      if (pageBooks.length === 0) {
        // 保存页面 HTML 用于调试
        const html = await page.content();
        const debugPath = path.join(DATA_DIR, `debug_page${pageNum}.html`);
        fs.writeFileSync(debugPath, html, 'utf-8');
        console.log(`  ⚠️ 空结果，已保存调试 HTML: ${debugPath}`);
        
        // 打印页面中找到的一些关键元素
        const debugInfo = await page.evaluate(() => {
          return {
            body_length: document.body.innerHTML.length,
            all_li: document.querySelectorAll('li').length,
            all_a: document.querySelectorAll('a').length,
            has_rank: !!document.querySelector('[class*="rank"]'),
            has_book: !!document.querySelector('[class*="book"]'),
            classes: Array.from(new Set([...document.querySelectorAll('[class]')].map(e => e.className).filter(c => /book|rank/i.test(c)))).slice(0, 20),
          };
        });
        console.log(`  调试信息:`, JSON.stringify(debugInfo, null, 2));
      }
      
      allBooks.push(...pageBooks);
      if (pageNum < 3) await sleep(2000);
    }

    allBooks = allBooks.slice(0, TARGET_COUNT);
    console.log(`\n📖 总计: ${allBooks.length} 本`);

    if (allBooks.length === 0) {
      console.log('⚠️ 未抓到任何数据（可能被反爬），保留历史数据');
      const latestPath = path.join(DATA_DIR, 'latest.json');
      if (fs.existsSync(latestPath)) {
        console.log('  已有历史数据可用');
        process.exit(0);
      }
      process.exit(1);
    }

    // 构建最终数据
    const books = allBooks.map((raw, i) => {
      // 先从 tags 中识别完结状态
      let status = raw.status || '连载中';
      if (raw.tags.some(t => ['完本', '完结'].includes(t))) {
        status = '完结';
      }
      
      const allTags = raw.tags.filter(t => 
        !['连载', '完本', '完结', '连载中', '签约', 'VIP', '免费', '|'].includes(t)
      );
      const primaryTag = allTags[0] || '未分类';
      const secondaryTags = allTags.slice(1);

      // 频道判断
      let gender = '未知';
      const maleKws = ['玄幻', '仙侠', '武侠', '科幻', '都市', '游戏', '军事', '历史', '体育', '悬疑', '轻小说'];
      const femaleKws = ['古代言情', '现代言情', '幻想言情', '浪漫青春'];
      if (allTags.some(t => maleKws.some(k => t.includes(k)))) gender = '男频';
      else if (allTags.some(t => femaleKws.some(k => t.includes(k)))) gender = '女频';

      return {
        rank: i + 1,
        book_id: raw.bookId,
        book_name: raw.bookName,
        author: raw.author,
        gender,
        primary_tag: primaryTag,
        secondary_tags: secondaryTags,
        all_tags: allTags,
        abstract: raw.intro || '暂无简介',
        status,
        word_count: raw.wordCount || '',
        thumb_url: raw.thumbUrl || '',
        book_url: raw.bookUrl || `https://www.qidian.com/book/${raw.bookId}/`,
        rank_change: null,
      };
    });

    // 计算排名变化
    console.log('\n📈 计算排名变化（严格新书：全 history 比对）');
    computeRankChange(books, DATA_DIR, fmtDate(now), 'book_id');

    const latestPath = path.join(DATA_DIR, 'latest.json');

    // 统计
    const tagStats = {};
    for (const b of books) { tagStats[b.primary_tag] = (tagStats[b.primary_tag] || 0) + 1; }
    const genderStats = {};
    for (const b of books) { genderStats[b.gender] = (genderStats[b.gender] || 0) + 1; }

    const result = {
      update_time: fmtDateTime(now),
      update_date: fmtDate(now),
      total_count: books.length,
      source: '起点中文网·每日畅销榜',
      source_url: BASE_URL,
      platform: 'qidian',
      platform_name: '起点中文网',
      tag_stats: tagStats,
      gender_stats: genderStats,
      books,
    };

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
    console.log(`🎉 完成！共 ${books.length} 本`);
    console.log(`   性别: ${JSON.stringify(genderStats)}`);
    console.log(`   标签: ${JSON.stringify(tagStats)}`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('致命错误:', e);
  const latestPath = path.join(__dirname, '..', 'data', 'qidian', 'latest.json');
  if (fs.existsSync(latestPath)) {
    console.log('⚠️ 失败但有历史数据，退出码 0');
    process.exit(0);
  } else {
    process.exit(1);
  }
});
