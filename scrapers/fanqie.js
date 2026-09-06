/**
 * 番茄小说热门榜单爬虫 v4 (novel-tracker 版)
 * 
 * 标签获取策略（按优先级）：
 * 1. top_book_list/v1 API → category 字段（未加密，覆盖部分热门书）
 * 2. 按分类遍历 book_list API → book_id→category 映射
 * 3. Playwright 详情页 → 直接从渲染后 DOM 抓取标签（兜底，最准确）
 * 4. 关键词推断 → 基于书名+简介匹配分类规则（最终兜底）
 * 
 * 其他数据源：
 * - category_list/v0 API → 分类名→性别频道映射
 * - book_list/v0 API → 排名顺序（按最热排序）
 * - 详情页 meta 标签 → 简介、作者确认
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { computeRankChange } = require('./rank-change');
const { withRetry } = require('./retry');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'fanqie');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const TARGET_COUNT = 50;
const PAGE_SIZE = 18;
const REQUEST_DELAY = 600;

// ========== 工具函数 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

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

// ========== 步骤1: 获取分类 → 性别映射 ==========
async function buildCategoryGenderMap() {
  console.log('  获取分类列表...');
  const map = {};
  for (const g of [1, 0]) {
    try {
      const url = `https://fanqienovel.com/api/author/book/category_list/v0/?gender=${g}`;
      const res = await httpGet(url, { Accept: 'application/json' });
      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data) {
        for (const cat of json.data) {
          map[cat.name] = { gender: g === 1 ? '男频' : '女频', id: cat.category_id };
        }
      }
    } catch (e) { console.log(`  [WARN] 分类获取失败(g=${g}): ${e.message}`); }
    await sleep(300);
  }
  return map;
}

// ========== 步骤2: 获取热榜排名列表 ==========
async function fetchHotRankList() {
  console.log('  获取热榜排名...');
  const allBooks = [];
  const pagesNeeded = Math.ceil(TARGET_COUNT / PAGE_SIZE);
  for (let page = 0; page < pagesNeeded; page++) {
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender: -1, category_id: -1, creation_status: -1,
      word_count: -1, book_type: -1, sort: 0,
    });
    try {
      const res = await withRetry(
        () => httpGet(
          `https://fanqienovel.com/api/author/library/book_list/v0/?${params}`,
          { Accept: 'application/json' }
        ),
        { name: `番茄热榜第${page+1}页`, maxAttempts: 3, baseDelay: 3000 }
      );
      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data?.book_list) {
        allBooks.push(...json.data.book_list);
      }
    } catch (e) { console.log(`  [WARN] 第${page+1}页失败（重试后）: ${e.message}`); }
    if (page < pagesNeeded - 1) await sleep(REQUEST_DELAY);
  }
  return allBooks.slice(0, TARGET_COUNT);
}

// ========== 步骤3: 获取 top_book_list（未加密的精选列表） ==========
async function fetchTopBookList() {
  console.log('  获取TOP推荐列表（未加密）...');
  try {
    const res = await httpGet(
      'https://fanqienovel.com/api/author/misc/top_book_list/v1/',
      { Accept: 'application/json' }
    );
    const json = JSON.parse(res.data);
    if (json.book_list) {
      const map = {};
      for (const b of json.book_list) {
        map[String(b.book_id)] = {
          book_name: b.book_name,
          author: b.author,
          category: b.category,
          creation_status: b.creation_status,
          thumb_url: b.thumb_url,
        };
      }
      console.log(`  → 获取到 ${Object.keys(map).length} 本未加密数据`);
      return map;
    }
  } catch (e) { console.log(`  [WARN] top_book_list失败: ${e.message}`); }
  return {};
}

// ========== 步骤4: 从详情页获取丰富信息（含完整标签） ==========
function parseDetailPage(html) {
  const info = {};
  
  // 书名
  const tm = html.match(/<title>(.*?)<\/title>/);
  if (tm) {
    const nm = tm[1].match(/^(.+?)(?:完整版|全文|_)/);
    if (nm) info.book_name = nm[1].trim();
  }
  
  // 简介
  const dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  if (dm) {
    info.description = dm[1].replace(/^番茄小说提供.*?番茄小说网[。.]?\s*/, '').trim();
  }
  
  // 作者 (keywords)
  const km = html.match(/<meta\s+name="keywords"\s+content="([^"]*)"/);
  if (km) {
    const am = km[1].match(/,([^,]+?)小说/);
    if (am && !/免费|阅读|章节|下载/.test(am[1])) {
      info.author = am[1].trim();
    }
  }

  // 完整标签抓取 — 从详情页的标签区域提取
  // 番茄详情页标签通常在 class 含 "tag" 的元素中
  const allTags = [];
  
  // 方法1: 从 page-header-info 区域的 tag 链接中提取
  const tagMatches = html.matchAll(/<a[^>]*class="[^"]*tag[^"]*"[^>]*>([^<]+)<\/a>/gi);
  for (const m of tagMatches) {
    const t = m[1].trim();
    if (t && !['连载中', '已完结', '完结', '连载'].includes(t)) {
      allTags.push(t);
    }
  }
  
  // 方法2: 从 span.tag 提取
  if (allTags.length === 0) {
    const spanTags = html.matchAll(/<span[^>]*class="[^"]*tag[^"]*"[^>]*>([^<]+)<\/span>/gi);
    for (const m of spanTags) {
      const t = m[1].trim();
      if (t && !['连载中', '已完结', '完结', '连载'].includes(t)) {
        allTags.push(t);
      }
    }
  }

  // 方法3: 从 JSON-LD 的 genre 字段提取
  const ldm = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ldm) {
    try {
      const ld = JSON.parse(ldm[1]);
      if (!info.author && ld.author?.[0]?.name) info.author = ld.author[0].name;
      if (ld.dateModified) info.dateModified = ld.dateModified;
      if (ld.image?.[0]) info.hdImage = ld.image[0];
      if (ld.genre) {
        const genres = Array.isArray(ld.genre) ? ld.genre : [ld.genre];
        for (const g of genres) {
          if (g && !allTags.includes(g)) allTags.push(g);
        }
      }
    } catch(e) {}
  }

  // 方法4: 从 meta keywords 提取额外标签
  if (km && allTags.length === 0) {
    const kws = km[1].split(',').map(s => s.trim()).filter(s => 
      s && s.length < 8 && !/小说|免费|阅读|章节|下载|番茄|全文/.test(s)
    );
    allTags.push(...kws);
  }

  if (allTags.length > 0) {
    // 去重
    const unique = [...new Set(allTags)];
    info.primary_tag = unique[0];
    info.secondary_tags = unique.slice(1);
    info.all_tags = unique;
  }

  return info;
}

