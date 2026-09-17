// ==UserScript==
// @name         Shirasu Mute Filter
// @namespace    https://shirasu.io/
// @version      1.1.2
// @description  番組タイトル・チャンネル名・URLを条件に、shirasu.io の番組カードを一覧からчисткаする（SNSのミュート的な用途）
// @author       sayawaka
// @match        https://shirasu.io/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Tampermonkey用を想定してますが独自API等は使っていないので
 * 他のソフトでも転用できます。
 */


(function () {
  'use strict';

  const STORAGE_KEY = 'shirasu-mute-list-v1';

  // ---------- 保存データの読み書き ----------
  // エントリの形: { type: 'word' | 'url', value: string }
  function loadList() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('[shirasu-mute] loadList failed', e);
      return [];
    }
  }

  function saveList(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn('[shirasu-mute] saveList failed', e);
    }
  }

  function addEntry(type, value) {
    const v = (value || '').trim();
    if (!v) return;
    // "/" や "//" だけの登録は、正規化すると空文字になり全カードに
    // 一致してしまうため、そもそも登録させない。
    if (/^\/+$/.test(v)) return;
    const list = loadList();
    // 重複防止（type+valueの完全一致のみ弾く。部分一致は許容）
    if (list.some((e) => e.type === type && e.value === v)) return;
    list.push({ type, value: v });
    saveList(list);
    applyFilter();
    renderPanelList();
  }

  function removeEntry(index) {
    const list = loadList();
    list.splice(index, 1);
    saveList(list);
    applyFilter();
    renderPanelList();
  }

  // ---------- カードの検出とデータ抽出 ----------
  // shirasu.io の番組カードは、ビルドごとに変わりうるハッシュ化されたclass名に
  // 依存せず、構造（h4タイトル + /c/ で始まるチャンネルリンク + channel icon）で検出する。
  function getCards() {
    return Array.from(document.querySelectorAll('li')).filter(
      (li) =>
        li.querySelector('h4') &&
        li.querySelector('a[href^="/c/"] img[aria-label="channel icon"]')
    );
  }

  function extractCardData(li) {
    const titleEl = li.querySelector('h4');
    const title = titleEl ? titleEl.textContent.trim() : '';

    const channelAnchor = li.querySelector('a[href^="/c/"]');
    let channelName = '';
    if (channelAnchor) {
      const span = channelAnchor.querySelector('span');
      const img = channelAnchor.querySelector('img[aria-label="channel icon"]');
      channelName = (span && span.textContent.trim()) || (img && img.title) || '';
    }
    const channelHref = channelAnchor ? channelAnchor.getAttribute('href') || '' : '';

    const programAnchor =
      li.querySelector('a[href*="/p/"]') || li.querySelector('a[href^="/t/"]');
    const programHref = programAnchor ? programAnchor.getAttribute('href') || '' : '';

    return { title, channelName, channelHref, programHref };
  }

  // "/" や "///" のように、正規化すると空文字になる値は
  // 「全部に一致」という壊れた判定になるため判定対象から除外する。
  function isEffectivelyEmptyPath(s) {
    return s.replace(/\/+/g, '') === '';
  }

  // 完全URL（https://shirasu.io/c/topo）や「ホスト/パス」形式
  // （shirasu.io/c/topo）で登録された場合に、hrefと同じ相対パスの形
  // （/c/topo）へそろえる。すでに相対パスの値や、URLと無関係な語句は
  // 変化させない。
  function normalizeUrlValue(v) {
    let s = v.replace(/^https?:\/\//i, '');
    const m = s.match(/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i);
    if (m) s = m[1] || '';
    return s.replace(/\/+$/, '');
  }

  function isMuted(data, list) {
    if (!list.length) return false;

    // typeは登録時のヒントに過ぎず、判定はワード/URLの区別なく
    // テキスト一致とURL一致の両方を試す（型の選び間違いで無音失敗しないように）。
    // テキスト側は入力された値をそのまま使い、URL側だけ正規化する
    // （両方に同じ正規化をかけると、末尾"/"のようなURL都合の変換が
    // 語句の完全一致条件まで変えてしまうため）。
    const haystack = (data.title + ' ' + data.channelName).toLowerCase();
    const hrefs = [data.channelHref, data.programHref]
      .filter(Boolean)
      .map((h) => h.toLowerCase());

    return list.some((e) => {
      const raw = e.value.toLowerCase();
      if (haystack.includes(raw)) return true;

      const urlValue = normalizeUrlValue(raw);
      if (isEffectivelyEmptyPath(urlValue)) return false;
      // hrefは常にvalue以上に具体的（/c/xxxより/c/xxx/p/yyyの方が長い）
      // という前提で一方向のみ比較する。逆方向まで見ると、
      // 「/c/xxx/p/特定番組」を登録したはずが同チャンネルの別番組の
      // 短いchannelHref（/c/xxx）にも部分一致してしまう。
      return hrefs.some((h) => h.includes(urlValue));
    });
  }

  // ---------- フィルタ適用 ----------
  function applyFilter() {
    const list = loadList();
    const cards = getCards();
    for (const li of cards) {
      const data = extractCardData(li);
      const muted = isMuted(data, list);
      li.style.display = muted ? 'none' : '';
      li.dataset.shirasuMuted = muted ? '1' : '0';
    }
  }

  // ---------- 管理パネルUI ----------
  let panelEl = null;
  let listEl = null;

  function buildPanel() {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = '🔇 ミュート設定';
    Object.assign(toggleBtn.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '9999',
      padding: '8px 12px',
      border: 'none',
      borderRadius: '20px',
      background: '#222',
      color: '#fff',
      fontSize: '13px',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });

    panelEl = document.createElement('div');
    Object.assign(panelEl.style, {
      position: 'fixed',
      bottom: '56px',
      right: '16px',
      zIndex: '9999',
      width: '320px',
      maxHeight: '420px',
      overflowY: 'auto',
      background: '#fff',
      color: '#222',
      border: '1px solid #ccc',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      padding: '12px',
      fontSize: '13px',
      display: 'none',
    });

    const title = document.createElement('div');
    title.textContent = 'ミュートリスト';
    Object.assign(title.style, { fontWeight: 'bold', marginBottom: '8px' });
    panelEl.appendChild(title);

    listEl = document.createElement('div');
    panelEl.appendChild(listEl);

    const form = document.createElement('div');
    Object.assign(form.style, { marginTop: '10px', display: 'flex', gap: '4px' });

    const typeSelect = document.createElement('select');
    ['word', 'url'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t === 'word' ? 'ワード' : 'URL';
      typeSelect.appendChild(opt);
    });
    Object.assign(typeSelect.style, { flex: '0 0 70px' });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '追加する語句 / URLの一部';
    Object.assign(input.style, { flex: '1', minWidth: '0' });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '追加';
    Object.assign(addBtn.style, { flex: '0 0 auto' });

    const doAdd = () => {
      addEntry(typeSelect.value, input.value);
      input.value = '';
      input.focus();
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => {
      // IME変換確定のEnterもkeydownでは同じkey==='Enter'として届くため、
      // isComposing中は無視しないと変換確定のつもりで誤登録されてしまう。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        doAdd();
      }
    });

    form.appendChild(typeSelect);
    form.appendChild(input);
    form.appendChild(addBtn);
    panelEl.appendChild(form);

    toggleBtn.addEventListener('click', () => {
      panelEl.style.display = panelEl.style.display === 'none' ? 'block' : 'none';
      if (panelEl.style.display === 'block') renderPanelList();
    });

    document.body.appendChild(toggleBtn);
    document.body.appendChild(panelEl);
  }

  function renderPanelList() {
    if (!listEl) return;
    const list = loadList();
    listEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.textContent = '（まだ何も登録されていません）';
      empty.style.color = '#888';
      listEl.appendChild(empty);
      return;
    }
    list.forEach((entry, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        padding: '3px 0',
        borderBottom: '1px solid #eee',
      });

      const label = document.createElement('span');
      label.textContent = `[${entry.type === 'word' ? 'ワード' : 'URL'}] ${entry.value}`;
      Object.assign(label.style, {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1',
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => removeEntry(i));

      row.appendChild(label);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  // ---------- SPAのDOM更新に追従 ----------
  let debounceTimer = null;
  function scheduleApply() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilter, 150);
  }

  function init() {
    buildPanel();
    applyFilter();

    const observer = new MutationObserver(scheduleApply);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
