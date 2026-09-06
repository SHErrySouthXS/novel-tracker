# 📚 Novel Tracker — 小说行业头部内容追踪

每日自动追踪 **番茄小说**、**起点中文网**、**晋江文学城** 三大平台的头部小说榜单（Top 50），提供跨平台对比分析。

## ✨ 功能特性

### 📊 Dashboard 概览
- 三站每日 Top10 速览
- 今日新上榜作品追踪
- 题材分布对比（横向柱状图）
- 各站内容特点自动总结
- 排名波动最大作品高亮
- 题材趋势折线图（近7日）

### 🔍 各站独立页面
- 完整 Top50 排名列表
- 排名变化（上升/下降/新上榜）
- 按题材/频道/状态筛选
- 按书名/作者搜索
- 历史数据回看（90天）
- 主标签 + 副标签体系

### 📈 数据分析
- 题材热度分布统计
- 频道（男频/女频/纯爱/言情）分布
- 新上榜作品题材分析
- 周报/月报趋势（需积累数据）

## 🏗️ 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 番茄爬虫 | Node.js 原生 | 零依赖，API + HTML 解析 |
| 起点爬虫 | Playwright | JS 动态渲染，完整数据 |
| 晋江爬虫 | Node.js 原生 | GBK 编码 HTML 解析 |
| 前端 | 纯 HTML/CSS/JS | 零框架，响应式设计 |
| 自动化 | GitHub Actions | 每日北京时间 15:00 运行 |
| 部署 | GitHub Pages | 免费静态托管 |

## 📁 项目结构

```
novel-tracker/
├── index.html              # 前端页面
├── scrapers/
│   ├── fanqie.js          # 番茄小说爬虫
│   ├── qidian.js          # 起点中文网爬虫
│   └── jjwxc.js           # 晋江文学城爬虫
├── data/
│   ├── fanqie/
│   │   ├── latest.json    # 最新数据
│   │   ├── history/       # 历史归档
│   │   └── history_index.json
│   ├── qidian/
│   │   └── ...
│   └── jjwxc/
│       └── ...
├── .github/workflows/
│   └── daily-scrape.yml   # 定时任务
├── package.json
└── README.md
```

## 🚀 快速开始

```bash
# 安装依赖
npm install
npx playwright install chromium

# 运行爬虫
npm run scrape:fanqie    # 番茄小说
npm run scrape:qidian    # 起点中文网
npm run scrape:jjwxc     # 晋江文学城
npm run scrape:all       # 全部运行

# 本地预览
npx serve .
# 或直接用浏览器打开 index.html
```

## 📋 数据字段

每本书统一包含以下字段：

| 字段 | 说明 |
|------|------|
| rank | 当日排名 |
| book_name | 书名 |
| author | 作者 |
| primary_tag | 主标签（题材） |
| secondary_tags | 副标签列表 |
| all_tags | 完整标签列表 |
| gender / channel | 频道（男频/女频/纯爱/言情等） |
| status | 状态（连载中/完结） |
| abstract | 简介 |
| rank_change | 排名变化（数字 或 "new"） |
| book_url | 原始链接 |

## ⚠️ 免责声明

本项目仅供**学习研究**使用，数据来源于各网站公开页面。请遵守各网站的使用条款，不要滥用。
