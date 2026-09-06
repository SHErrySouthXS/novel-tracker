/**
 * 生成模拟数据用于前端预览
 */
const fs = require('fs');
const path = require('path');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const timeStr = `${today} 15:00:00`;

// ===== 番茄小说模拟数据 =====
const fanqieTags = ['都市', '玄幻', '悬疑', '科幻', '历史', '游戏', '武侠', '奇幻', '现实', '体育', '二次元', '轻小说'];
const fanqieBooks = [];
for (let i = 1; i <= 50; i++) {
  const tag = fanqieTags[Math.floor(Math.random() * fanqieTags.length)];
  const gender = Math.random() > 0.4 ? '男频' : '女频';
  const secondTags = [fanqieTags[Math.floor(Math.random() * fanqieTags.length)]].filter(t => t !== tag);
  fanqieBooks.push({
    rank: i,
    book_id: String(7300000000 + i),
    book_name: `番茄热门小说${i}号·${tag}篇`,
    author: `作者${String.fromCharCode(65 + (i % 26))}${i}`,
    gender,
    primary_tag: tag,
    secondary_tags: secondTags,
    all_tags: [tag, ...secondTags],
    abstract: `这是一部精彩的${tag}小说，讲述了主角在${gender === '男频' ? '都市' : '古代'}中的冒险故事...`,
    status: Math.random() > 0.3 ? '连载中' : '完结',
    thumb_url: '',
    book_url: `https://fanqienovel.com/page/${7300000000 + i}`,
    rank_change: i <= 5 ? 'new' : (Math.random() > 0.5 ? Math.floor(Math.random() * 10) - 3 : 0),
  });
}
const fanqieTagStats = {};
const fanqieGenderStats = {};
fanqieBooks.forEach(b => {
  fanqieTagStats[b.primary_tag] = (fanqieTagStats[b.primary_tag] || 0) + 1;
  fanqieGenderStats[b.gender] = (fanqieGenderStats[b.gender] || 0) + 1;
});

// ===== 起点中文网模拟数据 =====
const qidianTags = ['玄幻', '仙侠', '都市', '科幻', '历史', '武侠', '游戏', '悬疑', '轻小说', '军事'];
const qidianBooks = [];
for (let i = 1; i <= 50; i++) {
  const tag = qidianTags[Math.floor(Math.random() * qidianTags.length)];
  const gender = Math.random() > 0.3 ? '男频' : '女频';
  const secondTags = [qidianTags[Math.floor(Math.random() * qidianTags.length)]].filter(t => t !== tag);
  qidianBooks.push({
    rank: i,
    book_id: String(1010000000 + i),
    book_name: `起点畅销小说${i}号·${tag}传`,
    author: `起点作者${i}`,
    gender,
    primary_tag: tag,
    secondary_tags: secondTags,
    all_tags: [tag, ...secondTags],
    abstract: `起点畅销${tag}力作，热血激荡的冒险之旅...`,
    status: Math.random() > 0.25 ? '连载中' : '完结',
    word_count: `${Math.floor(Math.random() * 500 + 50)}万字`,
    thumb_url: '',
    book_url: `https://www.qidian.com/book/${1010000000 + i}/`,
    rank_change: i <= 3 ? 'new' : (Math.random() > 0.5 ? Math.floor(Math.random() * 8) - 2 : 0),
  });
}
const qidianTagStats = {};
const qidianGenderStats = {};
qidianBooks.forEach(b => {
  qidianTagStats[b.primary_tag] = (qidianTagStats[b.primary_tag] || 0) + 1;
  qidianGenderStats[b.gender] = (qidianGenderStats[b.gender] || 0) + 1;
});

// ===== 晋江文学城模拟数据 =====
const jjGenres = ['纯爱', '言情', '百合', '无CP'];
const jjEras = ['近代现代', '架空历史', '古色古香', '幻想未来'];
const jjThemes = ['游戏', '科幻', '武侠', '悬疑', '校园', '甜文', '宫斗', '种田', '娱乐圈', '快穿'];
const jjBooks = [];
for (let i = 1; i <= 50; i++) {
  const genre = jjGenres[Math.floor(Math.random() * jjGenres.length)];
  const era = jjEras[Math.floor(Math.random() * jjEras.length)];
  const theme = jjThemes[Math.floor(Math.random() * jjThemes.length)];
  const allTags = ['原创', genre, era, theme];
  jjBooks.push({
    rank: i,
    book_id: String(5000000 + i),
    book_name: `晋江热文${i}号·${theme}${genre === '纯爱' ? 'BL' : ''}`,
    author: `晋江作者${i}`,
    channel: genre,
    nature: '原创',
    genre,
    era,
    theme,
    primary_tag: theme,
    secondary_tags: [genre, era],
    all_tags: allTags,
    score: Math.floor(Math.random() * 2000000000),
    score_display: `${(Math.random() * 2).toFixed(1)}G`,
    abstract: `一部${genre}${theme}佳作，${era}背景下的动人故事...`,
    status: Math.random() > 0.4 ? '连载中' : '完结',
    update_time: today,
    thumb_url: '',
    book_url: `https://www.jjwxc.net/onebook.php?novelid=${5000000 + i}`,
    rank_change: i <= 4 ? 'new' : (Math.random() > 0.5 ? Math.floor(Math.random() * 6) - 1 : 0),
  });
}
const jjTagStats = {};
const jjChannelStats = {};
jjBooks.forEach(b => {
  jjTagStats[b.primary_tag] = (jjTagStats[b.primary_tag] || 0) + 1;
  jjChannelStats[b.channel] = (jjChannelStats[b.channel] || 0) + 1;
});

// ===== 写入数据文件 =====
const dataBase = path.join(__dirname, 'data');

function writeData(platform, result) {
  const dir = path.join(dataBase, platform);
  const histDir = path.join(dir, 'history');
  ensureDir(dir);
  ensureDir(histDir);
  
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, 'history_index.json'), JSON.stringify([today]));
  console.log(`  ${platform}: ${result.books.length} books`);
}

console.log('Generating demo data...');

writeData('fanqie', {
  update_time: timeStr, update_date: today, total_count: 50,
  source: '番茄小说书库·最热榜', source_url: 'https://fanqienovel.com/library',
  platform: 'fanqie', platform_name: '番茄小说',
  tag_stats: fanqieTagStats, gender_stats: fanqieGenderStats,
  books: fanqieBooks,
});

writeData('qidian', {
  update_time: timeStr, update_date: today, total_count: 50,
  source: '起点中文网·每日畅销榜', source_url: 'https://www.qidian.com/rank/hotsales/',
  platform: 'qidian', platform_name: '起点中文网',
  tag_stats: qidianTagStats, gender_stats: qidianGenderStats,
  books: qidianBooks,
});

writeData('jjwxc', {
  update_time: timeStr, update_date: today, total_count: 50,
  source: '晋江文学城·积分月榜', source_url: 'https://www.jjwxc.net/topten.php?orderstr=5&t=0',
  platform: 'jjwxc', platform_name: '晋江文学城',
  tag_stats: jjTagStats, gender_stats: jjChannelStats,
  books: jjBooks,
});

console.log('Done! You can now open index.html to preview.');
