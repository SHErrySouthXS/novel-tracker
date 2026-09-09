/* ============================================================
 * trio-embed.js — 题材三栏下钻组件（嵌入 index.html 各平台「细分题材」模块）
 * 用法：await mountTrio(hostEl, { books, color, height, dictUrl })
 *   - books:  平台当日书级列表（每本含 tags/tags[]，tags[0]=一级频道）
 *   - color:  平台色（与概览 accent 一致），默认长佩紫 #6c5ce7
 *   - height: 组件总高 px（默认 430，适配原站楼层高度）
 *   - 词典:   data/cp_motifs_v3.json（长佩 07 池 v3：7 词性维度 × 98 母题 + aliases）
 * 数据现算：一级=tags[0] 频道 topdown；二级=其余 tag 归一母题 → 词性维度 CTA 切层
 * 组件类均加 trio- 前缀，避免与原站样式互相污染。
 * ============================================================ */
(function () {
  if (window.__trioEmbedLoaded) return;
  window.__trioEmbedLoaded = true;

  const DIM_ORDER = [
    { name: "结局标签", group: "S" },
    { name: "基调风格", group: "S" },
    { name: "题材背景", group: "S" },
    { name: "情节走向", group: "S" },
    { name: "叙事结构", group: "S" },
    { name: "CP设定",   group: "P" },
    { name: "人设",     group: "P" }
  ];
  const STORY = DIM_ORDER.filter(d => d.group === "S").map(d => d.name);
  const PERSON = DIM_ORDER.filter(d => d.group === "P").map(d => d.name);

  /* ---------- CSS（trio- 前缀，随组件注入，一次） ---------- */
  const CSS = `
  .trio-root{--plat:#6c5ce7;--plat-soft:rgba(108,92,231,.40);--plat-deep:#5248c4;
    --green:#1f9d55;--red:#e03131;--tbar:rgba(35,41,70,.07);--tline:rgba(35,41,70,.08);
    display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:stretch;
    margin:0;font-size:13px;color:#232946;}
  .trio-root *{box-sizing:border-box;margin:0;padding:0;}
  .trio-col{display:flex;flex-direction:column;height:var(--trio-h,430px);min-width:0;
    background:rgba(255,255,255,.34);backdrop-filter:blur(26px) saturate(170%);-webkit-backdrop-filter:blur(26px) saturate(170%);
    border:1px solid rgba(255,255,255,.55);box-shadow:0 8px 32px rgba(60,72,120,.14);border-radius:14px;padding:13px 15px;overflow:hidden;}
  .trio-hd{font-size:13.5px;font-weight:600;color:#232946;margin-bottom:10px;flex:none;}
  .trio-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;
    padding:2px 6px 2px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;}
  .trio-list::-webkit-scrollbar{width:6px;height:6px;}
  .trio-list::-webkit-scrollbar-track{background:transparent;}
  .trio-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px;}
  /* 左：一级频道 topdown */
  .trio-l1{flex:1 1 auto;min-height:33px;max-height:44px;display:flex;align-items:center;gap:8px;
    padding:5px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s;}
  .trio-l1:hover{background:rgba(255,255,255,.45);backdrop-filter:blur(8px);}
  .trio-l1.on{background:rgba(255,255,255,.62);backdrop-filter:blur(14px) saturate(1.5);
    border-color:rgba(255,255,255,.95);box-shadow:0 2px 14px rgba(60,72,120,.12);}
  .trio-l1 .nm{width:44px;font-size:12.5px;font-weight:500;flex:none;text-align:right;color:#232946;}
  .trio-l1.on .nm{font-weight:600;}
  .trio-l1 .tr{flex:1;height:11px;background:var(--tbar);border-radius:6px;overflow:hidden;}
  .trio-l1 .fl{height:100%;border-radius:6px;background:var(--plat);opacity:.45;transition:width .2s,opacity .15s;}
  .trio-l1.on .fl{opacity:.95;}
  .trio-l1 .ct{width:74px;font-size:11px;color:#4d5464;flex:none;text-align:right;white-space:nowrap;}
  /* CTA 层（毛玻璃无色） */
  .trio-cta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px;flex:none;}
  .trio-ctabtn{font-size:11.5px;padding:4px 12px;border-radius:999px;cursor:pointer;border:0;
    color:#232946;background:rgba(255,255,255,.28);backdrop-filter:blur(12px) saturate(1.4);
    border:1px solid rgba(255,255,255,.60);transition:all .15s;font-family:inherit;}
  .trio-ctabtn:hover{background:rgba(255,255,255,.52);}
  .trio-ctabtn.on{background:rgba(255,255,255,.88);color:#232946;font-weight:600;border-color:#fff;
    box-shadow:0 3px 12px rgba(60,72,120,.16);}
  .trio-panehd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 7px;flex:none;}
  .trio-pill{font-size:11px;background:rgba(255,255,255,.5);border:1px solid rgba(255,255,255,.6);
    color:#4d5464;border-radius:999px;padding:1px 8px;font-weight:500;flex:none;}
  .trio-dot{width:8px;height:8px;border-radius:2.5px;flex:none;background:var(--plat-soft);}
  .trio-dimname{font-size:13px;font-weight:600;flex:none;color:var(--plat-deep);}
  .trio-panenote{font-size:10.5px;color:#4d5464;}
  /* 二级母题行 */
  .trio-mrow{flex:1 1 auto;min-height:32px;max-height:160px;display:flex;align-items:center;gap:9px;
    padding:3px 2px;border-bottom:1px dashed var(--tline);}
  .trio-mrow:last-child{border-bottom:none;}
  .trio-mrow .mn{width:82px;font-size:12.5px;flex:none;color:#232946;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .trio-mrow .mbar{flex:1;height:6.5px;background:var(--tbar);border-radius:4px;overflow:hidden;}
  .trio-mrow .mfl{height:100%;border-radius:4px;min-width:2px;background:var(--plat-soft);}
  .trio-mrow .mv{font-size:12px;font-weight:500;flex:none;text-align:right;white-space:nowrap;color:#232946;}
  .trio-mv-up{color:var(--green);font-size:11px;font-weight:600;margin-left:4px;}
  .trio-mv-dn{color:var(--red);font-size:11px;font-weight:600;margin-left:4px;}
  .trio-mv-eq{color:#4d5464;font-size:10.5px;margin-left:4px;}
  .trio-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:11.5px;color:#4d5464;}
  @media(max-width:1180px){.trio-root{grid-template-columns:1fr 1fr;}.trio-root .trio-col:nth-child(3){grid-column:1/-1;}}
  @media(max-width:820px){.trio-root{grid-template-columns:1fr;}.trio-root .trio-col:nth-child(3){grid-column:auto;}}`;

  if (!document.getElementById("trio-embed-css")) {
    const st = document.createElement("style");
    st.id = "trio-embed-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 词典/books 加载（缓存） ---------- */
  let _dictPromise = null;
  function loadDict(url) {
    if (!_dictPromise) {
      _dictPromise = fetch(url || "data/cp_motifs_v3.json").then(r => {
        if (!r.ok) throw new Error("dict " + r.status);
        return r.json();
      }).then(d => {
        const alias2motif = {};
        const dimOf = {};
        for (const m of d.motifs || []) {
          dimOf[m.name] = m.dim;
          (m.aliases || []).forEach(a => { alias2motif[a] = m.name; });
          alias2motif[m.name] = m.name;
        }
        return { L1: new Set((d.L1 || []).map(x => x.name)), dimOf, alias2motif };
      }).catch(e => { _dictPromise = null; throw e; });
    }
    return _dictPromise;
  }
  function loadBooks(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error("books " + r.status);
      return r.json();
    }).then(d => d.books || d.data?.books || []);
  }

  /* ---------- 聚合：books → ctx 结构与 dim 覆盖 ---------- */
  function aggregate(books, dict) {
    const ctxN = { "全站": books.length };
    const ctxL1 = {};                 // 频道 → count
    const gCount = {};                // 母题 → 全站命中书数
    const cCount = {};                // 频道 → 母题 → 命中书数
    const seen = new Set();
    for (const b of books) {
      const ts = b.tags || b.all_tags || [];
      const l1 = (ts[0] || "").trim();
      if (!l1) continue;
      ctxL1[l1] = (ctxL1[l1] || 0) + 1;
      ctxN[l1] = (ctxN[l1] || 0) + 1;
      if (!cCount[l1]) cCount[l1] = {};
      const key = l1 + "\u0000" + b.book_name;
      const hit = seen.has(key); // 防同榜重复书名重复计
      seen.add(key);
      for (const t of ts.slice(1)) {
        const m = dict.alias2motif[t];
        if (!m) continue;
        gCount[m] = (gCount[m] || 0) + 1;
        cCount[l1][m] = (cCount[l1][m] || 0) + 1;
      }
    }
    // 频道行（仅出现过的）
    const l1Order = Object.entries(ctxL1).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    // 每频道每维 pct 表（含全站）
    function pctRows(countMap, den) {
      if (!den) return [];
      return Object.entries(countMap).map(([m, c]) => [m, Math.round(100 * c / den)])
        .filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    }
    const dims = {};
    const gRows = pctRows(gCount, books.length);          // 全站通用母题 pct
    for (const dimName of DIM_ORDER.map(d => d.name)) {
      const rowsAll = gRows.filter(([m]) => dict.dimOf[m] === dimName);
      const mCtx = {};
      for (const ctx of Object.keys(cCount)) {
        mCtx[ctx] = pctRows(cCount[ctx], ctxN[ctx]).filter(([m]) => dict.dimOf[m] === dimName);
      }
      dims[dimName] = { all: rowsAll, ctx: mCtx };
    }
    return { N: books.length, l1Order, ctxN, dims, dict };
  }

  /* ---------- 渲染 ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function mountTrio(host, opts) {
    if (!host) return Promise.reject(new Error("mountTrio: no host"));
    opts = opts || {};
    const color = opts.color || "#6c5ce7";
    const height = opts.height || 380;
    host.style.setProperty("--trio-h", height + "px");
    host.style.setProperty("--plat", color);
    // 平台色 → 半透明（二级条）
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), bl = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r)) { host.style.setProperty("--plat-soft", `rgba(${r},${g},${bl},.40)`); host.style.setProperty("--plat-deep", color); }

    return loadDict(opts.dictUrl).then(dict => {
      const booksReady = opts.books
        ? Promise.resolve(opts.books)
        : (opts.booksUrl ? loadBooks(opts.booksUrl) : Promise.resolve([]));
      return booksReady.then(books => {
        const A = aggregate(books, dict);
        if (!A.N) { host.innerHTML = '<div class="trio-empty" style="height:' + height + 'px;display:flex;align-items:center;justify-content:center;color:#4d5464;font-size:12px;">暂无书级数据，无法聚合题材分布</div>'; return; }

      let ctx = "全站";
      let sIdx = Math.max(0, STORY.indexOf("题材背景")); // 默认信息量最大维度
      let pIdx = 0;
      const maxv = {};

      function dimRows(name) {
        const d = A.dims[name];
        return ctx === "全站" ? (d.all || []) : (d.ctx[ctx] || []);
      }
      function basePct(name, m) {
        const row = (A.dims[name].all || []).find(x => x[0] === m);
        return row ? row[1] : null;
      }
      function diffOf(name, m, pct) {
        if (ctx === "全站") return null;
        const bp = basePct(name, m);
        if (bp == null) return null;
        return pct - bp;
      }
      function fmtD(d) {
        if (d == null) return "";
        return Math.abs(d) >= 3 ? (d > 0 ? '<span class="trio-mv-up">▲' + Math.round(d) + "</span>" : '<span class="trio-mv-dn">▼' + Math.round(-d) + "</span>") : '<span class="trio-mv-eq">≈</span>';
      }

      function render() {
        // 左栏
        const maxC = Math.max(...A.l1Order.map(k => A.ctxN[k]), 1);
        const items = [["全站", A.N], ...A.l1Order.map(k => [k, A.ctxN[k]])];
        host.innerHTML = `<div class="trio-root">
          <div class="trio-col">
            <div class="trio-hd">一级 · 频道</div>
            <div class="trio-list">${items.map(([k, n]) => {
              const on = ctx === k;
              return `<div class="trio-l1${on ? " on" : ""}" data-ctx="${esc(k)}">
                <div class="nm">${esc(k)}</div>
                <div class="tr"><div class="fl" style="width:${Math.round(100 * n / maxC)}%"></div></div>
                <div class="ct">${n}本 · ${(Math.round(1000 * n / A.N) / 10)}%</div></div>`;
            }).join("")}</div>
          </div>
          <div class="trio-col">
            ${pillRowHTML("S")}
            ${paneHTML("S")}
            <div class="trio-list" id="trio-list-S">${rowsHTML(STORY[sIdx])}</div>
          </div>
          <div class="trio-col">
            ${pillRowHTML("P")}
            ${paneHTML("P")}
            <div class="trio-list" id="trio-list-P">${rowsHTML(PERSON[pIdx])}</div>
          </div>
        </div>`;
        // 事件
        host.querySelectorAll(".trio-l1").forEach(el => {
          el.onclick = () => { ctx = el.dataset.ctx; render(); };
        });
        host.querySelectorAll(".trio-ctabtn").forEach(el => {
          el.onclick = () => {
            const g = el.dataset.grp, i = +el.dataset.i;
            if (g === "S") sIdx = i; else pIdx = i;
            render();
          };
        });
      }
      function pillRowHTML(g) {
        const arr = g === "S" ? STORY : PERSON;
        const cur = g === "S" ? sIdx : pIdx;
        return `<div class="trio-cta">${arr.map((n, i) =>
          `<button class="trio-ctabtn${i === cur ? " on" : ""}" data-grp="${g}" data-i="${i}">${n}</button>`).join("")}</div>`;
      }
      function paneHTML(g) {
        const name = g === "S" ? STORY[sIdx] : PERSON[pIdx];
        const label = ctx === "全站" ? `全站基线 ${A.N} 本` : `${ctx}频道 ${A.ctxN[ctx]} 本`;
        const note = ctx === "全站" ? "今日全站覆盖率排行（基线 · 无偏差）" : "覆盖率排行 · 相对全站偏差 ▲▼";
        return `<div class="trio-panehd"><span class="trio-pill">${esc(label)}</span>
          <span class="trio-dot"></span><span class="trio-dimname">${esc(name)}</span>
          <span class="trio-panenote">${note}</span></div>`;
      }
      function rowsHTML(name) {
        const rows = dimRows(name);
        if (!rows.length) return '<div class="trio-empty">该语境下此维度暂无上榜母题</div>';
        const mx = Math.max(...rows.map(x => x[1]), 1);
        return rows.map(([m, p]) => {
          const dd = diffOf(name, m, p);
          const mark = ctx === "全站" ? "" : fmtD(dd);
          return `<div class="trio-mrow"><span class="mn">${esc(m)}</span>
            <div class="mbar"><div class="mfl" style="width:${Math.round(100 * p / mx)}%"></div></div>
            <span class="mv">${p}% ${mark}</span></div>`;
        }).join("");
      }
        render();
      });
    });
  }

  window.mountTrio = mountTrio;
})();
