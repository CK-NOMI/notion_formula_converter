#!/usr/bin/env node
/*
 * Notion Formula Converter
 *
 * Convert formula text in a Notion page into native Notion equation blocks / inline equations.
 * Requirements: Node.js 18+ because this script uses built-in fetch.
 */

'use strict';

const NOTION_VERSION = '2022-06-28';
const API_BASE = 'https://api.notion.com/v1';
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_GROUP_BLOCKS = 80;

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
    smartMath: false,
    cleanupBrackets: false,
    maxGroupBlocks: DEFAULT_MAX_GROUP_BLOCKS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--recursive') args.recursive = true;
    else if (arg === '--no-recursive') args.recursive = false;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--no-inline') args.includeInline = false;
    else if (arg === '--no-block') args.includeBlock = false;
    else if (arg === '--smart-math') args.smartMath = true;
    else if (arg === '--cleanup-brackets') args.cleanupBrackets = true;
    else if (arg === '--aggressive') {
      args.smartMath = true;
      args.cleanupBrackets = true;
    } else if (arg === '--max-group-blocks') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isFinite(value) || value < 3) throw new Error('--max-group-blocks 后面需要一个 >= 3 的数字');
      args.maxGroupBlocks = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
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
  console.log(`Notion Formula Converter\n\n用法：\n  NOTION_TOKEN="ntn_xxx" node notion_formula_converter.js "页面URL"\n  NOTION_TOKEN="ntn_xxx" node notion_formula_converter.js "页面URL" --aggressive --apply\n\n参数：\n  --apply              正式修改 Notion 页面；不加时只预览\n  --dry-run            只预览，不修改页面\n  --recursive          递归处理子块，默认开启\n  --no-recursive       不递归处理子块\n  --no-inline          不转换段落内的 [公式] 行内公式\n  --no-block           不转换独立的 [ 公式 ] 块公式\n  --smart-math         识别没有 [ ] 包裹的明显 LaTeX/矩阵/等式块\n  --cleanup-brackets   清理孤立的 [ 和 ] 段落\n  --aggressive         等于 --smart-math --cleanup-brackets\n  --max-group-blocks N 最多把 N 个连续块视作一个 [ ... ] 公式组，默认 ${DEFAULT_MAX_GROUP_BLOCKS}\n  --verbose, -v        输出更详细的扫描信息\n  --help, -h           查看帮助\n`);
}

function getToken() {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!token) throw new Error('没有找到 NOTION_TOKEN。请用：NOTION_TOKEN="你的访问令牌" node notion_formula_converter.js "页面链接"');
  return token.trim();
}

function extractNotionId(input) {
  const decoded = decodeURIComponent(input.trim());
  const compact = decoded.replace(/-/g, '');
  const matches = compact.match(/[0-9a-fA-F]{32}/g);
  if (!matches || matches.length === 0) throw new Error(`无法从输入中识别 Notion 页面 ID：${input}`);
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
    try { data = JSON.parse(text); } catch { data = text; }
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
  if (!block || !block.type || !SUPPORTED_RICH_TEXT_TYPES.has(block.type)) return null;
  return block[block.type] || null;
}

function getRichText(block) {
  const container = getRichTextContainer(block);
  return Array.isArray(container?.rich_text) ? container.rich_text : [];
}

function getPlainText(block) {
  return getRichText(block).map((part) => part.plain_text || '').join('');
}

function isTextLikeBlock(block) { return !!getRichTextContainer(block); }
function isParagraphOnly(block) { return block?.type === 'paragraph'; }

