#!/usr/bin/env node
/*
 * Notion Formula Converter
 *
 * Convert bracket-style formulas in a Notion page into native Notion equation blocks / inline equations.
 * Supported inputs:
 *   [x = y + z]                 -> inline equation when embedded in a text block
 *   [\n x = y + z \n]           -> equation block when the whole text block is bracket-wrapped
 *   paragraph "[" + paragraph "x = y + z" + paragraph "]" -> equation block
 *
 * Requirements: Node.js 18+ because this script uses built-in fetch.
 */

'use strict';

const NOTION_VERSION = '2022-06-28';
const API_BASE = 'https://api.notion.com/v1';
const MAX_PAGE_SIZE = 100;
const SUPPORTED_RICH_TEXT_TYPES = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
]);

const BLOCK_TYPES_THAT_CAN_HAVE_CHILDREN = new Set([
  'page',
  'child_page',
  'child_database',
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'synced_block',
  'column_list',
  'column',
]);

function parseArgs(argv) {
  const args = {
    page: null,
    apply: false,
    recursive: true,
    verbose: false,
    includeInline: true,
    includeBlock: true,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--recursive') args.recursive = true;
    else if (arg === '--no-recursive') args.recursive = false;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--no-inline') args.includeInline = false;
    else if (arg === '--no-block') args.includeBlock = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!args.page) {
      args.page = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (!args.page) {
    printHelp();
    throw new Error('缺少 Notion 页面链接或页面 ID');
  }

  return args;
}

function printHelp() {
  console.log(`Notion Formula Converter\n\n用法：\n  NOTION_TOKEN="ntn_xxx" node notion_formula_converter.js "Notion页面链接或页面ID"\n  NOTION_TOKEN="ntn_xxx" node notion_formula_converter.js "Notion页面链接或页面ID" --apply\n\n参数：\n  --apply        正式修改 Notion 页面；不加时只预览\n  --dry-run      只预览，不修改页面\n  --recursive    递归处理子块，默认开启\n  --no-recursive 不递归处理子块\n  --no-inline    不转换段落内的 [公式] 行内公式\n  --no-block     不转换独立的 [ 公式 ] 块公式\n  --verbose, -v  输出更详细的扫描信息\n  --help, -h     查看帮助\n`);
}

function getToken() {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!token) {
    throw new Error('没有找到 NOTION_TOKEN。请用：NOTION_TOKEN="你的访问令牌" node notion_formula_converter.js "页面链接"');
  }
  return token.trim();
}

function extractNotionId(input) {
  const decoded = decodeURIComponent(input.trim());
  const compact = decoded.replace(/-/g, '');
  const matches = compact.match(/[0-9a-fA-F]{32}/g);
  if (!matches || matches.length === 0) {
    throw new Error(`无法从输入中识别 Notion 页面 ID：${input}`);
  }
  const id = matches[matches.length - 1].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function notionRequest(path, { method = 'GET', body = undefined, token } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data !== null
      ? `${data.code || response.status}：${data.message || text}`
      : `${response.status}：${text}`;
    throw new Error(`Notion API 请求失败 ${method} ${path}\n${message}`);
  }

  return data;
}

async function fetchChildren(blockId, token) {
  const results = [];
  let startCursor = null;

  do {
    const query = new URLSearchParams({ page_size: String(MAX_PAGE_SIZE) });
    if (startCursor) query.set('start_cursor', startCursor);
    const data = await notionRequest(`/blocks/${blockId}/children?${query.toString()}`, { token });
    results.push(...data.results);
    startCursor = data.has_more ? data.next_cursor : null;
  } while (startCursor);

  return results;
}

function getRichTextContainer(block) {
  if (!block || !block.type || !SUPPORTED_RICH_TEXT_TYPES.has(block.type)) {
    return null;
  }
  return block[block.type] || null;
}

function getRichText(block) {
  const container = getRichTextContainer(block);
  return Array.isArray(container?.rich_text) ? container.rich_text : [];
}

function getPlainText(block) {
  return getRichText(block).map((part) => part.plain_text || '').join('');
}

function isTextLikeBlock(block) {
  return !!getRichTextContainer(block);
}

function isParagraphOnly(block) {
  return block?.type === 'paragraph';
}

