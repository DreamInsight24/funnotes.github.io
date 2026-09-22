/* =========================================================
   FunNotes · 回收站组件（可复用）
   视图按“笔记本范围”渲染：index 工作台不调用，note 笔记页传入当前笔记本
   ========================================================= */

import { state, deletedInNotebook, notesInNotebook, saveNotes, deleteNoteIds } from './db.js';
import { collectSubtree, formatTime } from './utils.js';
import * as ui from './ui.js';

let lastDeletedIds = null;

/* ── 移入回收站（可撤销） ───────────────────── */

export async function softDeleteNote(id, onChanged) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || note.deletedAt) return false;

  const subtree = collectSubtree(state.notes, id).filter((n) => !n.deletedAt);
  if (!subtree.length) return false;

  const now = Date.now();
  subtree.forEach((n) => {
    n.deletedAt = now;
    n.updatedAt = now;
  });
  await saveNotes(subtree);

  lastDeletedIds = subtree.map((n) => n.id);
  if (onChanged) onChanged();

  const title = note.title || '无标题';
  const extra = subtree.length > 1 ? `及 ${subtree.length - 1} 条子笔记` : '';
  ui.toast(`已移入回收站「${title}」${extra}`, '撤销', () => undoSoftDelete(onChanged));
  return true;
}

async function undoSoftDelete(onChanged) {
  if (!lastDeletedIds || !lastDeletedIds.length) return;
  const ids = new Set(lastDeletedIds);
  lastDeletedIds = null;

  const toRestore = state.notes.filter((n) => ids.has(n.id) && n.deletedAt);
  const now = Date.now();
  toRestore.forEach((n) => {
    delete n.deletedAt;
    n.updatedAt = now;
  });

  await saveNotes(toRestore);
  ui.hideToast();
  if (onChanged) onChanged();
  return toRestore[0] || null;
}

/* ── 还原 / 永久删除 / 清空 ─────────────────── */

export async function restoreNote(id, onChanged) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || !note.deletedAt) return 0;

  const subtree = collectSubtree(state.notes, id).filter((n) => n.deletedAt);

  // 父节点已删除或不存在 → 作为根节点存在
  if (note.parentId) {
    const parent = state.notes.find((n) => n.id === note.parentId);
    if (!parent || parent.deletedAt) {
      note.parentId = null;
      const roots = notesInNotebook(note.notebookId).filter((n) => !n.parentId);
      note.order = roots.length ? Math.max(...roots.map((r) => r.order ?? 0)) + 1 : 0;
    }
  }

  const now = Date.now();
  subtree.forEach((n) => {
    delete n.deletedAt;
    n.updatedAt = now;
  });

  await saveNotes(subtree);
  if (onChanged) onChanged();
  ui.toast(`已还原 ${subtree.length} 条笔记`);
  return subtree.length;
}

export async function permanentDelete(id, onChanged) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || !note.deletedAt) return 0;

  const subtree = collectSubtree(state.notes, id);
  const ids = subtree.map((n) => n.id);

  const ok = await ui.confirmModal(
    '永久删除',
    `永久删除「${note.title || '无标题'}」及其全部子笔记（共 ${ids.length} 条）？此操作不可恢复。`,
    { confirmText: '永久删除', danger: true }
  );
  if (!ok) return 0;

  const idSet = new Set(ids);
  await deleteNoteIds(ids);
  state.notes = state.notes.filter((n) => !idSet.has(n.id));

  if (onChanged) onChanged();
  ui.toast(`已永久删除 ${ids.length} 条笔记`);
  return ids.length;
}

/** 清空某个笔记本的回收站 */
export async function emptyTrash(nbId, onChanged) {
  const deleted = deletedInNotebook(nbId);
  if (!deleted.length) {
    ui.toast('回收站已经是空的');
    return 0;
  }

  const ok = await ui.confirmModal(
    '清空回收站',
    `永久删除回收站中全部 ${deleted.length} 条笔记？此操作不可恢复。`,
    { confirmText: '清空回收站', danger: true }
  );
  if (!ok) return 0;

  const ids = deleted.map((n) => n.id);
  const idSet = new Set(ids);
  await deleteNoteIds(ids);
  state.notes = state.notes.filter((n) => !idSet.has(n.id));

  if (onChanged) onChanged();
  ui.toast(`已清空回收站（${ids.length} 条）`);
  return ids.length;
}

/* ── 视图组件 ───────────────────────────────── */

export function createTrashView({
  root, onChange, onClose, getNotebookName, closeLabel,
} = {}) {
  let scopeId = null;

  root.innerHTML = `
    <div class="trash-head">
      <div>
        <h2 class="trash-head-title">🗑️ 回收站</h2>
        <div class="trash-head-sub" data-role="count"></div>
      </div>
      <div class="trash-head-actions">
        <button class="ghost-btn small" data-role="close">${closeLabel || '返回笔记'}</button>
        <button class="ghost-btn small danger" data-role="empty">清空回收站</button>
      </div>
    </div>
    <ul class="trash-list" data-role="list"></ul>`;

  const el = {
    count: root.querySelector('[data-role="count"]'),
    list: root.querySelector('[data-role="list"]'),
    empty: root.querySelector('[data-role="empty"]'),
    close: root.querySelector('[data-role="close"]'),
  };

  el.empty.addEventListener('click', () => emptyTrash(scopeId, onChange));
  el.close.addEventListener('click', () => { if (onClose) onClose(); });

  function render(nbId) {
    scopeId = nbId;
    const deleted = deletedInNotebook(nbId);
    const nbName = getNotebookName ? getNotebookName(nbId) : '';

    el.count.textContent = deleted.length
      ? `共 ${deleted.length} 条已删除笔记${nbName ? ` · 笔记本「${nbName}」` : '（仅当前笔记本）'}`
      : `「${nbName || '当前笔记本'}」没有已删除笔记`;
    el.empty.disabled = !deleted.length;

    el.list.innerHTML = '';
    if (!deleted.length) {
      el.list.innerHTML = '<li class="trash-empty">回收站是空的</li>';
      return;
    }

    const frag = document.createDocumentFragment();
    deleted.forEach((note) => {
      const li = document.createElement('li');
      li.className = 'trash-item';

      const info = document.createElement('div');
      info.className = 'trash-info';

      const title = document.createElement('div');
      title.className = 'trash-title';
      title.textContent = note.title || '无标题';

      const meta = document.createElement('div');
      meta.className = 'trash-meta';
      const childCount = state.notes.filter((n) => n.parentId === note.id && n.deletedAt).length;
      meta.textContent = `删除于 ${note.deletedAt ? formatTime(note.deletedAt) : '未知'}` +
        (childCount ? ` · 含 ${childCount} 条子笔记` : '');

      info.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'trash-actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'ghost-btn small';
      restoreBtn.textContent = '还原';
      restoreBtn.addEventListener('click', () => restoreNote(note.id, onChange));

      const delBtn = document.createElement('button');
      delBtn.className = 'ghost-btn small danger';
      delBtn.textContent = '永久删除';
      delBtn.addEventListener('click', () => permanentDelete(note.id, onChange));

      actions.append(restoreBtn, delBtn);
      li.append(info, actions);
      frag.appendChild(li);
    });

    el.list.appendChild(frag);
  }

  return { render, get scopeId() { return scopeId; } };
}