function normalizeFormula(formula) {
  return String(formula || '').replace(/^\s+|\s+$/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function removeOuterDollarOrBrackets(text) {
  let s = normalizeFormula(text);
  if (/^\$\$[\s\S]*\$\$$/.test(s)) s = normalizeFormula(s.slice(2, -2));
  if (/^\$[^$][\s\S]*[^$]\$$/.test(s)) s = normalizeFormula(s.slice(1, -1));
  if (/^\\\[[\s\S]*\\\]$/.test(s)) s = normalizeFormula(s.slice(2, -2));
  if (/^\\\([\s\S]*\\\)$/.test(s)) s = normalizeFormula(s.slice(2, -2));
  return s;
}

function isStandaloneBracket(text) {
  const s = String(text || '').trim();
  return s === '[' || s === ']' || s === '［' || s === '］';
}
function isOpenBracket(text) { const s = String(text || '').trim(); return s === '[' || s === '［'; }
function isCloseBracket(text) { const s = String(text || '').trim(); return s === ']' || s === '］'; }

function hasChineseSentence(text) {
  const s = String(text || '').trim();
  const chineseCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseCount === 0) return false;
  return chineseCount >= 4 || /[，。！？；：、]/.test(s);
}

function isLikelyPathOrUrl(text) {
  const s = String(text || '').trim();
  if (/^https?:\/\//i.test(s)) return true;
  if (/^\.?\.?\//.test(s) || /\/Users\/|\\/.test(s)) return true;
  if (/\.(html?|md|pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|svg|js|ts|css|py|java|cpp|c|json)$/i.test(s)) return true;
  if (/^[\w.-]+\.(html?|md|pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|svg|js|ts|css|py|java|cpp|c|json)$/i.test(s)) return true;
  return false;
}

function looksLikeFormula(text) {
  const s = removeOuterDollarOrBrackets(text);
  if (!s) return false;
  if (s.length > 1600) return false;
  if (isLikelyPathOrUrl(s)) return false;

  // 明显不是公式的中文标题/说明，避免把 [考试重点] 误转成公式。
  if (/^[\u4e00-\u9fff\s，。、“”‘’：；！？（）()【】]+$/.test(s)) return false;
  if (hasChineseSentence(s) && !/[=<>≈≠≤≥]|\\[a-zA-Z]+|[\^_]/.test(s)) return false;

  const strongSignals = [
    /\\begin\s*\{[^}]+\}/,
    /\\end\s*\{[^}]+\}/,
    /\\frac\s*\{/,
    /\\sum|\\prod|\\int|\\lim|\\sqrt|\\theta|\\gamma|\\sigma|\\mu|\\alpha|\\beta|\\lambda|\\rightarrow|\\Rightarrow|\\vdots|\\cdots|\\dots/,
    /[A-Za-z0-9}\])']\s*=\s*[-+\\A-Za-z0-9{(]/,
    /[=<>≈≠≤≥]/,
    /[A-Za-z]\s*_\s*\{/,
    /[A-Za-z]\s*\^\s*\{/,
    /\\\\/,
    /\s&\s/,
  ];

  const weakSignals = [/[\^_]/, /[+*/]/, /\d/, /[a-zA-Z]\s*[+\-*/=^_]/, /[+\-*/=^_]\s*[a-zA-Z]/, /\([^)]*\)/, /\{[^}]*\}/];
  if (strongSignals.some((regex) => regex.test(s))) return true;
  const weakCount = weakSignals.reduce((sum, regex) => sum + (regex.test(s) ? 1 : 0), 0);
  return weakCount >= 2 && !hasChineseSentence(s);
}

function looksLikeFormulaLine(text) {
  const s = removeOuterDollarOrBrackets(text);
  if (!s) return false;
  if (isStandaloneBracket(s)) return false;
  if (hasChineseSentence(s)) return false;
  if (isLikelyPathOrUrl(s)) return false;
  if (/^[-—–•·]+$/.test(s)) return false;

  return looksLikeFormula(s)
    || /^\\(begin|end)\s*\{/.test(s)
    || /^\\(vdots|cdots|dots|ldots)\\?$/.test(s)
    || /^[-+]?\d+(\.\d+)?\s*&/.test(s)
    || /&\s*[-+]?\d+(\.\d+)?\\?$/.test(s)
    || /^[A-Za-z](_\{[^}]+\}|_\w|\^\{[^}]+\}|\^\w)?\s*=/.test(s)
    || /\\[a-zA-Z]+/.test(s);
}

