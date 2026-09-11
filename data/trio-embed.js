/* ============================================================
 * trio-embed.js v3 — 题材三栏下钻组件（词典驱动，多平台双形态）
 * 用法：await mountTrio(hostEl, { books, booksUrl, color, height, dictUrl, l1Label })
 *
 * 词典 schema（data/*_motifs*.json）：
 *   {
 *     platform, version, meta,
 *     l1Field: "channel" | "tags0" | "tagmatch",   // 母题扫描区段规则
 *     l1Tabs:  { field:"channel" },                 // 【形态 B】左栏顶部 tab 取该字段
 *     l2Bars:  { field:"theme" },                   // 【形态 B】左栏列表取该字段
 *     defaultDim: "题材背景",
 *     L1: [{name}], dims: [{name, group:"S"|"P", subs?:[]}],
 *     motifs: [{name, dim, sub?, aliases?}], ignore: []
 *   }
 *
 * 两种形态：
 *   A（无 l1Tabs）左栏 = 一级语境 bar 列表，点击切语境（长佩 / 番茄）
 *   B（有 l1Tabs）左栏 = 字段 tab（频道）+ 字段 bar 列表（题材主题），
 *                  语境 = tab ∩ 列表行，偏差基准 = 当前 tab 内占比
 * 兼容旧词典：无 dims/l1Field 时回退长佩 7 维常量 + tags[0] 规则（渲染零回归）。
 * 组件类均加 trio- 前缀，避免与原站样式互相污染。
 * ============================================================ */
