/**
 * 长佩历史书级回溯 —— 从 git 历史还原 2026-09-06 ~ 09-08 的书级 books
 *
 * 背景：长佩爬虫升级前，history/*.json 只存聚合（count/tag_stats/status_stats），
 * 但同一次运行写下的 4 个榜单文件（latest.json / purelove_*.json）在 git 里保留了完整书级。
 * 本脚本把每个日文件对应的 commit 里的榜单 books 回填进 history/*.json 的 rankings[id].books。
 *
 * 用法: node scrapers/backfill-changpei-books.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'changpei');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// 榜单 id -> 榜单文件名（与 changpei.js RANKINGS 对应）
const RANKING_FILES = {
  bestseller: 'latest.json',
  purelove_bestseller: 'purelove_bestseller.json',
  purelove_new: 'purelove_new.json',
  purelove_completed: 'purelove_completed.json',
};

// 日文件 -> 当日写入 commit（由 git log --format 实测得出）
const DATE_COMMITS = {
  '2026-09-06': '7389c63',
  '2026-09-07': '934de23',
  '2026-09-08': '2687d80',
};

// 归档时保留的书级字段（与升级后 changpei.js 一致）
const BOOK_KEYS = ['rank', 'book_name', 'author', 'tags', 'all_tags', 'primary_tag',
  'popularity', 'word_count', 'status', 'rank_change', 'history_days'];

function gitShow(sha, file) {
  return execSync(`git show ${sha}:${file}`, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
}

let filled = 0, failed = 0;
for (const [dateStr, sha] of Object.entries(DATE_COMMITS)) {
  const histFile = path.join(HISTORY_DIR, `${dateStr}.json`);
  if (!fs.existsSync(histFile)) { console.log(`[skip] 缺 ${dateStr}.json`); continue; }
  const hist = JSON.parse(fs.readFileSync(histFile, 'utf-8'));

  for (const [rid, rfile] of Object.entries(RANKING_FILES)) {
    if (!hist.rankings[rid]) continue;
    try {
      const snap = JSON.parse(gitShow(sha, `data/changpei/${rfile}`));
      const books = (snap.books || []).map(b => ({
        rank: b.rank,
        book_name: b.book_name,
        author: b.author || '',
        tags: b.all_tags || [],
        all_tags: b.all_tags || [],
        primary_tag: b.primary_tag || '',
        popularity: b.popularity || '',
        word_count: b.word_count || '',
        status: b.status || '',
        rank_change: b.rank_change ?? null,
        history_days: b.history_days ?? 1,
      }));
      hist.rankings[rid].books = books;
      const ts = hist.rankings[rid].tag_stats || {};
      const tsSum = Object.values(ts).reduce((s, v) => s + v, 0);
      console.log(`${dateStr} ${rid}: books=${books.length} (tag_stats 和=${tsSum})`);
      filled++;
    } catch (e) {
      console.log(`${dateStr} ${rid}: 失败 ${e.message}`);
      failed++;
    }
  }
  fs.writeFileSync(histFile, JSON.stringify(hist, null, 2), 'utf-8');
}
console.log(`\n回填完成: ${filled} 榜单, 失败 ${failed}`);