function matchWholeBracketFormula(text) {
  const s = String(text || '').trim();
  const match = s.match(/^[\[［]\s*([\s\S]*?)\s*[\]］]$/);
  if (!match) return null;
  const formula = removeOuterDollarOrBrackets(match[1]);
  return looksLikeFormula(formula) ? formula : null;
}

function isMarkdownLinkClose(source, closeIndex) {
  return source[closeIndex + 1] === '(';
}

function findInlineBracketFormulas(text) {
  const source = String(text || '');
  const pieces = [];
  let changed = false;
  let cursor = 0;

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '[' && source[i] !== '［') continue;
    if (i > 0 && source[i - 1] === '\\') continue;

    const closeAscii = source.indexOf(']', i + 1);
    const closeChinese = source.indexOf('］', i + 1);
    const close = [closeAscii, closeChinese].filter((value) => value !== -1).sort((a, b) => a - b)[0];
    if (close === undefined) break;
    if (isMarkdownLinkClose(source, close)) {
      i = close;
      continue;
    }

    const rawFormula = source.slice(i + 1, close);
    const formula = removeOuterDollarOrBrackets(rawFormula);

    if (!formula.includes('\n') && looksLikeFormula(formula)) {
      if (i > cursor) pieces.push({ type: 'text', content: source.slice(cursor, i) });
      pieces.push({ type: 'equation', content: formula });
      changed = true;
      cursor = close + 1;
      i = close;
    }
  }

  if (!changed) return null;
  if (cursor < source.length) pieces.push({ type: 'text', content: source.slice(cursor) });
  return pieces;
}

function toRichText(pieces) {
  return pieces.filter((piece) => piece.content !== '').map((piece) => {
    if (piece.type === 'equation') return { type: 'equation', equation: { expression: piece.content } };
    return { type: 'text', text: { content: piece.content } };
  });
}

function makeEquationBlock(expression) {
  return { object: 'block', type: 'equation', equation: { expression: removeOuterDollarOrBrackets(expression) } };
}

function canUpdateInline(block) {
  const text = getPlainText(block);
  return isTextLikeBlock(block) && (text.includes('[') || text.includes('［'));
}

async function appendEquationAfter(parentId, afterBlockId, expression, token) {
  const body = { children: [makeEquationBlock(expression)] };
  if (afterBlockId) body.after = afterBlockId;
  return notionRequest(`/blocks/${parentId}/children`, { method: 'PATCH', body, token });
}

async function archiveBlock(blockId, token) {
  return notionRequest(`/blocks/${blockId}`, { method: 'PATCH', body: { archived: true }, token });
}

function buildRichTextUpdatePayload(block, richText) {
  const current = block[block.type] || {};
  const payload = { rich_text: richText };
  if (typeof current.color === 'string') payload.color = current.color;
  if (block.type === 'to_do' && typeof current.checked === 'boolean') payload.checked = current.checked;
  if (block.type.startsWith('heading_') && typeof current.is_toggleable === 'boolean') payload.is_toggleable = current.is_toggleable;
  // Notion API rejects icon: null, so copy callout icon only when it is a real object.
  if (block.type === 'callout' && current.icon && typeof current.icon === 'object') payload.icon = current.icon;
  return { [block.type]: payload };
}

async function updateBlockRichText(block, richText, token) {
  return notionRequest(`/blocks/${block.id}`, { method: 'PATCH', body: buildRichTextUpdatePayload(block, richText), token });
}

