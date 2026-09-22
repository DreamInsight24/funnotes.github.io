/* =========================================================
   FunNotes · 公共工具层
   纯函数与本地存储小工具，不依赖任何页面结构
   ========================================================= */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 笔记树最大层数（根为第 0 层，共 MAX_DEPTH + 1 层） */
export const MAX_DEPTH = 4;

export const DEFAULT_NOTEBOOK_NAME = '我的笔记';

/** localStorage：上次访问的笔记本（仅作辅助） */
export const LS_CURRENT_NB = 'current_notebook';
/** sessionStorage：跨页面传递的一条提示（跳转后 Toast 用） */
export const LS_NOTICE = 'funnotes_notice';

export const AI_STORAGE = { base: 'ai_base', model: 'ai_model', key: 'ai_key' };
export const AI_DEFAULT_BASE = 'https://api.deepseek.com/v1';
export const AI_DEFAULT_MODEL = 'deepseek-chat';

export function genId() {
  return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function genNbId() {
  return 'nb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── 文本 / HTML ─────────────────────────────── */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isLikelyHtml(str) {
  return /<(p|div|br|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|strong|em|b|i|u|s|a|blockquote|pre|code|img|hr)\b/i.test(str || '');
}

const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta',
  'base', 'svg', 'math', 'template',
]);

/** 过滤导入内容里的脚本与危险属性 */
export function sanitizeHtml(html) {
  const src = String(html || '');
  if (!src) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = src;

  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const doomed = [];
  let node = walker.nextNode();

  while (node) {
    const tag = node.tagName.toLowerCase();
    if (BLOCKED_TAGS.has(tag)) {
      doomed.push(node);
      node = walker.nextNode();
      continue;
    }

    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      const isUrl = name === 'href' || name === 'src' || name === 'xlink:href';
      if (name.startsWith('on') || (isUrl && /^\s*(javascript|vbscript|data:text\/html)/i.test(value))) {
        node.removeAttribute(attr.name);
      }
    });

    node = walker.nextNode();
  }

  doomed.forEach((n) => n.remove());
  return tpl.innerHTML;
}

/* ── 时间 / 标签 ─────────────────────────────── */

export function formatTime(ts) {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return '未知';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function parseTags(str) {
  return [...new Set(String(str || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * 标签列表（按名称排序），返回 [{ name, count }]
 * notebookId 传入时只统计该笔记本内的标签
 */
export function allTags(notes, notebookId) {
  const map = new Map();
  notes.forEach((n) => {
    if (n.deletedAt) return;
    if (notebookId && n.notebookId !== notebookId) return;
    (n.tags || []).forEach((raw) => {
      const name = String(raw || '').trim();
      if (!name) return;
      map.set(name, (map.get(name) || 0) + 1);
    });
  });
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export function tagUsage(notes, name, notebookId) {
  return notes.filter((n) => {
    if (n.deletedAt) return false;
    if (notebookId && n.notebookId !== notebookId) return false;
    return (n.tags || []).includes(name);
  }).length;
}

/** 批量改标签名（可限定笔记本），返回被改动的笔记数组（不落库，由调用方保存） */
export function renameTagIn(notes, oldName, newName, notebookId) {
  const touched = [];
  notes.forEach((n) => {
    if (n.deletedAt) return;
    if (notebookId && n.notebookId !== notebookId) return;
    const tags = n.tags || [];
    if (!tags.includes(oldName)) return;
    n.tags = [...new Set(tags.map((t) => (t === oldName ? newName : t)))];
    n.updatedAt = Date.now();
    touched.push(n);
  });
  return touched;
}

/** 批量移除标签（可限定笔记本），返回被改动的笔记数组（不落库） */
export function removeTagIn(notes, name, notebookId) {
  const touched = [];
  notes.forEach((n) => {
    if (n.deletedAt) return;
    if (notebookId && n.notebookId !== notebookId) return;
    const tags = n.tags || [];
    if (!tags.includes(name)) return;
    n.tags = tags.filter((t) => t !== name);
    n.updatedAt = Date.now();
    touched.push(n);
  });
  return touched;
}

/* ── 笔记本排序 ─────────────────────────────── */

/** 按 order 排序（没有 order 的旧数据退回 createdAt） */
export function sortNotebooks(list) {
  return list.slice().sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/** 追加到末尾时使用的新 order */
export function nextOrder(list) {
  return list.length ? Math.max(...list.map((x) => x.order ?? 0)) + 1 : 0;
}

/* ── 笔记树 ─────────────────────────────────── */

/** 构建索引，跳过已删除笔记 */
export function buildIndexes(notes) {
  const byId = new Map();
  const byParent = new Map();
  notes.forEach((n) => {
    if (n.deletedAt) return;
    byId.set(n.id, n);
    const p = n.parentId || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  });
  byParent.forEach((arr) => arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
  return { byId, byParent };
}

export function sortByOrder(list) {
  return list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getDepth(noteId, byId) {
  let d = 0;
  let cur = byId.get(noteId);
  let guard = 0;
  while (cur && cur.parentId && guard++ < 100) {
    d++;
    cur = byId.get(cur.parentId);
  }
  return d;
}

export function getSubtreeHeight(noteId, byParent) {
  let h = 0;
  const children = byParent.get(noteId) || [];
  for (const c of children) {
    h = Math.max(h, getSubtreeHeight(c.id, byParent) + 1);
  }
  return h;
}

export function isDescendantOf(candidateId, ancestorId, byId) {
  let cur = byId.get(candidateId);
  let guard = 0;
  while (cur && cur.parentId && guard++ < 100) {
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** 收集子树（包含已删除的） */
export function collectSubtree(notes, rootId) {
  const result = [];
  const root = notes.find((n) => n.id === rootId);
  if (!root) return result;
  result.push(root);
  notes.filter((n) => n.parentId === rootId).forEach((c) => {
    result.push(...collectSubtree(notes, c.id));
  });
  return result;
}

/* ── 本地存储 ───────────────────────────────── */

export function readStore(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

export function removeStore(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}

export function readAiSettings() {
  return {
    base: readStore(AI_STORAGE.base, AI_DEFAULT_BASE),
    model: readStore(AI_STORAGE.model, AI_DEFAULT_MODEL),
    key: readStore(AI_STORAGE.key, ''),
  };
}

export function writeAiSettings({ base, model, key }) {
  writeStore(AI_STORAGE.base, base);
  writeStore(AI_STORAGE.model, model);
  writeStore(AI_STORAGE.key, key);
}

export function setNotice(msg) {
  try { sessionStorage.setItem(LS_NOTICE, msg); } catch (_) {}
}

/** 取出并清空跨页提示 */
export function takeNotice() {
  try {
    const m = sessionStorage.getItem(LS_NOTICE);
    if (m) sessionStorage.removeItem(LS_NOTICE);
    return m;
  } catch (_) {
    return null;
  }
}

export function queryParam(name) {
  return new URLSearchParams(location.search).get(name);
}
