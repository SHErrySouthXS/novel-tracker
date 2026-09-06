# 前端文件保护红线（FRONTEND GUARD）

> **本仓库前端 = 单文件 `index.html` + `assets/` 目录。**
> **除 sherry 本人的主工作流外，任何其他 agent、自动化工具、脚本一律不得修改这两个对象。** 修改数据、爬虫、文档完全自由，唯独前端禁止。

## 为什么有这条红线

2026-09-06 曾发生事故：另一个 agent 基于**旧版** `index.html` 提交了新功能（commit `2b9e606`），
把已上线的玻璃主题覆盖层整段删掉（+36 / -278 行），线上瞬间回退成旧设计，需要人工恢复（commit `e6fec98`）。

为避免同类事故，本仓库配置了**部署层哨兵**：任何 push 若改动 `index.html` / `assets/`，
部署流水线会自动校验文件内是否保留设计签名：

- 签名 1：`bg-diffused-wide`（弥散背景引用）
- 签名 2：`alignBookItems`（书卡等高对齐 JS）

**签名缺失且提交信息不含 `[fe:authorized]` → 部署被拒绝，线上保持最新版本。**

## 前端文件的合法修改方式（仅限以下）

1. **唯一入口**：sherry 的主对话工作流（本仓库当前的玻璃主题即由此维护）。
2. **主动重设计**（有意废弃现有玻璃主题、重写成全新风格）：提交信息必须包含 `[fe:authorized]`，
   否则哨兵会判定为"误回退"而拒绝部署。
3. 任何 PR 形式的改动：前端文件所有者（CODEOWNERS）为 sherry，必须由她 review 后才可合并。

## 其他 agent 的正确姿势

- 要加平台 / 改榜单逻辑 / 改数据：改 `data/**`、`scrapers/**`、`*.json`，完全自由，不碰 `index.html`。
- 觉得前端"旧了 / 不好看 / 想顺手改样式"：**不要动**。把想法记在 issue 或告诉 sherry，
  由她的主工作流评估（历史上这类"顺手"改动已造成一次线上回退事故）。

## 哨兵细节（维护者备忘）

- 位置：`.github/workflows/deploy.yml` → `Frontend guard` step。
- 仅当 push 改动范围含 `index.html` / `assets/` 时触发；纯 `data/**` 更新（每日爬虫）直接放行。
- 逃生舱 token：`[fe:authorized]`（拼进 commit message）。