class Converter {
  constructor({ token, apply, recursive, verbose, includeInline, includeBlock, smartMath, cleanupBrackets, maxGroupBlocks }) {
    this.token = token;
    this.apply = apply;
    this.recursive = recursive;
    this.verbose = verbose;
    this.includeInline = includeInline;
    this.includeBlock = includeBlock;
    this.smartMath = smartMath;
    this.cleanupBrackets = cleanupBrackets;
    this.maxGroupBlocks = maxGroupBlocks;
    this.stats = { scannedParents: 0, scannedBlocks: 0, blockEquations: 0, inlineBlocks: 0, smartEquations: 0, cleanedBrackets: 0, archivedBlocks: 0, errors: 0 };
  }

  log(...args) { if (this.verbose) console.log(...args); }

  async run(pageId) {
    console.log(`页面 ID：${pageId}`);
    console.log(this.apply ? '模式：正式转换，会修改 Notion 页面' : '模式：预览，不会修改 Notion 页面');
    console.log(`智能裸公式识别：${this.smartMath ? '开启' : '关闭'}；孤立括号清理：${this.cleanupBrackets ? '开启' : '关闭'}`);
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
      await this.convertBracketGroups(parentId, children, skip);
      await this.convertWholeBlockFormulas(parentId, children, skip);
    }
    if (this.includeInline) await this.convertInlineFormulas(children, skip);
    if (this.smartMath) await this.convertBareFormulaRuns(parentId, children, skip);
    if (this.cleanupBrackets) await this.cleanupStandaloneBracketBlocks(children, skip);