function normalizeFormula(formula) {
  return String(formula || '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function looksLikeFormula(text) {
  const s = normalizeFormula(text);
  if (!s) return false;
  if (s.length > 1000) return false;

  // 明显不是公式的中文/大段文字，避免把 [考试重点] 误转成公式。
  if (/^[\u4e00-\u9fff\s，。、“”‘’：；！？（）()【】]+$/.test(s)) return false;

  const mathSignals = [
    /[=<>≈≠≤≥]/,
    /\\[a-zA-Z]+/,
    /[\^_]/,
    /[+*/]/,
    /\d/,
    /[a-zA-Z]\s*[+\-*/=^_]/,
    /[+\-*/=^_]\s*[a-zA-Z]/,
    /\([^)]*\)/,
    /\{[^}]*\}/,
  ];

  return mathSignals.some((regex) => regex.test(s));
}

function matchWholeBracketFormula(text) {
  const s = String(text || '').trim();
  const match = s.match(/^\[\s*([\s\S]*?)\s*\]$/);
  if (!match) return null;
  const formula = normalizeFormula(match[1]);
  return looksLikeFormula(formula) ? formula : null;
}

function findInlineBracketFormulas(text) {
  const source = String(text || '');
  const pieces = [];
  let changed = false;
  let cursor = 0;

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '[') continue;
    if (i > 0 && source[i - 1] === '\\') continue;

    const close = source.indexOf(']', i + 1);
    if (close === -1) break;

    const rawFormula = source.slice(i + 1, close);
    const formula = normalizeFormula(rawFormula);

    // 行内转换只处理单行；多行交给块公式逻辑。
    if (!formula.includes('\n') && looksLikeFormula(formula)) {
      if (i > cursor) {
        pieces.push({ type: 'text', content: source.slice(cursor, i) });
      }
      pieces.push({ type: 'equation', content: formula });
      changed = true;
      cursor = close + 1;
      i = close;
    }
  }

  if (!changed) return null;

  if (cursor < source.length) {
    pieces.push({ type: 'text', content: source.slice(cursor) });
  }

  return pieces;
}

function toRichText(pieces) {
  return pieces
    .filter((piece) => piece.content !== '')
    .map((piece) => {
      if (piece.type === 'equation') {
        return { type: 'equation', equation: { expression: piece.content } };
      }
      return { type: 'text', text: { content: piece.content } };
    });
}

function makeEquationBlock(expression) {
  return {
    object: 'block',
    type: 'equation',
    equation: {
      expression: normalizeFormula(expression),
    },
  };
}

function canUpdateInline(block) {
  // 为了降低破坏复杂格式的风险，仅对文本块做 rich_text 更新。
  return isTextLikeBlock(block) && getPlainText(block).includes('[');
}

async function appendEquationAfter(parentId, afterBlockId, expression, token) {
  const body = {
    children: [makeEquationBlock(expression)],
  };
  if (afterBlockId) body.after = afterBlockId;
  return notionRequest(`/blocks/${parentId}/children`, {
    method: 'PATCH',
    body,
    token,
  });
}

async function archiveBlock(blockId, token) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: { archived: true },
    token,
  });
}

async function updateBlockRichText(block, richText, token) {
  const container = block[block.type] || {};
  const body = {
    [block.type]: {
      ...container,
      rich_text: richText,
    },
  };

  // API 不接受只读字段，保守删除可能出现的 children。
  delete body[block.type].children;

  return notionRequest(`/blocks/${block.id}`, {
    method: 'PATCH',
    body,
    token,
  });
}