(function () {
  if (window.__trioEmbedLoaded) return;
  window.__trioEmbedLoaded = true;

  const TAB_ALL = "\u5168\u90e8";   // 全部
  const SEP = "\u0000";

  /* 长佩 v3 词典缺 dims 声明时的回退维度（与原实现一致，零回归） */
  const LEGACY_DIMS = [
    { name: "结局标签", group: "S" },
    { name: "基调风格", group: "S" },
    { name: "题材背景", group: "S" },
    { name: "情节走向", group: "S" },
    { name: "叙事结构", group: "S" },
    { name: "CP设定",   group: "P" },
    { name: "人设",     group: "P" }
  ];

  /* ---------- CSS（trio- 前缀，随组件注入，一次） ---------- */
  const CSS = `
  .trio-root{--green:#1f9d55;--red:#e03131;--tbar:rgba(35,41,70,.07);--tline:rgba(35,41,70,.08);
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
  /* 左：一级 topdown */
  .trio-l1{flex:1 1 auto;min-height:33px;max-height:44px;display:flex;align-items:center;gap:8px;
    padding:5px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s;}
  .trio-l1:hover{background:rgba(255,255,255,.45);backdrop-filter:blur(8px);}
  .trio-l1.on{background:rgba(255,255,255,.62);backdrop-filter:blur(14px) saturate(1.5);
    border-color:rgba(255,255,255,.95);box-shadow:0 2px 14px rgba(60,72,120,.12);}
  .trio-l1 .nm{width:var(--trio-nmw,44px);font-size:12.5px;font-weight:500;flex:none;text-align:right;color:#232946;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .trio-l1.on .nm{font-weight:600;}
  .trio-l1 .tr{flex:1;height:11px;background:var(--tbar);border-radius:6px;overflow:hidden;}
  .trio-l1 .fl{height:100%;border-radius:6px;background:var(--plat,#6c5ce7);opacity:.50;transition:width .2s,opacity .15s;}
  .trio-l1.on .fl{opacity:.72;}
  .trio-l1 .ct{width:74px;font-size:11px;color:#4d5464;flex:none;text-align:right;white-space:nowrap;}
  /* 左栏顶部字段 tab（形态 B） */
  .trio-tabs{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 9px;flex:none;}
  .trio-tabbtn{font-size:11.5px;padding:4px 11px;border-radius:999px;cursor:pointer;
    color:#232946;background:rgba(255,255,255,.28);backdrop-filter:blur(12px) saturate(1.4);
    border:1px solid rgba(255,255,255,.60);transition:all .15s;font-family:inherit;}
  .trio-tabbtn:hover{background:rgba(255,255,255,.52);}
  .trio-tabbtn.on{background:rgba(255,255,255,.88);font-weight:600;border-color:#fff;
    box-shadow:0 3px 12px rgba(60,72,120,.16);}
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
  .trio-dot{width:8px;height:8px;border-radius:2.5px;flex:none;background:var(--plat-soft,rgba(108,92,231,.5));}
  .trio-dimname{font-size:13px;font-weight:600;flex:none;color:var(--plat-deep,#6c5ce7);}
  .trio-panenote{font-size:10.5px;color:#4d5464;}
  /* 题材背景/情节走向 子分组行（维度内第二层 tab） */
  .trio-subrow{display:flex;flex-wrap:wrap;gap:5px;margin:-2px 0 8px;flex:none;}
  .trio-subbtn{font-size:10.5px;padding:2px 10px;border-radius:999px;cursor:pointer;border:0;
    color:#4d5464;background:rgba(255,255,255,.20);border:1px solid rgba(255,255,255,.5);
    transition:all .15s;font-family:inherit;}
  .trio-subbtn:hover{background:rgba(255,255,255,.5);color:#232946;}
  .trio-subbtn.on{background:rgba(255,255,255,.88);color:#232946;font-weight:600;border-color:#fff;
    box-shadow:0 2px 8px rgba(60,72,120,.14);}
  /* 二级母题行 */
  .trio-mrow{flex:1 1 auto;min-height:32px;max-height:160px;display:flex;align-items:center;gap:9px;
    padding:3px 2px;border-bottom:1px dashed var(--tline);}
  .trio-mrow:last-child{border-bottom:none;}
  .trio-mrow .mn{width:82px;font-size:12.5px;flex:none;color:#232946;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .trio-mrow .mbar{flex:1;height:6.5px;background:var(--tbar);border-radius:4px;overflow:hidden;}
  .trio-mrow .mfl{height:100%;border-radius:4px;min-width:2px;background:var(--plat-soft,rgba(108,92,231,.5));}
  .trio-mrow .mv{font-size:12px;font-weight:500;flex:none;text-align:right;white-space:nowrap;color:#232946;}
  .trio-mv-up{color:var(--green);font-size:11px;font-weight:600;margin-left:4px;}
  .trio-mv-dn{color:var(--red);font-size:11px;font-weight:600;margin-left:4px;}
  .trio-mv-eq{color:#4d5464;font-size:10.5px;margin-left:4px;}
  .trio-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:11.5px;color:#4d5464;padding:14px 0;}
  .trio-note{flex:none;margin-top:8px;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.42);
    border:1px solid rgba(255,255,255,.6);font-size:10.5px;line-height:1.5;color:#4d5464;}
  @media(max-width:1180px){.trio-root{grid-template-columns:1fr 1fr;}.trio-root .trio-col:nth-child(3){grid-column:1/-1;}}
  @media(max-width:820px){.trio-root{grid-template-columns:1fr;}.trio-root .trio-col:nth-child(3){grid-column:auto;}}`;

  if (!document.getElementById("trio-embed-css")) {
    const st = document.createElement("style");
    st.id = "trio-embed-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 词典/books 加载（按 url 缓存，多平台共存互不串） ---------- */
  const _dictCache = Object.create(null);
  function loadDict(url) {
    const _dkey = url || "data/cp_motifs_v3.json";
    if (!_dictCache[_dkey]) {
      _dictCache[_dkey] = fetch(_dkey).then(r => {
        if (!r.ok) throw new Error("dict " + r.status);
        return r.json();
      }).then(d => {
        // 维度声明：优先词典，缺失回退长佩 7 维（cp v3 词典兼容）
        let dims = Array.isArray(d.dims) && d.dims.length ? d.dims : LEGACY_DIMS;
        dims = dims.map(x => ({ name: x.name, group: x.group === "P" ? "P" : "S", subs: x.subs || null }));
        const dimOf = {}, subOf = {};
        for (const m of d.motifs || []) { dimOf[m.name] = m.dim; if (m.sub) subOf[m.name] = m.sub; }
        const alias2motif = {};
        for (const m of d.motifs || []) {
          alias2motif[m.name] = m.name;
          (m.aliases || []).forEach(a => { alias2motif[a] = m.name; });
        }
        const S = dims.filter(x => x.group === "S").map(x => x.name);
        const P = dims.filter(x => x.group === "P").map(x => x.name);
        const subsOf = {};
        dims.forEach(x => { if (x.subs && x.subs.length) subsOf[x.name] = x.subs; });
        const defaultDim = d.defaultDim && S.indexOf(d.defaultDim) >= 0 ? d.defaultDim : (S.indexOf("题材背景") >= 0 ? "题材背景" : S[0]);
        const l1Set = new Set((d.L1 || []).map(x => x.name));
        // 启用池：词典里 status 标「排除」的一级词（如晋江的「未知」）不参与聚合
        const l1Enabled = new Set((d.L1 || []).filter(x => x.status !== "排除").map(x => x.name));
        return {
          S, P, subsOf, defaultDim, dimOf, subOf, alias2motif, l1Set, l1Enabled,
          l1Field: d.l1Field || "tags0",
          l1Tabs: d.l1Tabs && d.l1Tabs.field ? { field: d.l1Tabs.field, tags: d.l1Tabs.tags || null } : null,
          l2Bars: d.l2Bars && d.l2Bars.field ? { field: d.l2Bars.field, mode: d.l2Bars.mode || "field" } : null,
          baseline: d.baseline || "global",
          tabUnit: d.tabUnit || "频道",
          barsNote: d.barsNote || "",
          l1OrderAll: (d.L1 || []).filter(x => x.status !== "排除").map(x => x.name)
        };
      }).catch(e => { delete _dictCache[_dkey]; throw e; });
    }
    return _dictCache[_dkey];
  }
  function loadBooks(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error("books " + r.status);
      return r.json();
    }).then(d => d.books || (d.data && d.data.books) || []);
  }

  /* ---------- 母题扫描区段 ----------
   * tags0    → 跳过 tags[0]（长佩：频道首位）
   * channel  → 跳过官方 4 词链（晋江：[原创,频道,era,theme,L3…]）
   * tagmatch → 全扫，命中 L1 池的词跳过（番茄多标签主分类）
   */
  function motifSource(ts, rule, l1Set) {
    if (rule === "tags0") return ts.slice(1);
    if (rule === "channel") return ts.slice(4);
    return ts.filter(t => !(l1Set && l1Set.has(t)));
  }
  function collectMotifs(b, dict, dedupe) {
    const ts = b.tags || b.all_tags || [];
    const src = motifSource(ts, dict.l1Field, dict.l1Set);
    const out = [];
    if (!dedupe) {
      for (const t of src) { const m = dict.alias2motif[t]; if (m) out.push(m); }
      return out;
    }
    const seen = {};
    for (const t of src) {
      const m = dict.alias2motif[t];
      if (!m || seen[m]) continue;
      seen[m] = 1; out.push(m);
    }
    return out;
  }

  /* ---------- 聚合 A：一级 bar 列表形态（长佩 / 番茄，v2 原逻辑） ---------- */
  function l1Of(b, ts, rule, l1Set) {
    if (rule === "channel") {
      const v = (b.channel || "").trim();
      return v ? [v] : [];
    }
    if (rule === "tagmatch") {
      const out = [];
      for (const t of ts) if (l1Set && l1Set.has(t)) out.push(t);
      return out;
    }
    const first = (ts[0] || "").trim();
    return first ? [first] : [];
  }

  function aggregateLegacy(books, dict) {
    const l1Rule = dict.l1Field;
    const ctxN = { "全站": books.length };
    const ctxL1 = {};          // 频道 → 书数
    const gCount = {};         // 母题 → 全站命中书数
    const cCount = {};         // 频道 → 母题 → 命中书数
    for (const b of books) {
      const ts = b.tags || b.all_tags || [];
      const l1s = l1Of(b, ts, l1Rule, dict.l1Set);
      if (!l1s.length) continue;
      l1s.forEach(l1 => { ctxL1[l1] = (ctxL1[l1] || 0) + 1; ctxN[l1] = (ctxN[l1] || 0) + 1; });
      // 同书同母题去重：仅 tagmatch（番茄多标签）需要；tags0/channel 维持 v1 原计数口径（长佩零回归）
      const sbook = b.book_name || b.book_id || "";
      const motifSeen = l1Rule === "tagmatch" ? {} : null;
      for (const t of motifSource(ts, l1Rule, dict.l1Set)) {
        const m = dict.alias2motif[t];
        if (!m) continue;
        if (motifSeen) {
          const k = m + SEP + sbook;
          if (motifSeen[k]) continue;
          motifSeen[k] = 1;
        }
        gCount[m] = (gCount[m] || 0) + 1;
        l1s.forEach(l1 => { if (!cCount[l1]) cCount[l1] = {}; cCount[l1][m] = (cCount[l1][m] || 0) + 1; });
      }
    }
    const l1Order = Object.entries(ctxL1).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    function pctRows(countMap, den) {
      if (!den) return [];
      return Object.entries(countMap).map(([m, c]) => [m, Math.round(100 * c / den)])
        .filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    }
    const gRows = pctRows(gCount, books.length);
    const dims = {};
    for (const dimName of dict.S.concat(dict.P)) {
      const rowsAll = gRows.filter(([m]) => dict.dimOf[m] === dimName);
      const mCtx = {};
      for (const ctx of Object.keys(cCount)) {
        mCtx[ctx] = pctRows(cCount[ctx], ctxN[ctx]).filter(([m]) => dict.dimOf[m] === dimName);
      }
      dims[dimName] = { all: rowsAll, ctx: mCtx };
    }
    return { mode: "list", N: books.length, l1Order, ctxN, dims, dict };
  }

  /* ---------- 聚合 B：字段 tab + 字段 bar 列表形态（晋江） ----------
   * 语境键 = tab + SEP + theme；SEP 两侧均可为 TAB_ALL
   * 偏差基准 = 当前 tab 内占比（theme 置为全部的那一档）
   */
  function aggregateTab(books, dict) {
    const tf = dict.l1Tabs.field, bf = dict.l2Bars.field;
    const K = (a, b) => a + SEP + b;
    const ctxN = {}, ctxM = {};
    const tabN = {}, themeN = {};
    let included = 0;
    for (const b of books) {
      const tab = String(b[tf] == null ? "" : b[tf]).trim();
      const theme = String(b[bf] == null ? "" : b[bf]).trim();
      // 非榜单题材内容（如晋江「未知」频道的随笔/评论）整本剔除，保证 tab 合计 = 全站
      if (!tab) continue;
      if (dict.l1Enabled && dict.l1Enabled.size && !dict.l1Enabled.has(tab)) continue;
      included++;
      const ms = collectMotifs(b, dict, true);
      const keys = [K(TAB_ALL, TAB_ALL), K(tab, TAB_ALL)];
      if (theme) { keys.push(K(TAB_ALL, theme)); keys.push(K(tab, theme)); }
      for (const kk of keys) {
        if (!ctxN[kk]) { ctxN[kk] = 0; ctxM[kk] = {}; }
        ctxN[kk]++;
        for (const m of ms) ctxM[kk][m] = (ctxM[kk][m] || 0) + 1;
      }
      tabN[tab] = (tabN[tab] || 0) + 1;
      if (theme) themeN[theme] = (themeN[theme] || 0) + 1;
    }
    const tabOrder = Object.entries(tabN).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const allThemes = Object.entries(themeN).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const themesByTab = {};
    themesByTab[TAB_ALL] = allThemes.map(t => [t, ctxN[K(TAB_ALL, t)] || 0]).filter(x => x[1] > 0);
    for (const t of tabOrder) {
      const arr = [];
      for (const th of allThemes) {
        const n = ctxN[K(t, th)];
        if (n) arr.push([th, n]);
      }
      themesByTab[t] = arr.sort((a, b) => b[1] - a[1]);
    }
    return { mode: "tab", N: included, tabOrder, themesByTab, ctxN, ctxM, dict, tf, bf };
  }

  /* ---------- 聚合 C：标签命中 tab + 一级词 first-hit 列表（番茄） ----------
   * tab   = 书含 dict.l1Tabs.tags 任一标签即入该赛道（可重叠，live 实测 160 本 → 180 语境）
   * 列表行 = 一级池 24 词的 first-hit 归位（按书标签顺序取首个命中），单值 → 合计 = 赛道书数
   * 池外书归「其他」行。偏差基准固定 = 全站（L1 是横切口径，拿赛道自身当基线会洗掉横切词）
   */
  function aggregateTaghit(books, dict) {
    const tabTags = (dict.l1Tabs && dict.l1Tabs.tags) || [];
    const K = (a, b) => a + SEP + b;
    const OTHER = "其他";
    const ctxN = {}, ctxM = {};
    const tabN = {}, barN = {};
    let included = 0;
    for (const b of books) {
      const ts = b.tags || b.all_tags || [];
      if (!ts.length) continue;
      included++;
      // 一级词 first-hit：按书本标签顺序取首个命中一级池的词
      let row = null;
      for (const t of ts) { if (dict.l1Set.has(t)) { row = t; break; } }
      const rk = row || OTHER;
      barN[rk] = (barN[rk] || 0) + 1;
      const ms = collectMotifs(b, dict, true);
      const tabs = [TAB_ALL];
      for (const t of tabTags) if (ts.indexOf(t) >= 0) tabs.push(t);
      for (const tb of tabs) {
        tabN[tb] = (tabN[tb] || 0) + 1;
        const keys = [K(tb, TAB_ALL), K(tb, rk)];
        for (const kk of keys) {
          if (!ctxN[kk]) { ctxN[kk] = 0; ctxM[kk] = {}; }
          ctxN[kk]++;
          for (const m of ms) ctxM[kk][m] = (ctxM[kk][m] || 0) + 1;
        }
      }
    }
    const allRows = (dict.l1OrderAll || []).concat([OTHER]);
    const rowsIn = tk => allRows.filter(r => ctxN[K(tk, r)])
      .map(r => [r, ctxN[K(tk, r)]]).sort((a, b) => b[1] - a[1]);
    const themesByTab = {};
    themesByTab[TAB_ALL] = rowsIn(TAB_ALL);
    // tab 顺序按词典声明（不随数据量漂移），无数据的赛道不显示
    const tabOrder = tabTags.filter(t => tabN[t] > 0);
    for (const t of tabOrder) themesByTab[t] = rowsIn(t);
    return { mode: "tab", baseIsAll: true, N: included, tabOrder, themesByTab, ctxN, ctxM, dict,
             tf: (dict.l1Tabs && dict.l1Tabs.field) || "taghit", bf: "firsthit" };
  }

  function aggregate(books, dict) {
    if (!(dict.l1Tabs && dict.l2Bars)) return aggregateLegacy(books, dict);
    // taghit：tab 与列表行都是「标签命中」语义（番茄：情感向 tab + 一级词列表）
    if (dict.l1Tabs.field === "taghit" || (dict.l2Bars && dict.l2Bars.mode === "firsthit")) {
      return aggregateTaghit(books, dict);
    }
    return aggregateTab(books, dict);
  }

  /* ---------- 渲染 ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function mountTrio(host, opts) {
    if (!host) return Promise.reject(new Error("mountTrio: no host"));
    opts = opts || {};
    const color = opts.color || "#6c5ce7";
    const height = opts.height || 380;
    const l1Label = opts.l1Label || "一级 · 频道";
    host.style.setProperty("--trio-h", height + "px");
    host.style.setProperty("--plat", color);
    if (opts.nmWidth) host.style.setProperty("--trio-nmw", opts.nmWidth + "px");
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), bl = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r)) { host.style.setProperty("--plat-soft", `rgba(${r},${g},${bl},.50)`); host.style.setProperty("--plat-deep", color); }

    return loadDict(opts.dictUrl).then(dict => {
      const booksReady = opts.books
        ? Promise.resolve(opts.books)
        : (opts.booksUrl ? loadBooks(opts.booksUrl) : Promise.resolve([]));
      return booksReady.then(books => {
        const A = aggregate(books, dict);
        if (!A.N) {
          host.innerHTML = '<div class="trio-empty" style="height:' + height + 'px;display:flex;align-items:center;justify-content:center;color:#4d5464;font-size:12px;">暂无书级数据，无法聚合题材分布</div>';
          return;
        }
        return A.mode === "tab" ? renderTabMode(host, A, { height, l1Label, color }) : renderListMode(host, A, { height, l1Label });
      });
    });
  }

  /* ===== 形态 A：一级 bar 列表（长佩 / 番茄） ===== */
  function renderListMode(host, A, opt) {
    const dict = A.dict;
    const STORY = dict.S, PERSON = dict.P;
    const subsOf = dict.subsOf;
    let ctx = "全站";
    let sIdx = Math.max(0, STORY.indexOf(dict.defaultDim));
    let pIdx = 0;
    let sSub = "all", pSub = "all";

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
      return Math.abs(d) >= 3 ? (d > 0 ? '<span class="trio-mv-up">\u25b2' + Math.round(d) + "</span>" : '<span class="trio-mv-dn">\u25bc' + Math.round(-d) + "</span>") : '<span class="trio-mv-eq">\u2248</span>';
    }
    function render() {
      const maxC = Math.max.apply(null, A.l1Order.map(k => A.ctxN[k]).concat([1]));
      const items = [["全站", A.N]].concat(A.l1Order.map(k => [k, A.ctxN[k]]));
      host.innerHTML = `<div class="trio-root">
        <div class="trio-col">
          <div class="trio-hd">${esc(opt.l1Label)}</div>
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
          ${subRowHTML("S")}
          <div class="trio-list" id="trio-list-S">${rowsHTML(STORY[sIdx], sSub)}</div>
        </div>
        <div class="trio-col">
          ${pillRowHTML("P")}
          ${paneHTML("P")}
          ${subRowHTML("P")}
          <div class="trio-list" id="trio-list-P">${rowsHTML(PERSON[pIdx], pSub)}</div>
        </div>
      </div>`;
      host.querySelectorAll(".trio-l1").forEach(el => {
        el.onclick = () => { ctx = el.dataset.ctx; render(); };
      });
      host.querySelectorAll(".trio-ctabtn").forEach(el => {
        el.onclick = () => {
          const grp = el.dataset.grp, i = +el.dataset.i;
          if (grp === "S") { sIdx = i; sSub = "all"; } else { pIdx = i; pSub = "all"; }
          render();
        };
      });
      host.querySelectorAll(".trio-subbtn").forEach(el => {
        el.onclick = () => {
          const grp = el.dataset.grp, sub = el.dataset.sub;
          if (grp === "S") sSub = sub; else pSub = sub;
          render();
        };
      });
    }
    function pillRowHTML(grp) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      return `<div class="trio-cta">${arr.map((n, i) =>
        `<button class="trio-ctabtn${i === cur ? " on" : ""}" data-grp="${grp}" data-i="${i}">${esc(n)}</button>`).join("")}</div>`;
    }
    function paneHTML(grp) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      const name = arr[cur];
      const label = ctx === "全站" ? `全站基线 ${A.N} 本` : `${ctx}频道 ${A.ctxN[ctx]} 本`;
      const note = ctx === "全站" ? "今日全站覆盖率排行（基线 · 无偏差）" : "覆盖率排行 · 相对全站偏差 \u25b2\u25bc";
      return `<div class="trio-panehd"><span class="trio-pill">${esc(label)}</span>
        <span class="trio-dot"></span><span class="trio-dimname">${esc(name)}</span>
        <span class="trio-panenote">${note}</span></div>`;
    }
    function subRowHTML(grp) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      const name = arr[cur];
      const subs = subsOf[name];
      const curSub = grp === "S" ? sSub : pSub;
      if (!subs || !subs.length) return "";
      return `<div class="trio-subrow">${["all"].concat(subs).map(sub =>
        `<button class="trio-subbtn${sub === curSub ? " on" : ""}" data-grp="${grp}" data-sub="${esc(sub)}">${sub === "all" ? "全部" : esc(sub)}</button>`).join("")}</div>`;
    }
    function rowsHTML(name, sub) {
      let rows = dimRows(name);
      if (sub !== "all") rows = rows.filter(([m]) => dict.subOf[m] === sub);
      if (!rows.length) return '<div class="trio-empty">该语境下此维度暂无上榜母题</div>';
      const mx = Math.max.apply(null, rows.map(x => x[1]).concat([1]));
      return rows.map(([m, p]) => {
        const dd = diffOf(name, m, p);
        const mark = ctx === "全站" ? "" : fmtD(dd);
        return `<div class="trio-mrow"><span class="mn">${esc(m)}</span>
          <div class="mbar"><div class="mfl" style="width:${Math.round(100 * p / mx)}%"></div></div>
          <span class="mv">${p}% ${mark}</span></div>`;
      }).join("");
    }
    render();
  }

  /* ===== 形态 B：字段 tab（频道）+ 字段 bar 列表（题材主题）（晋江） ===== */
  function renderTabMode(host, A, opt) {
    const dict = A.dict;
    const STORY = dict.S, PERSON = dict.P;
    const subsOf = dict.subsOf;
    const K = (a, b) => a + SEP + b;
    let tab = TAB_ALL, theme = TAB_ALL;
    let sIdx = Math.max(0, STORY.indexOf(dict.defaultDim));
    let pIdx = 0;
    let sSub = "all", pSub = "all";

    const curKey = () => K(tab, theme);
    // 形态 B（字段 tab）：基线 = 当前 tab 的「全部 theme」档（频道内基线）
    // 形态 C（taghit）：基线固定 = 全站（横切口径，赛道自身当基线会把横切词洗掉）
    const baseKey = () => (A.baseIsAll ? K(TAB_ALL, TAB_ALL) : K(tab, TAB_ALL));
    const denOf = k => A.ctxN[k] || 0;

    function ctxRows(key, dimName) {
      const den = denOf(key);
      if (!den) return [];
      const m = A.ctxM[key] || {};
      const out = [];
      for (const k in m) {
        if (dict.dimOf[k] !== dimName) continue;
        const p = 100 * m[k] / den;
        if (p > 0) out.push([k, p]);
      }
      return out.sort((a, b) => b[1] - a[1]);
    }
    function baseRowMap(dimName) {
      const den = denOf(baseKey());
      const m = A.ctxM[baseKey()] || {};
      const map = {};
      if (!den) return map;
      for (const k in m) if (dict.dimOf[k] === dimName) map[k] = 100 * m[k] / den;
      return map;
    }
    function fmtD(d) {
      if (d == null) return "";
      return Math.abs(d) >= 3 ? (d > 0 ? '<span class="trio-mv-up">\u25b2' + Math.round(d) + "</span>" : '<span class="trio-mv-dn">\u25bc' + Math.round(-d) + "</span>") : '<span class="trio-mv-eq">\u2248</span>';
    }
    function paneLabel() {
      const den = denOf(curKey());
      if (tab === TAB_ALL && theme === TAB_ALL) return `全站基线 ${A.N} 本`;
      if (theme === TAB_ALL) return `${tab}${A.dict.tabUnit} ${den} 本`;
      if (tab === TAB_ALL) return `${theme} · 全站 ${den} 本`;
      return `${tab} × ${theme} ${den} 本`;
    }
    function paneNote() {
      if (curKey() === baseKey()) return "今日覆盖率排行（基线 · 无偏差）";
      const bl = A.baseIsAll ? "全站" : (tab === TAB_ALL ? "全站" : tab + A.dict.tabUnit);
      return `覆盖率排行 · 相对${bl}基线 \u25b2\u25bc`;
    }

    function render() {
      const rows = A.themesByTab[tab] || [];
      const listItems = [[TAB_ALL, denOf(K(tab, TAB_ALL))]].concat(rows);
      const maxC = Math.max.apply(null, listItems.map(x => x[1]).concat([1]));
      const tabDen = denOf(K(tab, TAB_ALL)) || 1;
      host.innerHTML = `<div class="trio-root">
        <div class="trio-col">
          <div class="trio-tabs">${[TAB_ALL].concat(A.tabOrder).map(t =>
            `<button class="trio-tabbtn${t === tab ? " on" : ""}" data-tab="${esc(t)}">${esc(t)}</button>`).join("")}</div>
          <div class="trio-list">${listItems.map(([th, n]) => {
            const on = theme === th;
            return `<div class="trio-l1${on ? " on" : ""}" data-theme="${esc(th)}">
              <div class="nm">${esc(th)}</div>
              <div class="tr"><div class="fl" style="width:${Math.round(100 * n / maxC)}%"></div></div>
              <div class="ct">${n}本 · ${(Math.round(1000 * n / tabDen) / 10)}%</div></div>`;
          }).join("")}</div>
          ${noteHTML(rows)}
        </div>
        <div class="trio-col">
          ${pillRowHTML("S", curKey())}
          ${paneHTML("S", curKey())}
          ${subRowHTML("S")}
          <div class="trio-list" id="trio-list-S">${rowsHTML(STORY[sIdx], sSub, curKey(), baseKey())}</div>
        </div>
        <div class="trio-col">
          ${pillRowHTML("P", curKey())}
          ${paneHTML("P", curKey())}
          ${subRowHTML("P")}
          <div class="trio-list" id="trio-list-P">${rowsHTML(PERSON[pIdx], pSub, curKey(), baseKey())}</div>
        </div>
      </div>`;
      host.querySelectorAll(".trio-tabbtn").forEach(el => {
        el.onclick = () => { tab = el.dataset.tab; theme = TAB_ALL; render(); };
      });
      host.querySelectorAll(".trio-l1").forEach(el => {
        el.onclick = () => { theme = el.dataset.theme; render(); };
      });
      host.querySelectorAll(".trio-ctabtn").forEach(el => {
        el.onclick = () => {
          const grp = el.dataset.grp, i = +el.dataset.i;
          if (grp === "S") { sIdx = i; sSub = "all"; } else { pIdx = i; pSub = "all"; }
          render();
        };
      });
      host.querySelectorAll(".trio-subbtn").forEach(el => {
        el.onclick = () => {
          const grp = el.dataset.grp, sub = el.dataset.sub;
          if (grp === "S") sSub = sub; else pSub = sub;
          render();
        };
      });
    }
    function pillRowHTML(grp) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      return `<div class="trio-cta">${arr.map((n, i) =>
        `<button class="trio-ctabtn${i === cur ? " on" : ""}" data-grp="${grp}" data-i="${i}">${esc(n)}</button>`).join("")}</div>`;
    }
    function paneHTML(grp, key) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      const name = arr[cur];
      return `<div class="trio-panehd"><span class="trio-pill">${esc(paneLabel())}</span>
        <span class="trio-dot"></span><span class="trio-dimname">${esc(name)}</span>
        <span class="trio-panenote">${paneNote()}</span></div>`;
    }
    // 赛道内无题材细分（列表只剩「全部」+ 赛道自身一行）时补一句说明，避免看着像坏了
    function noteHTML(rows) {
      if (!A.dict.barsNote || tab === TAB_ALL) return "";
      if (rows.length !== 1 || rows[0][0] !== tab) return "";
      return `<div class="trio-note">${esc(A.dict.barsNote)}</div>`;
    }
    function subRowHTML(grp) {
      const arr = grp === "S" ? STORY : PERSON;
      const cur = grp === "S" ? sIdx : pIdx;
      const name = arr[cur];
      const subs = subsOf[name];
      const curSub = grp === "S" ? sSub : pSub;
      if (!subs || !subs.length) return "";
      return `<div class="trio-subrow">${["all"].concat(subs).map(sub =>
        `<button class="trio-subbtn${sub === curSub ? " on" : ""}" data-grp="${grp}" data-sub="${esc(sub)}">${sub === "all" ? "全部" : esc(sub)}</button>`).join("")}</div>`;
    }
    function rowsHTML(name, sub, key, bkey) {
      let rows = ctxRows(key, name);
      if (sub !== "all") rows = rows.filter(([m]) => dict.subOf[m] === sub);
      if (!rows.length) return '<div class="trio-empty">该语境下此维度暂无上榜母题</div>';
      const mx = Math.max.apply(null, rows.map(x => x[1]).concat([1]));
      const bmap = (key === bkey) ? null : baseRowMap(name);
      return rows.map(([m, p]) => {
        const dd = bmap ? ((bmap[m] == null) ? null : p - bmap[m]) : null;
        const mark = bmap ? fmtD(dd) : "";
        return `<div class="trio-mrow"><span class="mn">${esc(m)}</span>
          <div class="mbar"><div class="mfl" style="width:${Math.round(100 * p / mx)}%"></div></div>
          <span class="mv">${Math.round(p)}% ${mark}</span></div>`;
      }).join("");
    }
    render();
  }

  window.mountTrio = mountTrio;
})();
