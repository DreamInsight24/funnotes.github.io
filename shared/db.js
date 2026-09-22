/* =========================================================
   FunNotes · 数据层
   IndexedDB 封装 + 内存状态 + 常用数据操作
   （数据库名与版本保持兼容，旧数据不会丢失）
   ========================================================= */

import {
  genId, genNbId, DEFAULT_NOTEBOOK_NAME, escapeHtml, sanitizeHtml,
  sortNotebooks, nextOrder, readStore, writeStore, removeStore,
  readAiSettings, AI_STORAGE, LS_CURRENT_NB,
} from './utils.js';

const DB_NAME = 'progressive-notes';
const NOTES = 'notes';
const NOTEBOOKS = 'notebooks';
const VERSION = 2;

const DB = (() => {
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = (e) => {
          const db = req.result;
          if (!db.objectStoreNames.contains(NOTES)) {
            db.createObjectStore(NOTES, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(NOTEBOOKS)) {
            db.createObjectStore(NOTEBOOKS, { keyPath: 'id' });
          }
          if (e.oldVersion >= 1 && e.oldVersion < 2) {
            const tx = e.target.transaction;
            const noteStore = tx.objectStore(NOTES);
            const nbStore = tx.objectStore(NOTEBOOKS);
            const defaultNbId = 'nb_default';
            nbStore.put({
              id: defaultNbId,
              name: DEFAULT_NOTEBOOK_NAME,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
            let i = 0;
            noteStore.openCursor().onsuccess = (ev) => {
              const cur = ev.target.result;
              if (cur) {
                const n = cur.value;
                if (!n.notebookId) n.notebookId = defaultNbId;
                if (n.parentId === undefined) n.parentId = null;
                if (n.order === undefined) n.order = i++;
                cur.update(n);
                cur.continue();
              }
            };
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    allNotes: () => tx(NOTES, 'readonly', (s) => s.getAll()),
    putNote: (n) => tx(NOTES, 'readwrite', (s) => s.put(n)),
    delNote: (id) => tx(NOTES, 'readwrite', (s) => s.delete(id)),
    bulkPutNotes: (list) => tx(NOTES, 'readwrite', (s) => { list.forEach((n) => s.put(n)); }),
    bulkDelNotes: (ids) => tx(NOTES, 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }),
    clearNotes: () => tx(NOTES, 'readwrite', (s) => s.clear()),

    allNotebooks: () => tx(NOTEBOOKS, 'readonly', (s) => s.getAll()),
    putNotebook: (nb) => tx(NOTEBOOKS, 'readwrite', (s) => s.put(nb)),
    delNotebook: (id) => tx(NOTEBOOKS, 'readwrite', (s) => s.delete(id)),
    clearNotebooks: () => tx(NOTEBOOKS, 'readwrite', (s) => s.clear()),
  };
})();

/** 全应用共享的内存状态（同一页面内 import 只会有一份） */
export const state = {
  notebooks: [],
  notes: [],
};

/** 读取全部数据并做兼容性修补；没有笔记本时创建默认笔记本 */
export async function loadAll() {
  let notebooks = [];
  let notes = [];
  try {
    [notebooks, notes] = await Promise.all([DB.allNotebooks(), DB.allNotes()]);
  } catch (err) {
    console.error('读取本地数据失败', err);
  }

  state.notebooks = notebooks;
  state.notes = notes;

  if (!state.notebooks.length) {
    const nb = {
      id: genNbId(),
      name: DEFAULT_NOTEBOOK_NAME,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: 0,
    };
    state.notebooks.push(nb);
    await DB.putNotebook(nb).catch(() => {});
  }

  // 老数据补 order（按创建时间排一遍）
  if (state.notebooks.some((nb) => nb.order === undefined)) {
    sortNotebooks(state.notebooks).forEach((nb, i) => { nb.order = i; });
    for (const nb of state.notebooks) {
      await DB.putNotebook(nb).catch(() => {});
    }
  }

  const ids = new Set(state.notebooks.map((n) => n.id));
  const fallback = state.notebooks[0].id;
  let dirty = false;
  state.notes.forEach((n) => {
    if (!n.notebookId || !ids.has(n.notebookId)) { n.notebookId = fallback; dirty = true; }
    if (n.parentId === undefined) { n.parentId = null; dirty = true; }
    if (n.order === undefined) { n.order = 0; dirty = true; }
  });
  if (dirty) await DB.bulkPutNotes(state.notes).catch(() => {});

  return state;
}

/* ── 查询 ───────────────────────────────────── */

export function getNotebook(id) {
  return state.notebooks.find((n) => n.id === id) || null;
}

export function sortedNotebooks() {
  return sortNotebooks(state.notebooks);
}

export function notesInNotebook(nbId, { includeDeleted = false } = {}) {
  return state.notes.filter((n) => n.notebookId === nbId && (includeDeleted || !n.deletedAt));
}

export function deletedInNotebook(nbId) {
  return state.notes
    .filter((n) => n.notebookId === nbId && n.deletedAt)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

/** 默认笔记：最近编辑（updatedAt 最大）且未删除 */
export function mostRecentNoteId(nbId) {
  const list = notesInNotebook(nbId);
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)).id;
}

/* ── 写入 ───────────────────────────────────── */

export async function saveNote(note) {
  await DB.putNote(note);
}

export async function saveNotes(list) {
  if (list && list.length) await DB.bulkPutNotes(list);
}

export async function deleteNoteIds(ids) {
  if (ids && ids.length) await DB.bulkDelNotes(ids);
}

export async function saveNotebook(nb) {
  await DB.putNotebook(nb);
}

export async function createNotebook(name) {
  const nb = {
    id: genNbId(),
    name: String(name || DEFAULT_NOTEBOOK_NAME).trim() || DEFAULT_NOTEBOOK_NAME,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: nextOrder(state.notebooks),
  };
  state.notebooks.push(nb);
  await DB.putNotebook(nb);
  return nb;
}

/** 按当前顺序重排 order 并落库 */
export async function reorderNotebooks(orderedIds) {
  const changed = [];
  orderedIds.forEach((id, i) => {
    const nb = state.notebooks.find((n) => n.id === id);
    if (!nb || nb.order === i) return;
    nb.order = i;
    changed.push(nb);
  });
  for (const nb of changed) await DB.putNotebook(nb);
  return changed.length;
}

/** 把源笔记本里的全部笔记页放进目标笔记本（含回收站中的），并删除源笔记本 */
export async function mergeNotebooks(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return 0;
  if (!getNotebook(sourceId) || !getNotebook(targetId)) return 0;

  const moved = state.notes.filter((n) => n.notebookId === sourceId);
  const now = Date.now();
  moved.forEach((n) => {
    n.notebookId = targetId;
    n.updatedAt = now;
  });
  await saveNotes(moved);

  await deleteNotebookCascade(sourceId);

  // 重排剩余笔记本顺序
  await reorderNotebooks(sortedNotebooks().map((nb) => nb.id));
  return moved.length;
}

/**
 * 删除笔记本：连同该笔记本下所有笔记（含回收站中的）一起永久删除
 * 返回被删除的笔记 id 列表
 */
export async function deleteNotebookCascade(nbId) {
  const ids = state.notes.filter((n) => n.notebookId === nbId).map((n) => n.id);
  if (ids.length) await DB.bulkDelNotes(ids);
  await DB.delNotebook(nbId);

  const idSet = new Set(ids);
  state.notes = state.notes.filter((n) => !idSet.has(n.id));
  state.notebooks = state.notebooks.filter((n) => n.id !== nbId);
  return ids;
}

export async function clearAll() {
  await DB.clearNotes();
  await DB.clearNotebooks();
}

/* ── 导出（两个页面共用） ───────────────────── */

function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 用户数据（全部笔记本 + 全部笔记 + 配置） */
export function exportUserData() {
  const payload = {
    app: 'funnotes',
    kind: 'backup',
    version: 4,
    exportedAt: new Date().toISOString(),
    notebooks: state.notebooks,
    notes: state.notes,
    settings: {
      ai: readAiSettings(),
      currentNotebook: readStore(LS_CURRENT_NB, ''),
    },
  };
  downloadJSON(payload, `funnotes-data-${new Date().toISOString().slice(0, 10)}.json`);

  return {
    notebooks: state.notebooks.length,
    active: state.notes.filter((n) => !n.deletedAt).length,
    trash: state.notes.filter((n) => n.deletedAt).length,
  };
}

/** 单个笔记本（笔记本信息 + 该笔记本的所有笔记，含回收站） */
export function exportNotebook(nbId) {
  const nb = getNotebook(nbId);
  if (!nb) throw new Error('笔记本不存在');

  const notes = state.notes.filter((n) => n.notebookId === nbId);
  const payload = {
    app: 'funnotes',
    kind: 'notebook',
    version: 4,
    exportedAt: new Date().toISOString(),
    notebook: nb,
    notes,
  };
  const safeName = String(nb.name || 'notebook').replace(/[\\/:*?"<>|]/g, '_');
  downloadJSON(payload, `${safeName}-${new Date().toISOString().slice(0, 10)}.json`);

  return { name: nb.name, notes: notes.length };
}

/* ── 导入 ───────────────────────────────────── */

/** 识别 JSON 文件类型，返回 { kind, notebooks, notes, notebook, settings } */
export function readPayload(data) {
  if (Array.isArray(data)) {
    return { kind: 'backup', notebooks: [], notes: data, settings: null };
  }
  if (!data || typeof data !== 'object') {
    return { kind: 'unknown', notebooks: [], notes: [], settings: null };
  }

  const notes = Array.isArray(data.notes) ? data.notes : [];

  if (data.kind === 'notebook' && data.notebook && typeof data.notebook === 'object') {
    return { kind: 'notebook', notebook: data.notebook, notebooks: [], notes, settings: null };
  }

  const notebooks = Array.isArray(data.notebooks) ? data.notebooks : [];
  if (!notebooks.length && !notes.length) {
    return { kind: 'unknown', notebooks: [], notes: [], settings: null };
  }
  return { kind: 'backup', notebooks, notes, settings: data.settings || null };
}

export async function readPayloadFile(file) {
  const text = await file.text();
  return readPayload(JSON.parse(text));
}

function prepareNotes(incoming, { notebookId, nbIdMap, fallbackNbId, dedupe }) {
  const existing = new Set(state.notes.map((n) => n.id));
  const prepared = incoming
    .filter((n) => n && typeof n === 'object')
    .map((n) => ({ ...n, id: (typeof n.id === 'string' && n.id) ? n.id : genId() }));

  const idMap = new Map();
  const skipped = [];
  const kept = [];
  prepared.forEach((n) => {
    if (dedupe && existing.has(n.id)) { skipped.push(n.id); return; }
    const newId = existing.has(n.id) ? genId() : n.id;
    idMap.set(n.id, newId);
    existing.add(newId);
    kept.push(n);
  });

  const out = kept.map((n) => {
    const note = {
      id: idMap.get(n.id),
      notebookId: notebookId || (nbIdMap && nbIdMap.get(n.notebookId)) || fallbackNbId,
      parentId: n.parentId ? (idMap.get(n.parentId) || null) : null,
      order: Number(n.order) || 0,
      title: String(n.title ?? ''),
      content: String(n.content ?? ''),
      tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
      createdAt: Number(n.createdAt) || Date.now(),
      updatedAt: Number(n.updatedAt) || Date.now(),
    };
    if (n.deletedAt) note.deletedAt = Number(n.deletedAt);
    return note;
  });

  return { notes: out, skipped: skipped.length };
}

/**
 * 合并用户数据（取并集：同 id 的内容视为已存在，不重复导入）
 * 返回 { notebooks, notes, skipped }
 */
export async function mergeUserData({ notebooks = [], notes = [] }) {
  const existingNbIds = new Set(state.notebooks.map((n) => n.id));
  const nbIdMap = new Map();
  const addedNotebooks = [];
  let skippedNotebooks = 0;

  notebooks.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const oldId = (typeof raw.id === 'string' && raw.id) ? raw.id : genNbId();
    if (existingNbIds.has(oldId)) { skippedNotebooks++; nbIdMap.set(oldId, oldId); return; }
    existingNbIds.add(oldId);
    nbIdMap.set(oldId, oldId);

    const nb = {
      id: oldId,
      name: String(raw.name || '未命名笔记本'),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      order: nextOrder(state.notebooks),
    };
    state.notebooks.push(nb);
    addedNotebooks.push(nb);
  });

  let fallbackNbId = state.notebooks[0] ? state.notebooks[0].id : null;
  if (!fallbackNbId) {
    const nb = await createNotebook(DEFAULT_NOTEBOOK_NAME);
    fallbackNbId = nb.id;
  }

  const { notes: addedNotes, skipped } = prepareNotes(notes, {
    nbIdMap, fallbackNbId, dedupe: true,
  });

  state.notes.push(...addedNotes);
  for (const nb of addedNotebooks) await saveNotebook(nb);
  await saveNotes(addedNotes);

  return {
    notebooks: addedNotebooks.length,
    notes: addedNotes.length,
    skipped,
    skippedNotebooks,
  };
}

/** 把文件里的笔记本作为全新笔记本导入（id 冲突时自动换新 id） */
export async function addNotebookFromPayload(notebook, notes) {
  const rawName = String((notebook && notebook.name) || '导入的笔记本');
  const updatedAt = Number((notebook && notebook.updatedAt)) || Date.now();

  const nb = await createNotebook(rawName);
  nb.createdAt = Number((notebook && notebook.createdAt)) || nb.createdAt;
  nb.updatedAt = updatedAt;
  await saveNotebook(nb);

  const { notes: addedNotes } = prepareNotes(notes, {
    notebookId: nb.id,
    fallbackNbId: nb.id,
  });

  state.notes.push(...addedNotes);
  await saveNotes(addedNotes);
  await reorderNotebooks(sortedNotebooks().map((n) => n.id));

  return { notebook: nb, notes: addedNotes.length };
}

/** 把文件里的笔记页放进指定笔记本（例如「放入当前笔记本」） */
export async function addNotesIntoNotebook(notebookId, notes) {
  if (!getNotebook(notebookId)) throw new Error('目标笔记本不存在');
  const { notes: addedNotes } = prepareNotes(notes, {
    notebookId,
    fallbackNbId: notebookId,
  });
  state.notes.push(...addedNotes);
  await saveNotes(addedNotes);
  return { notes: addedNotes.length };
}

/* ── 删除所有用户数据 ───────────────────────── */

export async function deleteAllUserData() {
  await clearAll();
  state.notes = [];
  state.notebooks = [];

  removeStore(AI_STORAGE.base);
  removeStore(AI_STORAGE.model);
  removeStore(AI_STORAGE.key);
  removeStore(LS_CURRENT_NB);

  const nb = await createNotebook(DEFAULT_NOTEBOOK_NAME);
  writeStore(LS_CURRENT_NB, nb.id);
  return nb;
}

/* ── Markdown 导入 ──────────────────────────── */

/** 把 Markdown 切成「标题 + 正文」的小节（含 Setext 标题、front matter） */
export function parseMarkdownToSections(md) {
  let lines = String(md || '').replace(/^\uFEFF/, '').split(/\r?\n/);

  // 去掉文件开头的 YAML front matter（--- 开头、含 key: 的块）
  if (/^\s*---\s*$/.test(lines[0] || '')) {
    const end = lines.findIndex((l, i) => i > 0 && /^\s*(---|\.\.\.)\s*$/.test(l));
    const body = end > 0 ? lines.slice(1, end) : [];
    if (end > 0 && body.some((l) => /^\s*[\w-]+\s*:/.test(l))) {
      lines = lines.slice(end + 1);
    }
  }

  const sections = [];
  let current = { level: 0, title: '', lines: [] };
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      current.lines.push(line);
      continue;
    }

    if (!inCodeBlock) {
      // ATX 标题：# 标题 / #标题
      const atx = line.match(/^\s*(#{1,6})\s*([^#\s].*?)\s*#*\s*$/);
      if (atx) {
        sections.push(current);
        current = { level: atx[1].length, title: atx[2].trim(), lines: [] };
        continue;
      }

      // Setext 标题：标题下一行是 === 或 ---
      const next = lines[i + 1];
      const looksLikeBlock = /^\s*([-*+]|\d+[.)]|>|#|```|~~~)/.test(line);
      if (next && line.trim() && !looksLikeBlock && /^\s*(=+|-{2,})\s*$/.test(next)) {
        sections.push(current);
        current = {
          level: next.indexOf('=') >= 0 ? 1 : 2,
          title: line.trim(),
          lines: [],
        };
        i++;
        continue;
      }
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections;
}

export function markdownToHtml(md) {
  const src = (md || '').trim();
  if (!src) return '';
  if (typeof marked !== 'undefined') {
    try {
      return sanitizeHtml(marked.parse(src, { breaks: true, gfm: true }));
    } catch (e) {
      console.warn('marked 解析失败，降级到纯文本', e);
    }
  }
  return src.split(/\n{2,}/).map((p) =>
    `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`
  ).join('');
}

/**
 * 导入 Markdown 到指定笔记本
 * 没有一级标题时用文件名建父笔记（文件名不可用则用「导入的文件」兜底）
 */
export async function importMarkdown(text, fileName, notebookId) {
  if (!notebookId) throw new Error('请先创建笔记本');

  const sections = parseMarkdownToSections(text);
  const hasContent = sections.some((s) => s.level > 0 || s.lines.some((l) => l.trim()));
  if (!hasContent) throw new Error('文件是空的，没有可导入的内容');

  const fileNameBase = String(fileName || '').replace(/\.(md|markdown|txt)$/i, '').trim();
  const existingRoots = notesInNotebook(notebookId).filter((n) => !n.parentId);
  let orderCounter = existingRoots.length
    ? Math.max(...existingRoots.map((n) => n.order ?? 0)) + 1
    : 0;

  const created = [];
  const stack = [];

  const firstHeadingIdx = sections.findIndex((s) => s.level > 0);
  const firstHeading = firstHeadingIdx >= 0 ? sections[firstHeadingIdx] : null;
  const needRoot = !firstHeading || firstHeading.level > 1;

  const preLines = [];
  if (firstHeadingIdx > 0) {
    for (let i = 0; i < firstHeadingIdx; i++) preLines.push(...sections[i].lines);
  } else if (firstHeadingIdx < 0) {
    for (const s of sections) preLines.push(...s.lines);
  }
  const preContent = preLines.join('\n').trim();

  if (needRoot) {
    const rootNote = {
      id: genId(),
      notebookId,
      parentId: null,
      order: orderCounter++,
      title: fileNameBase || '导入的文件',
      content: markdownToHtml(preContent),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    created.push(rootNote);
    stack[1] = rootNote;
  } else if (preContent) {
    sections[firstHeadingIdx].lines.unshift(...preLines);
  }

  sections.forEach((sec) => {
    if (sec.level === 0) return;

    let parentId = null;
    for (let i = sec.level - 1; i >= 1; i--) {
      if (stack[i]) { parentId = stack[i].id; break; }
    }

    const note = {
      id: genId(),
      notebookId,
      parentId,
      order: orderCounter++,
      title: sec.title || '未命名',
      content: markdownToHtml(sec.lines.join('\n')),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    created.push(note);

    stack.length = sec.level;
    stack[sec.level] = note;
  });

  if (!created.length) throw new Error('文件里没有可导入的内容');

  await saveNotes(created);
  state.notes.push(...created);
  return { count: created.length, rootTitle: created[0].title || '未命名', rootId: created[0].id };
}

/**
 * 把一个 .md 文件当作全新笔记本导入：
 * 笔记本名称 = 文件名，笔记本内的层级逻辑与其它地方完全一致
 */
export async function createNotebookFromMarkdown(text, fileName) {
  const base = String(fileName || '').replace(/\.(md|markdown|txt)$/i, '').trim() || '导入的笔记本';
  const nb = await createNotebook(base);
  try {
    const info = await importMarkdown(text, fileName, nb.id);
    await reorderNotebooks(sortedNotebooks().map((n) => n.id));
    return { notebook: nb, ...info };
  } catch (err) {
    // 导入失败就不留下空笔记本
    await deleteNotebookCascade(nb.id);
    throw err;
  }
}
