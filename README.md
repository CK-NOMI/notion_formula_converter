# Notion Formula Converter

## 作用
把 Notion 页面中用这种写法的公式：

```
[s=(L-1)-r]
```

或：

```
[
s=(L-1)-r
]
```

批量转换成 Notion 原生 Equation（块公式/行内公式）。

适用于：
- Notion 网页版卡顿
- 大量笔记公式无法编辑
- 想用 App 流畅处理 + API 批量修复

---

## 展示图

### 运行转换结果

![运行转换结果](assets/demo-terminal-result.svg)

### Notion 页面已连接 Integration

![Notion 页面已连接 Integration](assets/demo-page-connection.svg)

### Integration 配置页面

![Integration 配置页面](assets/demo-integration-config.svg)

---

## Notion 开发者入口（官方）
👉 https://www.notion.so/my-integrations

---

## 使用步骤

### 1. 创建 Integration
进入：
https://www.notion.so/my-integrations

点击：
```
+ New integration
```

权限勾选：
- Read content
- Update content
- Insert content

复制 Token（ntn_xxx）

---

### 2. 授权页面
在 Notion App 打开你的页面：
- 点击右上角 `...`
- Connections / 连接
- 添加你的 integration

---

### 3. 安装 Node.js
确认版本：
```
node -v
```
>= 18

---

### 4. 运行（预览）

```
NOTION_TOKEN="你的token" node notion_formula_converter.js "页面URL"
```

---

### 5. 正式执行

```
NOTION_TOKEN="你的token" node notion_formula_converter.js "页面URL" --apply
```

---

## URL 支持
支持：
- https://app.notion.com/p/xxx
- https://www.notion.so/xxx-xxxxxxxx

---

## 安全提醒（非常重要）
⚠️ 不要把 token 发到聊天 / GitHub / 公共仓库

如果泄露：
👉 去 https://www.notion.so/my-integrations 重新生成

---

## 特性
- 自动识别 `[formula]`
- 支持 `[\n formula \n]` 三行结构
- 支持连续 block `[ + formula + ]`
- 自动过滤中文方括号（避免误转换）

---

## 推荐流程
1. 先 --dry-run
2. 检查数量
3. 再 --apply