    if (this.recursive) {
      for (const child of children) {
        if (skip.has(child.id) || child.archived || !child.has_children || !BLOCK_TYPES_THAT_CAN_HAVE_CHILDREN.has(child.type)) continue;
        await this.processParent(child.id, child.type);
      }
    }
  }

  async convertBracketGroups(parentId, children, skip) {
    for (let i = 0; i < children.length; i += 1) {
      const open = children[i];
      if (skip.has(open.id) || open.archived) continue;
      if (!isParagraphOnly(open) || !isOpenBracket(getPlainText(open))) continue;

      let closeIndex = -1;
      const formulaBlocks = [];
      for (let j = i + 1; j < children.length && j <= i + this.maxGroupBlocks; j += 1) {
        const candidate = children[j];
        if (skip.has(candidate.id) || candidate.archived || !isParagraphOnly(candidate)) break;
        const text = getPlainText(candidate).trim();
        if (isCloseBracket(text)) { closeIndex = j; break; }
        formulaBlocks.push(candidate);
      }
      if (closeIndex === -1 || formulaBlocks.length === 0) continue;
      const formula = normalizeFormula(formulaBlocks.map(getPlainText).join('\n'));
      if (!looksLikeFormula(formula)) continue;

      const blocksToArchive = [open, ...formulaBlocks, children[closeIndex]];
      this.stats.blockEquations += 1;
      this.stats.archivedBlocks += blocksToArchive.length;
      for (const block of blocksToArchive) skip.add(block.id);
      console.log(`块公式 #${this.stats.blockEquations}：${oneLine(formula)}`);

      if (this.apply) {
        await appendEquationAfter(parentId, children[closeIndex].id, formula, this.token);
        for (const block of blocksToArchive) await archiveBlock(block.id, this.token);
      }
      i = closeIndex;
    }
  }

  async convertWholeBlockFormulas(parentId, children, skip) {
    for (const block of children) {
      if (skip.has(block.id) || block.archived || !isTextLikeBlock(block)) continue;
      const formula = matchWholeBracketFormula(getPlainText(block));
      if (!formula) continue;
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
      if (skip.has(block.id) || block.archived || !canUpdateInline(block)) continue;
      const text = getPlainText(block);
      if (matchWholeBracketFormula(text)) continue;
      const pieces = findInlineBracketFormulas(text);
      if (!pieces) continue;
      const count = pieces.filter((piece) => piece.type === 'equation').length;
      this.stats.inlineBlocks += 1;
      console.log(`行内公式块 #${this.stats.inlineBlocks}：${count} 个公式，文本：${oneLine(text)}`);
      if (this.apply) await updateBlockRichText(block, toRichText(pieces), this.token);
    }
  }

  async convertBareFormulaRuns(parentId, children, skip) {
    let i = 0;
    while (i < children.length) {
      const block = children[i];
      if (skip.has(block.id) || block.archived || !isParagraphOnly(block) || !looksLikeFormulaLine(getPlainText(block).trim())) { i += 1; continue; }

      const run = [block];
      let j = i + 1;
      while (j < children.length && run.length < this.maxGroupBlocks) {
        const next = children[j];
        if (skip.has(next.id) || next.archived || !isParagraphOnly(next)) break;
        if (!looksLikeFormulaLine(getPlainText(next).trim())) break;
        run.push(next);
        j += 1;
      }

      const formula = normalizeFormula(run.map(getPlainText).join('\n'));
      const shouldConvert = run.length >= 2 ? looksLikeFormula(formula) : looksLikeStandaloneFormulaBlock(formula);
      if (!shouldConvert) { i += 1; continue; }

      this.stats.smartEquations += 1;
      this.stats.archivedBlocks += run.length;
      for (const item of run) skip.add(item.id);
      console.log(`智能裸公式 #${this.stats.smartEquations}：${oneLine(formula)}`);
      if (this.apply) {
        await appendEquationAfter(parentId, run[run.length - 1].id, formula, this.token);
        for (const item of run) await archiveBlock(item.id, this.token);
      }
      i = j;
    }
  }

  async cleanupStandaloneBracketBlocks(children, skip) {
    for (const block of children) {
      if (skip.has(block.id) || block.archived || !isParagraphOnly(block)) continue;
      const text = getPlainText(block);
      if (!isStandaloneBracket(text)) continue;
      this.stats.cleanedBrackets += 1;
      this.stats.archivedBlocks += 1;
      skip.add(block.id);
      console.log(`清理孤立括号 #${this.stats.cleanedBrackets}：${text.trim()}`);
      if (this.apply) await archiveBlock(block.id, this.token);
    }
  }

  printSummary() {
    console.log('\n========== 结果 ==========' );
    console.log(`扫描父级：${this.stats.scannedParents}`);
    console.log(`扫描块数：${this.stats.scannedBlocks}`);
    console.log(`将转换为块公式：${this.stats.blockEquations}`);
    console.log(`将更新行内公式文本块：${this.stats.inlineBlocks}`);
    console.log(`将智能转换裸公式：${this.stats.smartEquations}`);
    console.log(`将清理孤立括号：${this.stats.cleanedBrackets}`);
    console.log(`将归档原始文本块：${this.stats.archivedBlocks}`);
    console.log(this.apply ? '已执行正式转换。请回到 Notion App 等待同步。' : '当前只是预览。确认无误后加 --apply 正式转换。');
  }
}

function looksLikeStandaloneFormulaBlock(text) {
  const s = removeOuterDollarOrBrackets(text);
  if (!s || hasChineseSentence(s) || isLikelyPathOrUrl(s)) return false;
  return /\\begin\s*\{|\\end\s*\{|\\frac|\\sum|\\prod|\\int|\\sqrt|\\theta|\\gamma|\\rightarrow|\\Rightarrow/.test(s)
    || /^[A-Za-z][A-Za-z0-9_{}'()\[\],:\s]*=/.test(s)
    || /[=<>≈≠≤≥].*[A-Za-z0-9]/.test(s);
}

function oneLine(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120); }

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
    smartMath: args.smartMath,
    cleanupBrackets: args.cleanupBrackets,
    maxGroupBlocks: args.maxGroupBlocks,
  });
  await converter.run(pageId);
}

main().catch((error) => {
  console.error('\n运行失败：');
  console.error(error.message || error);
  process.exit(1);
});