// ========== 步骤5: 按分类遍历，建立 book_id → gender + category 映射 ==========
async function fetchBookCategoryMap(catGenderMap) {
  console.log('  按分类遍历获取 book_id → category 映射...');
  const genderMap = {};    // book_id → '男频'/'女频'
  const categoryMap = {};  // book_id → category name
  
  // 先按性别全量扫描确定 gender
  for (const gender of [1, 0]) {
    const gLabel = gender === 1 ? '男频' : '女频';
    for (let pageIdx = 0; pageIdx < 4; pageIdx++) {
      const params = new URLSearchParams({
        page_count: 18, page_index: pageIdx,
        gender, category_id: -1, creation_status: -1,
        word_count: -1, book_type: -1, sort: 0,
      });
      try {
        const res = await httpGet(
          `https://fanqienovel.com/api/author/library/book_list/v0/?${params}`,
          { Accept: 'application/json' }
        );
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.book_list) {
          for (const b of json.data.book_list) {
            const id = String(b.book_id);
            if (!genderMap[id]) genderMap[id] = gLabel;
          }
        }
      } catch(e) {}
      await sleep(200);
    }
  }
  
  // 再按每个分类单独请求，确定 category
  const categories = Object.entries(catGenderMap);
  for (const [catName, catInfo] of categories) {
    for (const gender of [1, 0]) {
      // 只请求第1页（18本），足以覆盖 Top50 中属于该分类的书
      const params = new URLSearchParams({
        page_count: 18, page_index: 0,
        gender, category_id: catInfo.id, creation_status: -1,
        word_count: -1, book_type: -1, sort: 0,
      });
      try {
        const res = await httpGet(
          `https://fanqienovel.com/api/author/library/book_list/v0/?${params}`,
          { Accept: 'application/json' }
        );
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.book_list) {
          for (const b of json.data.book_list) {
            const id = String(b.book_id);
            if (!categoryMap[id]) {
              categoryMap[id] = catName;
            }
          }
        }
      } catch(e) {}
      await sleep(150);
    }
  }
  
  console.log(`  → gender: ${Object.keys(genderMap).length} 本, category: ${Object.keys(categoryMap).length} 本`);
  return { genderMap, categoryMap };
}