class Converter {
  constructor({ token, apply, recursive, verbose, includeInline, includeBlock }) {
    this.token = token;
    this.apply = apply;
    this.recursive = recursive;
    this.verbose = verbose;
    this.includeInline = includeInline;
    this.includeBlock = includeBlock;
    this.stats = {
      scannedParents: 0,
      scannedBlocks: 0,
      blockEquations: 0,
      inlineBlocks: 0,
      archivedBlocks: 0,
      errors: 0,
    };
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  async run(pageId) {
    console.log(`页面 ID：${pageId}`);
    console.log(this.apply ? '模式：正式转换，会修改 Notion 页面' : '模式：预览，不会修改 Notion 页面');
    await this.processParent(pageId, 'page');
    this.printSummary();
  }

  async processParent(parentId, label = 'parent') {
    this.stats.scannedParents += 1;
    const children = await fetchChildren(parentId, this.token);
    this.stats.scannedBlocks += children.length;
    this.log(`扫描 ${label} ${parentId}，子块 ${children.length} 个`);

    const skip = new Set();

    if (this.includeBlock) {
      await this.convertThreeBlockFormulas(parentId, children, skip);
      await this.convertWholeBlockFormulas(parentId, children, skip);
    }

    if (this.includeInline) {
      await this.convertInlineFormulas(children, skip);
    }

    if (this.recursive) {
      for (const child of children) {
        if (skip.has(child.id)) continue;
        if (child.archived) continue;
        if (!child.has_children) continue;
        if (!BLOCK_TYPES_THAT_CAN_HAVE_CHILDREN.has(child.type)) continue;
        await this.processParent(child.id, child.type);
      }
    }
  }

  async convertThreeBlockFormulas(parentId, children, skip) {
    for (let i = 0; i <= children.length - 3; i++) {
      const open = children[i];
      const middle = children[i + 1];
      const close = children[i + 2];

      if (skip.has(open.id) || skip.has(middle.id) || skip.has(close.id)) continue;
      if (!isParagraphOnly(open) || !isParagraphOnly(middle) || !isParagraphOnly(close)) continue;

      const openText = getPlainText(open).trim();
      const formula = normalizeFormula(getPlainText(middle));
      const closeText = getPlainText(close).trim();

      if (openText === '[' && closeText === ']' && looksLikeFormula(formula)) {
        this.stats.blockEquations += 1;
        this.stats.archivedBlocks += 3;
        skip.add(open.id);
        skip.add(middle.id);
        skip.add(close.id);
        console.log(`块公式 #${this.stats.blockEquations}：${oneLine(formula)}`);

        if (this.apply) {
          await appendEquationAfter(parentId, close.id, formula, this.token);
          await archiveBlock(open.id, this.token);
          await archiveBlock(middle.id, this.token);
          await archiveBlock(close.id, this.token);
        }

        i += 2;
      }
    }
  }

  async convertWholeBlockFormulas(parentId, children, skip) {
    for (const block of children) {
      if (skip.has(block.id) || block.archived) continue;
      if (!isTextLikeBlock(block)) continue;

      const text = getPlainText(block);
      const formula = matchWholeBracketFormula(text);
      if (!formula) continue;

      // 如果是单行 [x=1] 且夹在普通段落里，本函数只处理整块内容。
      this.stats.blockEquations += 1;
      this.stats.archivedBlocks += 1;
      skip.add(block.id);
      console.log(`块公式 #${this.stats.blockEquations}：${oneLine(formula)}`);

      if (this.apply) {
        await appendEquationAfter(parentId, block.id, formula, this.token);
        await archiveBlock(block.id, this.token);
      }
    }
  }

  async convertInlineFormulas(children, skip) {
    for (const block of children) {
      if (skip.has(block.id) || block.archived) continue;
      if (!canUpdateInline(block)) continue;

      const text = getPlainText(block);
      const formula = matchWholeBracketFormula(text);
      if (formula) continue; // 整块公式已交给块公式逻辑。

      const pieces = findInlineBracketFormulas(text);
      if (!pieces) continue;

      const count = pieces.filter((piece) => piece.type === 'equation').length;
      this.stats.inlineBlocks += 1;
      console.log(`行内公式块 #${this.stats.inlineBlocks}：${count} 个公式，文本：${oneLine(text)}`);

      if (this.apply) {
        const richText = toRichText(pieces);
        await updateBlockRichText(block, richText, this.token);
      }
    }
  }

  printSummary() {
    console.log('\n========== 结果 ==========' );
    console.log(`扫描父级：${this.stats.scannedParents}`);
    console.log(`扫描块数：${this.stats.scannedBlocks}`);
    console.log(`将转换为块公式：${this.stats.blockEquations}`);
    console.log(`将更新行内公式文本块：${this.stats.inlineBlocks}`);
    console.log(`将归档原始文本块：${this.stats.archivedBlocks}`);
    console.log(this.apply ? '已执行正式转换。请回到 Notion App 等待同步。' : '当前只是预览。确认无误后加 --apply 正式转换。');
  }
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = getToken();
  const pageId = extractNotionId(args.page);

  const converter = new Converter({
    token,
    apply: args.apply,
    recursive: args.recursive,
    verbose: args.verbose,
    includeInline: args.includeInline,
    includeBlock: args.includeBlock,
  });

  await converter.run(pageId);
}

main().catch((error) => {
  console.error('\n运行失败：');
  console.error(error.message || error);
  process.exit(1);
});
