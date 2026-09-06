/**
 * 起点中文网·完本收藏榜爬虫 (Playwright)
 * 
 * 目标：https://www.qidian.com/finish/orderId11-/
 * 爬取前 1000 本（50 页 × 20 本/页）
 * 字段：排名、书名、作者、总收藏数、字数、完结状态、简介、标签、封面、链接
 * 
 * 输出：
 *   data/qidian/collection.json                    —— 最新版（前端默认加载）
 *   data/qidian/collection_history/YYYY-MM.json     —— 月度存档
 *   data/qidian/collection_index.json               —— 月份索引 ["2026-08","2026-07",...]
 * 每月 1 号更新一次，历史按月份保留可回溯查询。
 */

const { chromium } = require('playwright');
const { withRetry } = require('./retry');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'qidian');
const TARGET_COUNT = 1000;
const PAGES_TO_SCRAPE = 50;
const BASE_URL = 'https://www.qidian.com/finish/orderId11-/';

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

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`起点中文网·完本收藏榜爬虫 - ${fmtDateTime(now)}`);
  console.log(`目标: ${TARGET_COUNT} 本 (${PAGES_TO_SCRAPE} 页)`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);

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

  // 反检测
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    let allBooks = [];
    let consecutiveEmpty = 0;

    for (let pageNum = 1; pageNum <= PAGES_TO_SCRAPE && allBooks.length < TARGET_COUNT; pageNum++) {
      const url = pageNum === 1 ? BASE_URL : `${BASE_URL}page${pageNum}/`;
      process.stdout.write(`  [${pageNum}/${PAGES_TO_SCRAPE}] `);

      try {
        await withRetry(
          () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }),
          { name: `收藏榜第${pageNum}页`, maxAttempts: 3, baseDelay: 5000 }
        );

        // 等待内容加载
        try {
          await page.waitForSelector('.book-img-text li, .rank-body li, [class*="book"] li', { timeout: 10000 });
        } catch(e) {
          // 选择器超时，延时后继续
        }
        await sleep(2000);

        const pageBooks = await page.evaluate(() => {
          const items = [];
          const bookElements = document.querySelectorAll('.book-img-text ul li');

          bookElements.forEach((el) => {
            try {
              // 书名 + 链接
              const nameEl = el.querySelector('h2 a, h4 a, .book-mid-info h2 a, .book-mid-info h4 a');
              const bookName = nameEl ? nameEl.textContent.trim() : '';
              const bookUrl = nameEl ? (nameEl.href || nameEl.getAttribute('href') || '') : '';

              let bookId = '';
              const idMatch = bookUrl.match(/\/book\/(\d+)/) || bookUrl.match(/\/(\d+)\/?$/);
              if (idMatch) bookId = idMatch[1];

              // 作者
              const authorEl = el.querySelector('.author .name, .author > a:first-child, p.author a.name');
              const author = authorEl ? authorEl.textContent.trim() : '';

              // 分类标签
              const tags = [];
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

              // 字数 + 状态
              const updateEl = el.querySelector('.update, p.update');
              let wordCount = '';
              let status = '完结';  // 这是完本榜，默认完结
              if (updateEl) {
                const updateText = updateEl.textContent;
                const wcMatch = updateText.match(/([\d.]+万字)/);
                if (wcMatch) wordCount = wcMatch[1];
                if (updateText.includes('连载')) status = '连载中';
              }

              // 收藏数 — 起点完本榜按收藏排序，收藏数可能在不同位置
              // 通常在 .book-right-info 或者 .intro 附近
              let collections = '';
              // 尝试从 .total 或数字区域提取
              const totalEl = el.querySelector('.total, .book-right-info .total, [class*="count"], [class*="collect"]');
              if (totalEl) {
                const numMatch = totalEl.textContent.match(/([\d,.]+万?)/);
                if (numMatch) collections = numMatch[1];
              }
              // 如果上面没抓到，尝试从所有文本中找 "总收藏" 相关
              if (!collections) {
                const allText = el.textContent;
                const collMatch = allText.match(/总收藏[：:]?\s*([\d,.]+万?)/);
                if (collMatch) collections = collMatch[1];
              }

              // 封面
              const imgEl = el.querySelector('img');
              let thumbUrl = '';
              if (imgEl) {
                thumbUrl = imgEl.src || imgEl.getAttribute('data-src') || '';
                if (thumbUrl.startsWith('//')) thumbUrl = 'https:' + thumbUrl;
              }

              if (bookName) {
                items.push({ bookName, bookId, bookUrl, author, tags, intro, wordCount, status, collections, thumbUrl });
              }
            } catch(e) {}
          });

          return items;
        });

        console.log(`${pageBooks.length} 本 (累计 ${allBooks.length + pageBooks.length})`);

        if (pageBooks.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 3) {
            console.log('\n  ⚠️ 连续3页空结果，停止爬取');
            break;
          }
          // 保存调试信息
          if (pageNum <= 3) {
            const html = await page.content();
            fs.writeFileSync(path.join(DATA_DIR, `debug_collection_page${pageNum}.html`), html, 'utf-8');
          }
        } else {
          consecutiveEmpty = 0;
          allBooks.push(...pageBooks);
        }

      } catch(e) {
        console.log(`失败: ${e.message.slice(0, 80)}`);
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
      }

      // 礼貌延时，避免触发反爬
      if (pageNum < PAGES_TO_SCRAPE) {
        const delay = 2000 + Math.random() * 1000;
        await sleep(delay);
      }
    }

    await browser.close();

    allBooks = allBooks.slice(0, TARGET_COUNT);
    console.log(`\n📖 总计抓取: ${allBooks.length} 本`);

    if (allBooks.length === 0) {
      console.log('⚠️ 未抓到任何数据，保留历史数据');
      process.exit(0);
    }

    // 构建最终数据
    const books = allBooks.map((raw, i) => {
      const allTags = raw.tags.filter(t =>
        !['连载', '完本', '完结', '连载中', '签约', 'VIP', '免费', '|'].includes(t)
      );
      const primaryTag = allTags[0] || '未分类';
      const secondaryTags = allTags.slice(1);

      // 性别频道判断
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
        status: raw.status,
        word_count: raw.wordCount || '',
        collections: raw.collections || '',
        thumb_url: raw.thumbUrl || '',
        book_url: raw.bookUrl || '',
      };
    });

    // 标签统计
    const tagStats = {};
    for (const b of books) { tagStats[b.primary_tag] = (tagStats[b.primary_tag] || 0) + 1; }
    const genderStats = {};
    for (const b of books) { genderStats[b.gender] = (genderStats[b.gender] || 0) + 1; }

    const month = fmtMonth(now);
    const result = {
      update_time: fmtDateTime(now),
      update_date: fmtDate(now),
      update_month: month,
      total_count: books.length,
      source: '起点中文网·完本收藏榜',
      source_url: BASE_URL,
      platform: 'qidian',
      platform_name: '起点中文网',
      rank_type: 'collection',
      tag_stats: tagStats,
      gender_stats: genderStats,
      books,
    };

    // 1) 最新版（前端默认加载，兼容旧逻辑）
    const outputPath = path.join(DATA_DIR, 'collection.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

    // 2) 月度存档
    const histDir = path.join(DATA_DIR, 'collection_history');
    ensureDir(histDir);
    const histPath = path.join(histDir, `${month}.json`);
    fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

    // 3) 月份索引（倒序，最新在前）
    const idxPath = path.join(DATA_DIR, 'collection_index.json');
    let idx = [];
    if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
    if (!idx.includes(month)) idx.unshift(month);
    idx.sort((a, b) => b.localeCompare(a));
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 完成！共 ${books.length} 本`);
    console.log(`   性别分布: ${JSON.stringify(genderStats)}`);
    console.log(`   主标签分布: ${JSON.stringify(tagStats)}`);
    console.log(`   最新版: ${outputPath}`);
    console.log(`   月度存档: ${histPath}`);

  } catch(e) {
    await browser.close();
    throw e;
  }
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
