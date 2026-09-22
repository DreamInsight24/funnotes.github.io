/* =========================================================
   FunNotes · 通用交互组件
   Toast / 悬浮提示 / 右键菜单 / 模态对话框 / 下拉菜单
   initUi() 会把这些 DOM 自动挂到 body 上，两个页面共用
   ========================================================= */

import { $ } from './utils.js';

const refs = {};
const popMenus = new Set();
let ready = false;
let toastTimer = null;
let tipTimer = null;
let tipTarget = null;
let modalState = null;

/* ── 初始化 ─────────────────────────────────── */

export function initUi() {
  if (ready) return;
  ready = true;

  const frag = document.createElement('div');
  frag.innerHTML = `
    <div class="toast" data-ui="toast" hidden>
      <span data-ui="toastMsg"></span>
      <button data-ui="toastAction">撤销</button>
    </div>
    <div class="tip" data-ui="tip" hidden></div>
    <div class="ctx-menu" data-ui="ctxMenu" hidden></div>
    <div class="modal-mask" data-ui="modalMask" hidden>
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title" data-ui="modalTitle"></h3>
        <div class="modal-body" data-ui="modalBody"></div>
        <div class="modal-foot" data-ui="modalFoot"></div>
      </div>
    </div>`;
  while (frag.firstChild) document.body.appendChild(frag.firstChild);

  ['toast', 'toastMsg', 'toastAction', 'tip', 'ctxMenu', 'modalMask',
   'modalTitle', 'modalBody', 'modalFoot'].forEach((key) => {
    refs[key] = $(`[data-ui="${key}"]`);
  });

  bindTips();
  bindCtxMenu();
  bindModal();

  // 点页面其它地方关闭所有下拉菜单
  document.addEventListener('click', () => closePopMenus());
}

/* ── Toast ──────────────────────────────────── */

export function toast(msg, actionLabel, onAction) {
  initUi();
  refs.toastMsg.textContent = msg;

  if (actionLabel) {
    refs.toastAction.hidden = false;
    refs.toastAction.textContent = actionLabel;
    refs.toastAction.onclick = () => { if (onAction) onAction(); };
  } else {
    refs.toastAction.hidden = true;
  }

  refs.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2200);
}

export function hideToast() {
  clearTimeout(toastTimer);
  if (refs.toast) refs.toast.hidden = true;
}

/* ── 悬浮提示（任何带 data-tip 的元素自动生效） ─ */

const TIP_DELAY = 320;

function showTip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  tipTarget = el;
  refs.tip.textContent = text;
  refs.tip.hidden = false;
  refs.tip.style.left = '0px';
  refs.tip.style.top = '0px';

  const r = el.getBoundingClientRect();
  const tw = refs.tip.offsetWidth;
  const th = refs.tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - th - 8);

  refs.tip.style.left = left + 'px';
  refs.tip.style.top = Math.max(8, top) + 'px';
}

export function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipTarget = null;
  if (refs.tip) refs.tip.hidden = true;
}

function bindTips() {
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el || el === tipTarget) return;
    hideTip();
    tipTimer = setTimeout(() => {
      tipTimer = null;
      if (el.isConnected) showTip(el);
    }, TIP_DELAY);
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    if (el === tipTarget || tipTimer) hideTip();
  });

  // 键盘 Tab 聚焦时也显示提示
  document.addEventListener('focusin', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) return;
    let keyboardFocus = false;
    try { keyboardFocus = el.matches(':focus-visible'); } catch (_) {}
    if (!keyboardFocus) return;
    hideTip();
    showTip(el);
  });

  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
  document.addEventListener('mousedown', hideTip, true);
}

/* ── 右键菜单 ───────────────────────────────── */

export function openCtxMenu(x, y, items) {
  initUi();
  const menu = refs.ctxMenu;
  menu.innerHTML = '';

  items.forEach((item) => {
    if (item.separator) {
      const d = document.createElement('div');
      d.className = 'dropdown-divider';
      menu.appendChild(d);
      return;
    }
    if (item.heading) {
      const h = document.createElement('div');
      h.className = 'ctx-label';
      h.textContent = item.heading;
      menu.appendChild(h);
      return;
    }
    const btn = document.createElement('button');
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      closeCtxMenu();
      if (item.action) item.action();
    });
    menu.appendChild(btn);
  });

  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  return menu;
}

export function closeCtxMenu() {
  if (!refs.ctxMenu) return;
  refs.ctxMenu.hidden = true;
  refs.ctxMenu.innerHTML = '';
}

function bindCtxMenu() {
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });
  window.addEventListener('blur', closeCtxMenu);
}

/* ── 模态对话框 ─────────────────────────────── */

