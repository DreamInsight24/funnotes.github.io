/* =========================================================
   FunNotes · 设置与标签组件（可复用）
   - createSettingsView：AI 配置 + 标签管理 + 关于
   - createTagPanel：笔记编辑区的标签面板（含「选择已有标签」）
   两个页面 import 同一份实现，行为完全一致
   ========================================================= */

import { state, saveNotes } from './db.js';
import {
  allTags, tagUsage, renameTagIn, removeTagIn, parseTags,
  readAiSettings, writeAiSettings,
} from './utils.js';
import * as ui from './ui.js';

/* ── 标签变更订阅 ───────────────────────────── */

const tagListeners = new Set();

export function onTagsChanged(fn) {
  tagListeners.add(fn);
  return () => tagListeners.delete(fn);
}

function emitTagsChanged() {
  tagListeners.forEach((fn) => {
    try { fn(); } catch (err) { console.error(err); }
  });
}

/* ── 标签批量操作 ───────────────────────────── */

export async function renameTagEverywhere(oldName, newName) {
  const touched = renameTagIn(state.notes, oldName, newName);
  await saveNotes(touched);
  emitTagsChanged();
  return touched.length;
}

export async function removeTagEverywhere(name) {
  const touched = removeTagIn(state.notes, name);
  await saveNotes(touched);
  emitTagsChanged();
  return touched.length;
}

export async function askRenameTag(oldName) {
  const usage = tagUsage(state.notes, oldName);
  const next = await ui.promptModal('重命名标签', oldName, {
    message: usage
      ? `「${oldName}」正在被 ${usage} 条笔记使用。改名后会同步更新这 ${usage} 条笔记的标签。`
      : `重命名标签「${oldName}」。`,
    label: '新标签名',
    confirmText: '改名',
  });
  if (next === null) return;
  if (!next) { ui.toast('标签名不能为空'); return; }
  if (next === oldName) return;

  const willMerge = allTags(state.notes).some((t) => t.name === next);
  if (willMerge) {
    const ok = await ui.confirmModal(
      '合并标签？',
      `已经存在标签「${next}」，继续会把「${oldName}」合并进它（影响 ${usage} 条笔记）。`,
      { confirmText: '合并' }
    );
    if (!ok) return;
  }

  const count = await renameTagEverywhere(oldName, next);
  ui.toast(`已把「${oldName}」改为「${next}」，同步 ${count} 条笔记`);
}

export async function askDeleteTag(name) {
  const usage = tagUsage(state.notes, name);
  const ok = await ui.confirmModal(
    '删除标签',
    `从 ${usage} 条笔记中移除标签「${name}」？笔记本身不会被删除。`,
    { confirmText: '删除', danger: true }
  );
  if (!ok) return;

  const count = await removeTagEverywhere(name);
  ui.toast(`已删除标签「${name}」，更新 ${count} 条笔记`);
}

export function openTagMenu(name, x, y) {
  ui.openCtxMenu(x, y, [
    { heading: `标签「${name}」` },
    { label: '重命名标签…', action: () => askRenameTag(name) },
    { separator: true },
    { label: '删除标签（保留笔记）', danger: true, action: () => askDeleteTag(name) },
  ]);
}

/* ── 标签面板（编辑区） ─────────────────────── */

export function createTagPanel(host, { getValue, setValue, onInput } = {}) {
  host.innerHTML = `
    <div class="field">
      <span class="field-label">标签（用逗号分隔；右键标签可改名）</span>
      <div class="tag-input-wrap">
        <input class="field-input" data-role="input" placeholder="如：HCI, 作业, 灵感">
        <button class="icon-btn small" data-role="arrow"
                data-tip="选择已有标签，或新建标签" aria-label="选择已有标签">▾</button>
        <div class="tag-picker" data-role="picker" hidden></div>
      </div>
    </div>`;

  const input = host.querySelector('[data-role="input"]');
  const picker = host.querySelector('[data-role="picker"]');
  const arrow = host.querySelector('[data-role="arrow"]');

  const api = {
    el: host,
    input,
    get value() { return input.value; },
    setValue(v) { input.value = v || ''; },
    open() {
      host.hidden = false;
      renderPicker();
    },
    close() {
      host.hidden = true;
      picker.hidden = true;
    },
    toggle() {
      if (host.hidden) api.open();
      else api.close();
    },
    isOpen() { return !host.hidden; },
    togglePicker() {
      const willShow = picker.hidden;
      if (willShow) renderPicker();
      picker.hidden = !willShow;
    },
    closePicker() { picker.hidden = true; },
    renderPicker,
  };

  input.addEventListener('input', () => {
    if (onInput) onInput(input.value);
    if (!picker.hidden) renderPicker();
  });

  arrow.addEventListener('click', (e) => {
    e.stopPropagation();
    api.togglePicker();
  });

  picker.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!picker.hidden && !picker.contains(e.target)) picker.hidden = true;
  });

  function toggleTag(name, row) {
    const tags = parseTags(input.value);
    const idx = tags.indexOf(name);
    if (idx >= 0) tags.splice(idx, 1);
    else tags.push(name);
    input.value = tags.join(', ');
    if (onInput) onInput(input.value);

    const check = row && row.querySelector('.tag-check');
    if (check) check.textContent = tags.includes(name) ? '✓' : '';
  }

  async function createTag() {
    const name = await ui.promptModal('新建标签', '', {
      message: '新标签会添加到当前笔记。',
      label: '标签名',
      placeholder: '如：读书笔记',
      confirmText: '创建',
    });
    if (name === null) return;
    if (!name) { ui.toast('标签名不能为空'); return; }

    const tags = parseTags(input.value);
    if (!tags.includes(name)) {
      tags.push(name);
      input.value = tags.join(', ');
      if (onInput) onInput(input.value);
    }
    renderPicker();
    ui.toast(`已添加标签「${name}」`);
  }

  function renderPicker() {
    const chosen = new Set(parseTags(input.value));
    const list = allTags(state.notes);
    picker.innerHTML = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'tag-picker-empty';
      empty.textContent = '还没有已有标签，可以从下面新建一个。';
      picker.appendChild(empty);
    }

    list.forEach((tag) => {
      const row = document.createElement('div');
      row.className = 'tag-row';

      const check = document.createElement('span');
      check.className = 'tag-check';
      check.textContent = chosen.has(tag.name) ? '✓' : '';

      const name = document.createElement('span');
      name.className = 'tag-name';
      name.textContent = tag.name;

      const count = document.createElement('span');
      count.className = 'tag-count';
      count.textContent = tag.count;

      row.append(check, name, count);
      row.addEventListener('click', () => toggleTag(tag.name, row));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTagMenu(tag.name, e.clientX, e.clientY);
      });
      picker.appendChild(row);
    });

    const newRow = document.createElement('div');
    newRow.className = 'tag-row new-tag';
    newRow.textContent = '＋ 新建标签';
    newRow.addEventListener('click', createTag);
    picker.appendChild(newRow);
  }

  onTagsChanged(() => {
    if (!picker.hidden) renderPicker();
    if (getValue && input.value !== getValue()) input.value = getValue() || '';
  });

  return api;
}

