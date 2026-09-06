// 计算今日榜单的 rank_change 和 history_days 字段
//
// rank_change 定义：
//   - 'new'：book_id 在所有历史榜单（data/<platform>/history/*.json）中从未出现过
//   - 数字：昨天在 Top50 里，`昨天rank - 今天rank`（正数=上升）
//   - null：历史出现过但昨天不在 Top50（无法精确算涨跌）
//
// history_days 定义：
//   该 book_id 在 data/<platform>/history/ 所有日文件（含今天）中出现过的唯一天数。
//   每天只算 1，不管该日 rank 多少。

const fs = require('fs');
const path = require('path');

/**
 * @param {Array<{book_id, rank, rank_change, history_days}>} todayBooks  当日榜单（会被原地修改）
 * @param {string} dataDir  data/<platform> 目录
 * @param {string} todayDateStr  今日日期 YYYY-MM-DD
 * @param {string} bookKey  唯一标识字段名，默认 'book_id'
 */
function computeRankChange(todayBooks, dataDir, todayDateStr, bookKey = 'book_id') {
  // 1) 遍历 history 目录，为每个 book_id 收集"出现过的日期集合"
  const historyDir = path.join(dataDir, 'history');
  const appearDays = new Map(); // book_id -> Set of YYYY-MM-DD
  if (fs.existsSync(historyDir)) {
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const dateStr = f.replace('.json', '');
      if (dateStr === todayDateStr) continue; // 今天由 todayBooks 自己贡献
      try {
        const d = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf-8'));
        for (const b of d.books || []) {
          if (!b[bookKey]) continue;
          const id = String(b[bookKey]);
          if (!appearDays.has(id)) appearDays.set(id, new Set());
          appearDays.get(id).add(dateStr);
        }
      } catch (e) {
        console.warn(`  跳过损坏文件 ${f}: ${e.message}`);
      }
    }
  }

  // 2) 读昨天的 latest.json 用于算具体涨跌幅
  const latestPath = path.join(dataDir, 'latest.json');
  let prevMap = null;
  if (fs.existsSync(latestPath)) {
    try {
      const prevData = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
      if (prevData?.books && !prevData.books[0]?.book_name?.includes('模拟')) {
        prevMap = {};
        for (const b of prevData.books) {
          if (b[bookKey]) prevMap[String(b[bookKey])] = b.rank;
        }
      }
    } catch (e) {}
  }

  // 3) 给每本书计算 rank_change + history_days
  let strictNew = 0, returning = 0, ranked = 0;
  for (const b of todayBooks) {
    const id = b[bookKey] ? String(b[bookKey]) : null;
    if (!id) {
      b.rank_change = null;
      b.history_days = 1; // 今天也算 1
      continue;
    }
    const everSet = appearDays.get(id);
    const hasHistory = !!(everSet && everSet.size > 0);

    if (!hasHistory) {
      b.rank_change = 'new';
      strictNew++;
    } else if (prevMap && id in prevMap) {
      b.rank_change = prevMap[id] - b.rank;
      ranked++;
    } else {
      b.rank_change = null;
      returning++;
    }

    // 今天也算一天上榜
    b.history_days = (everSet ? everSet.size : 0) + 1;
  }

  console.log(`  rank_change 统计: 严格新书 ${strictNew} / 昨日存在 ${ranked} / 回归(历史曾上榜) ${returning}`);
  console.log(`  history_days 已计算 (含今天)`);
  return { strictNew, returning, ranked };
}

module.exports = { computeRankChange };