// ========== Playwright 详情页标签抓取（对 API 无法覆盖的书使用） ==========
async function fetchTagsViaPlaywright(books) {
  // 筛选出需要 Playwright 抓标签的书：无分类 或 缺少副标签
  const needTags = books.filter(b => 
    !b.primary_tag || b.primary_tag === '未分类' || b.primary_tag === b.book_name ||
    !b.secondary_tags || b.secondary_tags.length === 0
  );
  
  if (needTags.length === 0) {
    console.log('  所有书都已有完整标签，无需 Playwright');
    return;
  }
  
  console.log(`\n🌐 Playwright 标签抓取：${needTags.length} 本需要处理`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1920, height: 1080 },
    });
    
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    
    const page = await context.newPage();
    
    for (let i = 0; i < needTags.length; i++) {
      const book = needTags[i];
      const url = `https://fanqienovel.com/page/${book.book_id}`;
      process.stdout.write(`  [${i+1}/${needTags.length}] ${book.book_name} `);
      
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await sleep(1500);
        
        // 从渲染后的 DOM 提取标签
        const tags = await page.evaluate(() => {
          const result = [];
          
          // 方法1: 查找所有看起来像标签的元素
          // 番茄详情页标签通常在书名下方，是一组小的 pill/badge 元素
          const selectors = [
            '.info-label .label-tag',
            '.book-info .tag',
            '.page-header-info .tag',
            '[class*="tag"]',
            '[class*="label"]',
          ];
          
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            els.forEach(el => {
              const t = el.textContent.trim();
              if (t && t.length <= 8 && t.length >= 1 
                  && !['连载中', '已完结', '完结', '连载', '开始阅读', '下载', '免费'].includes(t)
                  && !t.includes('万字')
                  && !t.includes('番茄')) {
                result.push(t);
              }
            });
            if (result.length > 0) break;
          }
          
          // 方法2: 如果上面没找到，试试更宽泛的查找
          if (result.length === 0) {
            // 找书名附近的小文字块（排除大标题和按钮）
            const allSpans = document.querySelectorAll('span, a');
            const titleEl = document.querySelector('h1, .book-name, [class*="title"]');
            if (titleEl) {
              const titleRect = titleEl.getBoundingClientRect();
              allSpans.forEach(el => {
                const rect = el.getBoundingClientRect();
                // 在标题下方100px以内，且元素较小
                if (rect.top > titleRect.bottom && rect.top < titleRect.bottom + 100
                    && rect.height < 40 && rect.width < 150 && rect.width > 20) {
                  const t = el.textContent.trim();
                  if (t && t.length <= 8 && t.length >= 1
                      && !['连载中', '已完结', '完结', '连载', '开始阅读', '下载', '免费'].includes(t)
                      && !t.includes('万字')
                      && !t.includes('番茄')
                      && !t.includes('最近更新')) {
                    result.push(t);
                  }
                }
              });
            }
          }
          
          // 去重
          return [...new Set(result)];
        });
        
        if (tags.length > 0) {
          // 过滤状态标签，保留分类标签
          const contentTags = tags.filter(t => 
            !['连载中', '已完结', '完结', '连载'].includes(t)
          );
          
          if (contentTags.length > 0) {
            const hasGoodPrimary = book.primary_tag && book.primary_tag !== '未分类' && book.primary_tag !== book.book_name;
            
            if (hasGoodPrimary) {
              // 已有主标签 — 只补充副标签（不覆盖主标签）
              const newSecondary = contentTags.filter(t => t !== book.primary_tag);
              book.secondary_tags = newSecondary;
              book.all_tags = [book.primary_tag, ...newSecondary];
              console.log(`✓ 补充副标签 [${newSecondary.join(', ')}]`);
            } else {
              // 无主标签 — 全量替换
              book.primary_tag = contentTags[0];
              book.secondary_tags = contentTags.slice(1);
              book.all_tags = contentTags;
              console.log(`✓ [${contentTags.join(', ')}]`);
            }
          } else {
            console.log('✗ (只有状态标签)');
          }
        } else {
          console.log('✗ (未找到标签)');
        }
        
      } catch(e) {
        console.log(`✗ (${e.message.slice(0, 50)})`);
      }
      
      if (i < needTags.length - 1) await sleep(1000);
    }
    
  } catch(e) {
    console.log(`  Playwright 初始化失败: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

// ========== 关键词推断分类（兜底策略） ==========
function inferCategoryFromText(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  
  // 按优先级匹配（从具体到宽泛）
  const rules = [
    { tag: '悬疑灵异', kws: ['灵异', '鬼', '诡', '恐怖', '惊悚', '灵魂', '阴间', '捉鬼', '风水', '驱邪', '道士'] },
    { tag: '科幻末世', kws: ['末世', '末日', '丧尸', '僵尸', '废土', '科幻', '星际', '赛博', '机器人', '人工智能'] },
    { tag: '游戏体育', kws: ['游戏', '副本', '电竞', '网游', '体育', '足球', '篮球', '直播'] },
    { tag: '东方仙侠', kws: ['仙', '修仙', '修真', '仙侠', '飞升', '修炼', '仙门', '修道'] },
    { tag: '传统玄幻', kws: ['玄幻', '异世', '大陆', '斗气', '魔法', '龙', '魔王', '勇者'] },
    { tag: '都市高武', kws: ['高武', '武道', '境界', '灵气复苏', '觉醒', '超能', '异能'] },
    { tag: '历史古代', kws: ['古代', '大唐', '大秦', '三国', '朝廷', '太子', '皇帝', '科举', '王爷', '郡主', '宫', '公主'] },
    { tag: '悬疑脑洞', kws: ['推理', '破案', '侦探', '密室', '悬疑', '怪谈', '规则'] },
    { tag: '都市种田', kws: ['种田', '乡村', '农村', '美食', '开店', '厨', '钓鱼'] },
    { tag: '都市日常', kws: ['都市', '校园', '大学', '职场', '公司', '总裁', '医', '教授', '老师'] },
    { tag: '仕途', kws: ['官场', '仕途', '反腐', '公务员', '县长', '书记', '公考'] },
    { tag: '豪门总裁', kws: ['豪门', '总裁', '财阀', '千金', '少爷', '权势'] },
    { tag: '娱乐圈', kws: ['娱乐圈', '明星', '偶像', '演员', '导演', '综艺'] },
    { tag: '都市脑洞', kws: ['重生', '穿越', '系统', '面板', '模拟', '抽取', '词条', '穿书'] },
    { tag: '古言', kws: ['嫡女', '侯府', '王妃', '闺', '妾', '庶', '嫁'] },
    { tag: '现言', kws: ['甜宠', '恋爱', '男友', '闪婚', '双男主', '破镜重圆', 'he'] },
    { tag: '西方奇幻', kws: ['魔法', '精灵', '骑士', '异界'] },
  ];
  
  for (const rule of rules) {
    if (rule.kws.some(kw => text.includes(kw))) {
      return rule.tag;
    }
  }
  
  return null;
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`番茄小说热门榜单爬虫 v3 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  console.log('\n📊 阶段一：获取基础数据');
  const [hotRankList, topBookMap, catGenderMap] = await Promise.all([
    fetchHotRankList(),
    fetchTopBookList(),
    buildCategoryGenderMap(),
  ]);
  
  // 按分类遍历（需要 catGenderMap 先完成）
  const { genderMap: genderByBookId, categoryMap: categoryByBookId } = await fetchBookCategoryMap(catGenderMap);

  console.log(`  热榜: ${hotRankList.length} 本 | TOP推荐: ${Object.keys(topBookMap).length} 本`);
  console.log(`  分类: ${Object.keys(catGenderMap).length} 个 | 性别确认: ${Object.keys(genderByBookId).length} 本 | 分类确认: ${Object.keys(categoryByBookId).length} 本`);

  console.log(`\n📖 阶段二：获取 ${hotRankList.length} 本书详情（含完整标签）`);
  const books = [];

  for (let i = 0; i < hotRankList.length; i++) {
    const rawBook = hotRankList[i];
    const bookId = String(rawBook.book_id);
    const rank = i + 1;
    const topInfo = topBookMap[bookId] || {};

    process.stdout.write(`  [${rank}/${hotRankList.length}] `);

    let detailInfo = {};
    try {
      const res = await httpGet(`https://fanqienovel.com/page/${bookId}`);
      detailInfo = parseDetailPage(res.data);
      process.stdout.write('✓ ');
    } catch(e) {
      process.stdout.write('✗ ');
    }

    const bookName = topInfo.book_name || detailInfo.book_name || `ID:${bookId}`;
    const author = topInfo.author || detailInfo.author || '未知';
    const category = topInfo.category || '';
    const creationStatus = topInfo.creation_status ?? rawBook.creation_status;
    const statusLabel = creationStatus === 0 ? '完结' : (creationStatus === 1 ? '连载中' : '未知');

    let gender = genderByBookId[bookId] || '未知';
    if (gender === '未知' && category && catGenderMap[category]) {
      gender = catGenderMap[category].gender;
    }

    // 标签处理：多源合并
    // 优先级：topBookList.category > categoryByBookId > 详情页标签
    const catMapCategory = categoryByBookId[bookId] || '';
    const finalCategory = category || catMapCategory;
    
    let detailTags = detailInfo.all_tags || [];
    
    // 过滤掉详情页中可能误入的书名、作者名
    detailTags = detailTags.filter(t => 
      t !== bookName && t !== author && t.length <= 6 &&
      !/小说|免费|阅读|章节|下载|番茄|全文/.test(t)
    );
    
    let primaryTag = finalCategory || (detailTags.length > 0 ? detailTags[0] : '未分类');
    let secondaryTags = detailTags.filter(t => t !== primaryTag);
    let allTags = [primaryTag, ...secondaryTags].filter(t => t && t !== '未分类');
    
    // 确保至少有一个标签 — 关键词推断兜底
    if (primaryTag === '未分类' || primaryTag === bookName) {
      const inferred = inferCategoryFromText(bookName, detailInfo.description || '');
      if (inferred) {
        primaryTag = inferred;
        allTags = [inferred];
      } else if (finalCategory) {
        primaryTag = finalCategory;
        allTags = [finalCategory];
      }
    }
    
    // 再次检查：如果 primaryTag 和书名一样，说明推断失败了
    if (primaryTag === bookName) {
      primaryTag = '未分类';
      allTags = [];
    }

    const abstract = detailInfo.description || '暂无简介';
    const thumbUrl = detailInfo.hdImage || topInfo.thumb_url || rawBook.thumb_url || '';

    console.log(`${bookName} [${primaryTag}]`);

    books.push({
      rank,
      book_id: bookId,
      book_name: bookName,
      author,
      gender,
      primary_tag: primaryTag,
      secondary_tags: secondaryTags,
      all_tags: allTags,
      abstract,
      status: statusLabel,
      thumb_url: thumbUrl,
      book_url: `https://fanqienovel.com/page/${bookId}`,
      rank_change: null,
    });

    if (i < hotRankList.length - 1) await sleep(REQUEST_DELAY);
  }

  // 阶段2.5：对无分类的书用 Playwright 抓取详情页标签
  await fetchTagsViaPlaywright(books);

  console.log('\n📈 阶段三：计算排名变化（严格新书：全 history 比对）');
  computeRankChange(books, DATA_DIR, fmtDate(now), 'book_id');

  const latestPath = path.join(DATA_DIR, 'latest.json');

  // 标签统计
  const tagStats = {};
  for (const b of books) {
    const t = b.primary_tag;
    tagStats[t] = (tagStats[t] || 0) + 1;
  }
  const genderStats = {};
  for (const b of books) {
    genderStats[b.gender] = (genderStats[b.gender] || 0) + 1;
  }

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    source: '番茄小说书库·最热榜',
    source_url: 'https://fanqienovel.com/library?enter_from=menu',
    platform: 'fanqie',
    platform_name: '番茄小说',
    tag_stats: tagStats,
    gender_stats: genderStats,
    books,
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
  console.log(`🎉 完成！共 ${books.length} 本`);
  console.log(`   性别分布: ${JSON.stringify(genderStats)}`);
  console.log(`   主标签分布: ${JSON.stringify(tagStats)}`);
  console.log(`   数据: ${latestPath}`);
  console.log(`   历史: ${histPath}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  const latestPath = path.join(__dirname, '..', 'data', 'fanqie', 'latest.json');
  if (fs.existsSync(latestPath)) {
    console.log('⚠️ 本次运行失败，但已有历史数据可用，退出码 0');
    process.exit(0);
  } else {
    process.exit(1);
  }
});