/* ── 设置视图 ───────────────────────────────── */

export function createSettingsView({ root, onClose, onChanged, onAiChanged } = {}) {
  root.innerHTML = `
    <div class="settings-head">
      <h2 class="settings-title">⚙️ 设置</h2>
      <button class="ghost-btn small" data-role="close">返回</button>
    </div>
    <div class="settings-body">
      <section class="settings-section">
        <h3>AI 配置</h3>
        <p class="settings-hint">
          配置只保存在本机浏览器，不会上传。填好 API Key 后，笔记页右上角会出现「AI」按钮，
          可用它总结笔记或生成标签。
        </p>
        <div class="field-row">
          <label class="field">
            <span class="field-label">API Base</span>
            <input class="field-input" data-role="apiBase" placeholder="https://api.deepseek.com/v1">
          </label>
          <label class="field">
            <span class="field-label">模型</span>
            <input class="field-input" data-role="apiModel" placeholder="deepseek-chat">
          </label>
        </div>
        <label class="field">
          <span class="field-label">API Key（只存在你本地浏览器里）</span>
          <input class="field-input" data-role="apiKey" type="password" placeholder="sk-...">
        </label>
      </section>

      <section class="settings-section">
        <h3>标签管理</h3>
        <p class="settings-hint">
          右键标签可以重命名或删除。重命名会同步更新所有使用该标签的笔记，请谨慎操作。
        </p>
        <ul class="tag-manage-list" data-role="tagList"></ul>
      </section>

      <section class="settings-section">
        <h3>关于 FunNotes</h3>
        <div class="settings-kv"><span>版本</span><span>4.0</span></div>
        <div class="settings-kv"><span>数据存储</span><span>浏览器本地（IndexedDB）</span></div>
        <div class="settings-kv"><span>页面结构</span><span>工作台 + 笔记页 + 公共层</span></div>
        <div class="settings-kv"><span>新建笔记</span><kbd>Ctrl + N</kbd></div>
        <div class="settings-kv"><span>立即保存</span><kbd>Ctrl + S</kbd></div>
        <p class="settings-hint">
          笔记可以拖拽调整层级；右键笔记、右键标签、右键回收站都有更多操作。
        </p>
      </section>
    </div>`;

  const el = {
    close: root.querySelector('[data-role="close"]'),
    apiBase: root.querySelector('[data-role="apiBase"]'),
    apiModel: root.querySelector('[data-role="apiModel"]'),
    apiKey: root.querySelector('[data-role="apiKey"]'),
    tagList: root.querySelector('[data-role="tagList"]'),
  };

  el.close.addEventListener('click', () => { if (onClose) onClose(); });

  function persistAi() {
    writeAiSettings({
      base: el.apiBase.value.trim(),
      model: el.apiModel.value.trim(),
      key: el.apiKey.value.trim(),
    });
    if (onAiChanged) onAiChanged();
  }

  [el.apiBase, el.apiModel, el.apiKey].forEach((input) => {
    input.addEventListener('input', persistAi);
  });

  function renderTagList() {
    const list = allTags(state.notes);
    el.tagList.innerHTML = '';

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'tag-manage-empty';
      li.textContent = '还没有标签。在笔记的「标签」面板里添加后，会出现在这里。';
      el.tagList.appendChild(li);
      return;
    }

    const frag = document.createDocumentFragment();
    list.forEach((tag) => {
      const li = document.createElement('li');
      li.className = 'tag-manage-item';

      const name = document.createElement('span');
      name.className = 'tag-manage-name';
      name.textContent = tag.name;

      const count = document.createElement('span');
      count.className = 'tag-manage-count';
      count.textContent = `${tag.count} 条笔记`;

      const more = document.createElement('button');
      more.className = 'ghost-btn small';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '标签操作');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        openTagMenu(tag.name, r.left, r.bottom + 4);
      });

      li.append(name, count, more);
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTagMenu(tag.name, e.clientX, e.clientY);
      });
      frag.appendChild(li);
    });
    el.tagList.appendChild(frag);
  }

  onTagsChanged(() => {
    renderTagList();
    if (onChanged) onChanged();
  });

  function render() {
    const ai = readAiSettings();
    el.apiBase.value = ai.base;
    el.apiModel.value = ai.model;
    el.apiKey.value = ai.key;
    renderTagList();
  }

  return { el, render, renderTagList };
}
