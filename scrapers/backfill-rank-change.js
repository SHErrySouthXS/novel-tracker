/**
 * 回溯脚本：为所有历史文件重新计算 rank_change 和 history_days
 *
 * 语义：处理某日文件时，history_days = 该 book_id 在所有 <= 该日 的历史文件中出现过的唯一天数
 * 用法：node scrapers/backfill-rank-change.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..', 'data');
const PLATFORMS = ['fanqie', 'qidian', 'jjwxc'];

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

for (const platform of PLATFORMS) {
  const histDir = path.join(ROOT, platform, 'history');
  if (!fs.existsSync(histDir)) {
    console.log(`[${platform}] 无 history 目录，跳过`);
    continue;
  }

  const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json')).sort();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${platform}] 共 ${files.length} 天历史数据`);
  console.log(`${'='.repeat(60)}`);

  // 按时间顺序逐日处理
  // appearDays: book_id -> Set<date>（出现过的日期集合，截至当前处理日之前）
  const appearDays = new Map();
  let totalReclassFromNew = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const dateStr = file.replace('.json', '');
    const filePath = path.join(histDir, file);
    const data = loadJson(filePath);
    if (!data?.books) {
      console.log(`  ${dateStr}: 解析失败，跳过`);
      continue;
    }

    // 前一天的 rank 映射（用于计算具体涨跌幅）
    let prevMap = null;
    if (i > 0) {
      const prev = loadJson(path.join(histDir, files[i - 1]));
      if (prev?.books) {
        prevMap = {};
        for (const b of prev.books) {
          if (b.book_id) prevMap[String(b.book_id)] = b.rank;
        }
      }
    }

    let strictNew = 0, returning = 0, ranked = 0, reclass = 0;
    for (const b of data.books) {
      const id = b.book_id ? String(b.book_id) : null;
      const oldRC = b.rank_change;
      let newRC;

      if (!id) {
        newRC = null;
        b.rank_change = newRC;
        b.history_days = 1;
        continue;
      }

      const everSet = appearDays.get(id);
      const hasHistory = !!(everSet && everSet.size > 0);

      if (!hasHistory) {
        newRC = 'new';
        strictNew++;
      } else if (prevMap && id in prevMap) {
        newRC = prevMap[id] - b.rank;
        ranked++;
      } else {
        newRC = null;
        returning++;
      }

      if (oldRC === 'new' && newRC !== 'new') reclass++;

      b.rank_change = newRC;
      // history_days = 截至该日前出现天数 + 1（该日自己）
      b.history_days = (everSet ? everSet.size : 0) + 1;
    }

    totalReclassFromNew += reclass;
    console.log(`  ${dateStr}: new ${strictNew} | returning ${returning} | ranked ${ranked} | 修正掉 ${reclass} 个伪new`);

    // 该日处理完 → 把该日出现的 book_id 加入 appearDays，给后面天用
    for (const b of data.books) {
      if (!b.book_id) continue;
      const id = String(b.book_id);
      if (!appearDays.has(id)) appearDays.set(id, new Set());
      appearDays.get(id).add(dateStr);
    }

    if (!DRY) saveJson(filePath, data);
  }

  console.log(`\n[${platform}] 汇总: 修正掉伪new ${totalReclassFromNew} 条`);

  // 同步更新 latest.json
  if (!DRY && files.length > 0) {
    const lastData = loadJson(path.join(histDir, files[files.length - 1]));
    if (lastData) {
      saveJson(path.join(ROOT, platform, 'latest.json'), lastData);
      console.log(`[${platform}] latest.json 已同步`);
    }
  }
}

console.log(DRY ? '\n[DRY-RUN] 未实际写入文件' : '\n✅ 回溯完成');
