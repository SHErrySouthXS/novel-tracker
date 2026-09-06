// 通用重试工具
// 用法：const { withRetry, sleep } = require('./retry');
//   await withRetry(() => httpGet(url), { name: '晋江月榜', maxAttempts: 3, baseDelay: 5000 });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 包一层重试逻辑。失败后等待 baseDelay * 2^(n-1) 毫秒（指数退避）再试。
 * @param {Function} fn 返回 Promise 的函数（无参数；闭包传参）
 * @param {Object} opts
 * @param {string} [opts.name='请求'] 日志中显示的名称
 * @param {number} [opts.maxAttempts=3] 最大尝试次数（含首次）
 * @param {number} [opts.baseDelay=5000] 初次失败后等待 ms
 */
async function withRetry(fn, opts = {}) {
  const { name = '请求', maxAttempts = 3, baseDelay = 5000 } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) console.log(`  ✅ ${name} 第 ${attempt} 次尝试成功`);
      return result;
    } catch (e) {
      lastErr = e;
      const msg = (e?.message || String(e)).slice(0, 200);
      if (attempt < maxAttempts) {
        const wait = baseDelay * Math.pow(2, attempt - 1);
        console.log(`  ⚠️ ${name} 第 ${attempt}/${maxAttempts} 次失败: ${msg}`);
        console.log(`     ${wait}ms 后重试...`);
        await sleep(wait);
      } else {
        console.log(`  ❌ ${name} 所有 ${maxAttempts} 次尝试均失败: ${msg}`);
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry, sleep };