export function openModal(opts) {
  initUi();
  const o = opts || {};
  return new Promise((resolve) => {
    modalState = { resolve, fields: [], buttons: [], timers: [] };

    refs.modalTitle.textContent = o.title || '';
    refs.modalBody.innerHTML = '';

    if (o.message) {
      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = o.message;
      refs.modalBody.appendChild(p);
    }

    (o.fields || []).forEach((f) => {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      if (f.label) {
        const label = document.createElement('span');
        label.className = 'field-label';
        label.textContent = f.label;
        wrap.appendChild(label);
      }
      const input = document.createElement('input');
      input.className = 'field-input';
      input.type = f.type || 'text';
      input.value = f.value || '';
      if (f.placeholder) input.placeholder = f.placeholder;
      wrap.appendChild(input);
      refs.modalBody.appendChild(wrap);
      modalState.fields.push(input);
    });

    // 底部按钮：默认「取消 / 确定」，也可以完全自定义
    const buttons = o.buttons || [
      { label: o.cancelText || '取消', value: null, hidden: o.hideCancel === true },
      { label: o.confirmText || '确定', value: true, primary: true, danger: o.danger },
    ];

    refs.modalFoot.innerHTML = '';
    buttons.forEach((cfg) => {
      const btn = document.createElement('button');
      btn.className = 'ghost-btn' +
        (cfg.primary ? ' primary' : '') +
        (cfg.danger ? ' danger' : '');
      btn.textContent = cfg.label;
      btn.hidden = cfg.hidden === true;
      if (cfg.primary) btn.dataset.primary = '1';
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        closeModal(cfg.value);
      });
      if (cfg.countdown) startCountdown(btn, cfg);
      refs.modalFoot.appendChild(btn);
      modalState.buttons.push(btn);
    });

    refs.modalMask.hidden = false;

    setTimeout(() => {
      if (!modalState) return;
      if (modalState.fields.length) {
        modalState.fields[0].focus();
        modalState.fields[0].select();
      } else {
        const first = modalState.buttons.find((b) => !b.disabled && !b.hidden);
        if (first) first.focus();
      }
    }, 30);
  });
}

/** 危险按钮：先禁用 N 秒才可点击 */
function startCountdown(btn, cfg) {
  let left = Number(cfg.countdown) || 0;
  const label = cfg.label;
  btn.disabled = true;
  btn.textContent = `${label}（${left}s）`;

  const timer = setInterval(() => {
    left -= 1;
    if (!modalState) { clearInterval(timer); return; }
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = label;
      if (!modalState.fields.length) btn.focus();
      return;
    }
    btn.textContent = `${label}（${left}s）`;
  }, 1000);

  modalState.timers.push(timer);
}

export function closeModal(result) {
  if (!modalState) return;
  const { resolve, timers } = modalState;
  (timers || []).forEach((t) => clearInterval(t));
  modalState = null;
  refs.modalMask.hidden = true;
  refs.modalFoot.innerHTML = '';
  refs.modalBody.innerHTML = '';
  resolve(result);
}

export function isModalOpen() {
  return !!modalState;
}

function submitModal() {
  if (!modalState) return;
  if (modalState.fields.length) {
    closeModal(modalState.fields.map((f) => f.value));
    return;
  }
  const enabled = modalState.buttons.filter((b) => !b.disabled && !b.hidden);
  const target = enabled.find((b) => b.dataset.primary === '1') || enabled[0];
  if (target) target.click();
}

function bindModal() {
  refs.modalMask.addEventListener('mousedown', (e) => {
    if (e.target === refs.modalMask) closeModal(null);
  });

  document.addEventListener('keydown', (e) => {
    if (!modalState) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(null);
    } else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
      e.preventDefault();
      submitModal();
    }
  });
}

/** 确认对话框 → true / false */
export function confirmModal(title, message, opts) {
  const o = opts || {};
  return openModal({
    title,
    message,
    confirmText: o.confirmText,
    cancelText: o.cancelText,
    danger: o.danger,
  }).then((r) => r === true);
}

/** 单行输入对话框 → 去空格后的字符串 / null */
export function promptModal(title, value, opts) {
  const o = opts || {};
  return openModal({
    title,
    message: o.message,
    fields: [{
      label: o.label || '',
      value: value || '',
      placeholder: o.placeholder || '',
    }],
    confirmText: o.confirmText || '确定',
  }).then((r) => (r && r[0] ? r[0].trim() : null));
}

/* ── 下拉菜单（页脚 / 编辑器小菜单） ─────────── */

export function registerPopMenu(el) {
  if (el) popMenus.add(el);
  return el;
}

export function closePopMenus(except) {
  popMenus.forEach((el) => {
    if (el !== except) el.hidden = true;
  });
}

/** 把按钮与面板绑定成「点开 / 点关 / 点别处关闭」的下拉菜单 */
export function setupDropdown(btn, panel, opts) {
  const o = opts || {};
  registerPopMenu(panel);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = panel.hidden;
    closePopMenus(panel);
    if (willShow && o.onOpen) o.onOpen();
    panel.hidden = !willShow;
  });

  if (o.items) {
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('button[data-action]');
      if (!item || item.disabled) return;
      panel.hidden = true;
      o.items(item.dataset.action, item);
    });
  }

  panel.addEventListener('click', (e) => e.stopPropagation());
  return panel;
}
