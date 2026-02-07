/*
 * Prompt Manager Grouping (PMG)
 *
 * 一个用于管理 SillyTavern Prompt Manager 列表（#completion_prompt_manager_list）的前端扩展：
 * - 基于名称前缀（【】与 -）进行 1~2 级分组
 * - 分组标题支持收起/展开
 * - 支持隐藏前缀（仅显示，不修改原始 prompt 名称/数据）
 * - 支持收藏（一级/二级/单独条目）+ 内联收藏面板 + 独立浮动收藏快捷栏
 * - 分组开启时禁用酒馆原生拖拽（sortable）
 * - 通过 MutationObserver 监听 UI 刷新，自动重复注入
 * - 防刷新：通过 PromptManager.prototype.render 补丁，在 toggle 时跳过昂贵的 dry-run
 *
 * 依赖：st-api-wrapper（window.ST_API）
 */

(function PromptManagerGroupingIIFE() {
  'use strict';

  const PLUGIN_NS = 'prompt-manager-grouping';

  // 使用 ST_API.variables 全局变量持久化
  const CONFIG_VAR_NAME = '__pmg_config_v1';

  /** @type {ReturnType<typeof createDefaultConfig>} */
  let config = createDefaultConfig();

  /** @type {HTMLElement|null} */
  let currentListEl = null;

  /** @type {MutationObserver|null} */
  let bodyObserver = null;

  /** @type {MutationObserver|null} */
  let listObserver = null;

  let applying = false;
  let applyTimer = null;

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------

  function log(...args) {
    console.log(`[${PLUGIN_NS}]`, ...args);
  }

  function warn(...args) {
    console.warn(`[${PLUGIN_NS}]`, ...args);
  }

  function safeJsonClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj;
    }
  }

  function debounceApply(reason, delayMs = 80) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyAll(reason);
    }, delayMs);
  }

  function createDefaultConfig() {
    return {
      version: 1,

      // 分组
      groupingEnabled: true,
      secondLevelEnabled: true,
      hidePrefixes: true,

      // 收藏
      favoritesEnabled: true,
      favoritesPanelEnabled: true,
      favoritesPanelExpanded: true,

      // 浮动收藏快捷栏（独立于预设面板）
      floatingPanelEnabled: true,
      floatingPanelExpanded: false,

      // 浮动元素位置（null = 使用默认 CSS 位置，拖拽后保存 { left, top }）
      floatingTogglePos: null,
      floatingPanelPos: null,

      // 收藏栏里"组"项是否默认展开
      favoritesExpandGroupsByDefault: true,

      // 收藏栏里各组的展开状态
      favoritesExpanded: {
        group1: [],
        group2: [],
      },

      // 防刷新：通过 render 补丁跳过 dry-run
      blockPresetUiRefreshOnToggle: false,

      // 收藏数据
      favorites: {
        group1: [],
        group2: [],
        items: [],
      },

      // 折叠状态
      collapsed: {
        group1: [],
        group2: [],
      },
    };
  }

  function mergeConfig(base, incoming) {
    const out = safeJsonClone(base);
    if (!incoming || typeof incoming !== 'object') return out;

    const keys = [
      'groupingEnabled',
      'secondLevelEnabled',
      'hidePrefixes',
      'favoritesEnabled',
      'favoritesPanelEnabled',
      'favoritesPanelExpanded',
      'floatingPanelEnabled',
      'floatingPanelExpanded',
      'floatingTogglePos',
      'floatingPanelPos',
      'favoritesExpandGroupsByDefault',
      'blockPresetUiRefreshOnToggle',
      'favorites',
      'favoritesExpanded',
      'collapsed',
    ];

    for (const k of keys) {
      if (k in incoming) out[k] = incoming[k];
    }

    out.favorites = {
      group1: Array.isArray(out.favorites?.group1) ? out.favorites.group1 : [],
      group2: Array.isArray(out.favorites?.group2) ? out.favorites.group2 : [],
      items: Array.isArray(out.favorites?.items) ? out.favorites.items : [],
    };

    out.collapsed = {
      group1: Array.isArray(out.collapsed?.group1) ? out.collapsed.group1 : [],
      group2: Array.isArray(out.collapsed?.group2) ? out.collapsed.group2 : [],
    };

    out.favoritesExpanded = {
      group1: Array.isArray(out.favoritesExpanded?.group1) ? out.favoritesExpanded.group1 : [],
      group2: Array.isArray(out.favoritesExpanded?.group2) ? out.favoritesExpanded.group2 : [],
    };

    return out;
  }

  function isFavoritesGroup1Expanded(group1) {
    const set = new Set(config.favoritesExpanded?.group1 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    return defaultExpanded ? !set.has(group1) : set.has(group1);
  }

  function isFavoritesGroup2Expanded(key) {
    const set = new Set(config.favoritesExpanded?.group2 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    return defaultExpanded ? !set.has(key) : set.has(key);
  }

  function setFavoritesGroup1Expanded(group1, expanded) {
    const set = new Set(config.favoritesExpanded?.group1 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    if (defaultExpanded) {
      if (expanded) set.delete(group1);
      else set.add(group1);
    } else {
      if (expanded) set.add(group1);
      else set.delete(group1);
    }
    config.favoritesExpanded = config.favoritesExpanded || { group1: [], group2: [] };
    config.favoritesExpanded.group1 = Array.from(set);
  }

  function setFavoritesGroup2Expanded(key, expanded) {
    const set = new Set(config.favoritesExpanded?.group2 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    if (defaultExpanded) {
      if (expanded) set.delete(key);
      else set.add(key);
    } else {
      if (expanded) set.add(key);
      else set.delete(key);
    }
    config.favoritesExpanded = config.favoritesExpanded || { group1: [], group2: [] };
    config.favoritesExpanded.group2 = Array.from(set);
  }

  // ---------------------------------------------------------------------------
  // Block SillyTavern preset UI refresh on prompt toggle
  // (via PromptManager.prototype.render patch)
  //
  // 说明：
  // 酒馆在 toggle prompt 开关后会调用 PromptManager.render(true)，
  // 其中 render(true) 会先执行 tryGenerate()（dry-run token 计数，触发大量网络请求），
  // 再重建整个 prompt 列表 DOM。这导致：
  //   1. 体感卡顿（等待 token 计数）
  //   2. 注入的分组头被销毁
  //
  // 方案：直接 monkey-patch PromptManager.prototype.render，
  // 在"冻结"期间将 render(true) 降级为 render(false)（仅更新 UI，不做 dry-run）。
  // 当用户点击 Prompt Manager 以外的区域时，解除冻结并补做一次 render(true)。
  //
  // 优势（相比 emit 补丁）：
  //   - 不干扰全局事件系统
  //   - 精确针对 PromptManager 的渲染路径
  // ---------------------------------------------------------------------------

  /** @type {null | {
   *  installed: boolean;
   *  prevRender: Function;
   *  patchedRender: Function;
   *  freezeActive: boolean;
   *  pendingDryRun: boolean;
   *  pendingInstance: any;
   *  outsideClickHandler: ((e: MouseEvent) => void) | null;
   * }} */
  let renderPatchState = null;

  async function installRenderPatch() {
    if (renderPatchState?.installed) return;
    if (!config.blockPresetUiRefreshOnToggle) return;

    let mod;
    try {
      mod = await import('/scripts/PromptManager.js');
    } catch (e) {
      warn('Failed to import PromptManager.js for render patch:', e);
      return;
    }

    const PromptManager = mod?.PromptManager;
    const proto = PromptManager?.prototype;
    if (!proto || typeof proto.render !== 'function') {
      warn('PromptManager.prototype.render not found');
      return;
    }

    // 避免重复 patch
    if (proto.render.__pmgRenderPatched) {
      renderPatchState = {
        installed: true,
        prevRender: proto.render.__pmgPrevRender || proto.render,
        patchedRender: proto.render,
        freezeActive: false,
        pendingDryRun: false,
        pendingInstance: null,
        outsideClickHandler: null,
      };
      installOutsideClickForRenderPatch();
      return;
    }

    const prevRender = proto.render;

    const state = {
      installed: true,
      prevRender,
      patchedRender: null,
      freezeActive: false,
      pendingDryRun: false,
      pendingInstance: null,
      outsideClickHandler: null,
    };

    // 找到最原始的 render（穿过 cocktail 的 wrapper）
    const trueOriginal =
      prevRender.__stPresetPanelOptimizerOriginalRender ||
      prevRender.__pmgPrevRender ||
      prevRender;

    state.patchedRender = function pmgPatchedRender(afterTryGenerate = true) {
      if (state.freezeActive && afterTryGenerate && config.blockPresetUiRefreshOnToggle) {
        // 降级：跳过 tryGenerate (dry-run)，仅渲染 UI
        try {
          trueOriginal.call(this, false);
        } catch (e) {
          return prevRender.call(this, afterTryGenerate);
        }
        state.pendingDryRun = true;
        state.pendingInstance = this;
        return;
      }
      return prevRender.call(this, afterTryGenerate);
    };

    state.patchedRender.__pmgRenderPatched = true;
    state.patchedRender.__pmgPrevRender = prevRender;

    // 保留 cocktail 的标记
    if (prevRender.__stPresetPanelOptimizerPatched) {
      state.patchedRender.__stPresetPanelOptimizerPatched = true;
      state.patchedRender.__stPresetPanelOptimizerOriginalRender =
        prevRender.__stPresetPanelOptimizerOriginalRender;
    }

    proto.render = state.patchedRender;
    renderPatchState = state;

    installOutsideClickForRenderPatch();
    log('PromptManager.render patched for anti-refresh');
  }

  function installOutsideClickForRenderPatch() {
    if (!renderPatchState || renderPatchState.outsideClickHandler) return;

    renderPatchState.outsideClickHandler = (e) => {
      if (!renderPatchState?.freezeActive) return;

      const pm = getPromptManagerContainer();
      const target = e.target;
      if (pm && target instanceof Node && pm.contains(target)) return;

      renderPatchState.freezeActive = false;

      if (renderPatchState.pendingDryRun && renderPatchState.pendingInstance) {
        const inst = renderPatchState.pendingInstance;
        renderPatchState.pendingDryRun = false;
        renderPatchState.pendingInstance = null;
        setTimeout(() => {
          try {
            renderPatchState.prevRender.call(inst, true);
          } catch {
            // ignore
          }
        }, 0);
      }
    };

    document.addEventListener('click', renderPatchState.outsideClickHandler, true);
  }

  function uninstallRenderPatch() {
    const state = renderPatchState;
    if (!state?.installed) return;

    try {
      if (state.outsideClickHandler) {
        document.removeEventListener('click', state.outsideClickHandler, true);
      }
    } catch {
      // ignore
    }

    // 不强行恢复 prototype（其他插件可能也 wrap 了），只让冻结逻辑失效
    if (state.patchedRender) {
      state.patchedRender.__pmgDisabled = true;
    }

    renderPatchState = null;
  }

  function activateRenderFreeze() {
    if (!config.blockPresetUiRefreshOnToggle) return;
    if (!renderPatchState?.installed) {
      installRenderPatch();
    }
    if (!renderPatchState?.installed) return;
    renderPatchState.freezeActive = true;
  }

  // ---------------------------------------------------------------------------
  // General helpers
  // ---------------------------------------------------------------------------

  function getSTApi() {
    return window.ST_API;
  }

  function getJQuery() {
    return window.jQuery || window.$;
  }

  function ensureArrayUnique(arr) {
    return Array.from(new Set(Array.isArray(arr) ? arr : []));
  }

  function group2Key(group1, group2) {
    return `${String(group1)}|||${String(group2)}`;
  }

  function splitGroup2Key(key) {
    const s = String(key);
    const idx = s.indexOf('|||');
    if (idx < 0) return { group1: s, group2: '' };
    return {
      group1: s.slice(0, idx),
      group2: s.slice(idx + 3),
    };
  }

  function setCollapsedGroup1(group1, collapsed) {
    const set = new Set(config.collapsed.group1);
    if (collapsed) set.add(group1);
    else set.delete(group1);
    config.collapsed.group1 = Array.from(set);
  }

  function setCollapsedGroup2(key, collapsed) {
    const set = new Set(config.collapsed.group2);
    if (collapsed) set.add(key);
    else set.delete(key);
    config.collapsed.group2 = Array.from(set);
  }

  function isGroup1Collapsed(group1) {
    return new Set(config.collapsed.group1).has(group1);
  }

  function isGroup2Collapsed(key) {
    return new Set(config.collapsed.group2).has(key);
  }

  function isGroup1Favorited(group1) {
    return new Set(config.favorites.group1).has(group1);
  }

  function isGroup2Favorited(key) {
    return new Set(config.favorites.group2).has(key);
  }

  function isItemFavorited(identifier) {
    return new Set(config.favorites.items).has(identifier);
  }

  function toggleFavoriteGroup1(group1) {
    const set = new Set(config.favorites.group1);
    if (set.has(group1)) set.delete(group1);
    else set.add(group1);
    config.favorites.group1 = Array.from(set);
  }

  function toggleFavoriteGroup2(key) {
    const set = new Set(config.favorites.group2);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    config.favorites.group2 = Array.from(set);
  }

  function toggleFavoriteItem(identifier) {
    const set = new Set(config.favorites.items);
    if (set.has(identifier)) set.delete(identifier);
    else set.add(identifier);
    config.favorites.items = Array.from(set);
  }

  async function loadConfig() {
    const ST_API = getSTApi();
    if (!ST_API?.variables?.get) return;

    try {
      const res = await ST_API.variables.get({ name: CONFIG_VAR_NAME, scope: 'global' });
      let loaded = res?.value;

      // SillyTavern 变量系统可能将值存为字符串，需要反序列化
      if (typeof loaded === 'string') {
        try { loaded = JSON.parse(loaded); } catch {
          warn('Config value is not valid JSON, using defaults');
          loaded = null;
        }
      }

      config = mergeConfig(createDefaultConfig(), loaded);

      config.favorites.group1 = ensureArrayUnique(config.favorites.group1);
      config.favorites.group2 = ensureArrayUnique(config.favorites.group2);
      config.favorites.items = ensureArrayUnique(config.favorites.items);
      config.collapsed.group1 = ensureArrayUnique(config.collapsed.group1);
      config.collapsed.group2 = ensureArrayUnique(config.collapsed.group2);
      config.favoritesExpanded = config.favoritesExpanded || { group1: [], group2: [] };
      config.favoritesExpanded.group1 = ensureArrayUnique(config.favoritesExpanded.group1);
      config.favoritesExpanded.group2 = ensureArrayUnique(config.favoritesExpanded.group2);

      log('Config loaded:', config);
    } catch (e) {
      warn('Config load failed, using defaults:', e);
      config = createDefaultConfig();
    }
  }

  async function saveConfig() {
    const ST_API = getSTApi();
    if (!ST_API?.variables?.set) return;

    try {
      // 显式序列化为 JSON 字符串，因为 SillyTavern 变量系统会将值转为字符串
      await ST_API.variables.set({ name: CONFIG_VAR_NAME, scope: 'global', value: JSON.stringify(config) });
    } catch (e) {
      warn('Config save failed:', e);
    }
  }

  function waitFor(cond, timeoutMs = 15000, intervalMs = 100) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const t = setInterval(() => {
        try {
          if (cond()) {
            clearInterval(t);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(t);
            reject(new Error('timeout'));
          }
        } catch (e) {
          clearInterval(t);
          reject(e);
        }
      }, intervalMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Name parsing (prefix -> group path)
  // ---------------------------------------------------------------------------

  const RE_BRACKET = /^\u3010([^\u3011]+)\u3011\s*/;

  function splitDash(s) {
    const str = String(s);
    const idx = str.indexOf('-');
    const idx2 = str.indexOf('－');
    let i = idx;
    if (i < 0 || (idx2 >= 0 && idx2 < i)) i = idx2;
    if (i <= 0) return null;

    const left = str.slice(0, i).trim();
    const right = str.slice(i + 1).trimStart();
    if (!left) return null;
    return { left, right };
  }

  function parsePromptName(name, enableSecondLevel) {
    let rest = String(name ?? '');
    const original = rest;

    let group1;
    let group2;

    // level 1
    let m = rest.match(RE_BRACKET);
    if (m) {
      group1 = String(m[1]).trim();
      rest = rest.slice(m[0].length);
    } else {
      const d = splitDash(rest);
      if (d) {
        group1 = d.left;
        rest = d.right;
      }
    }

    // level 2
    if (enableSecondLevel && group1) {
      const r2 = String(rest).trimStart();
      m = r2.match(RE_BRACKET);
      if (m) {
        group2 = String(m[1]).trim();
        rest = r2.slice(m[0].length);
      } else {
        const d2 = splitDash(r2);
        if (d2) {
          group2 = d2.left;
          rest = d2.right;
        } else {
          rest = r2;
        }
      }
    } else {
      rest = String(rest).trimStart();
    }

    const leaf = String(rest).trimStart();

    return {
      original,
      group1,
      group2,
      leaf,
      hasPrefix: Boolean(group1),
    };
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (Prompt Manager)
  // ---------------------------------------------------------------------------

  function findPromptManagerList() {
    return document.getElementById('completion_prompt_manager_list');
  }

  function getPromptManagerContainer() {
    return document.getElementById('completion_prompt_manager');
  }

  function getPromptNameAnchor(li) {
    return li.querySelector('a.prompt-manager-inspect-action');
  }

  function getPromptControlsSpan(li) {
    return li.querySelector('.prompt_manager_prompt_controls');
  }

  function getPromptToggleIcon(li) {
    return li.querySelector('.prompt-manager-toggle-action');
  }

  function getPromptIdentifier(li) {
    return li?.dataset?.pmIdentifier || '';
  }

  function isPromptItemLi(li) {
    return li instanceof HTMLElement && li.classList.contains('completion_prompt_manager_prompt');
  }

  function removeInjectedGroupHeaders(listEl) {
    listEl.querySelectorAll('li.pmg-group-header').forEach((el) => el.remove());
  }

  function cleanupPromptItemMarks(listEl) {
    listEl.querySelectorAll('li.completion_prompt_manager_prompt').forEach((li) => {
      li.classList.remove('pmg-in-group1', 'pmg-in-group2');
      delete li.dataset.pmgGroup1;
      delete li.dataset.pmgGroup2;
      delete li.dataset.pmgHasPrefix;
    });
  }

  function restorePromptDisplayName(li) {
    const a = getPromptNameAnchor(li);
    if (!a) return;
    const orig = a.dataset.pmgOriginalName;
    const origTitle = a.dataset.pmgOriginalTitle;
    if (typeof orig === 'string') a.textContent = orig;
    if (typeof origTitle === 'string') a.title = origTitle;
  }

  function getCanonicalPromptName(li) {
    const nameSpan = li.querySelector('.completion_prompt_manager_prompt_name');
    const pmName = nameSpan?.dataset?.pmName;
    if (typeof pmName === 'string' && pmName.trim()) return pmName.trim();
    const a = getPromptNameAnchor(li);
    if (!a) return '';
    return String(a.dataset.pmgOriginalName ?? '').trim();
  }

  function saveOriginalPromptDisplayName(li) {
    const a = getPromptNameAnchor(li);
    if (!a) return;
    const canonicalName = getCanonicalPromptName(li);
    if (canonicalName) {
      a.dataset.pmgOriginalName = canonicalName;
      a.dataset.pmgOriginalTitle = canonicalName;
      return;
    }
    if (!('pmgOriginalName' in a.dataset)) {
      a.dataset.pmgOriginalName = a.textContent ?? '';
    }
    if (!('pmgOriginalTitle' in a.dataset)) {
      a.dataset.pmgOriginalTitle = a.title ?? '';
    }
  }

  function setPromptDisplayName(li, displayName) {
    const a = getPromptNameAnchor(li);
    if (!a) return;
    saveOriginalPromptDisplayName(li);
    a.textContent = displayName;
    if (a.dataset.pmgOriginalTitle) a.title = a.dataset.pmgOriginalTitle;
  }

  // ---------------------------------------------------------------------------
  // Favorites button for item
  // ---------------------------------------------------------------------------

  function ensureItemFavoriteButton(li) {
    if (!config.favoritesEnabled) return;
    const controls = getPromptControlsSpan(li);
    if (!controls) return;
    const identifier = getPromptIdentifier(li);
    if (!identifier) return;
    if (controls.querySelector('[data-pmg-role="item-fav"]')) return;

    const btn = document.createElement('span');
    btn.setAttribute('data-pmg-role', 'item-fav');
    btn.className = 'pmg-fav-action fa-solid fa-star fa-xs interactable';
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');

    const refreshVisual = () => {
      const fav = isItemFavorited(identifier);
      btn.classList.toggle('pmg-fav-on', fav);
      btn.classList.toggle('pmg-fav-off', !fav);
      btn.title = fav ? '取消收藏' : '收藏';
    };

    const onToggle = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavoriteItem(identifier);
      refreshVisual();
      await saveConfig();
      renderAllFavoritesPanels();
    };

    btn.addEventListener('click', onToggle);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onToggle(e);
    });

    controls.appendChild(btn);
    refreshVisual();
  }

  function removeItemFavoriteButton(li) {
    const controls = getPromptControlsSpan(li);
    if (!controls) return;
    controls.querySelectorAll('[data-pmg-role="item-fav"]').forEach((el) => el.remove());
  }

  // ---------------------------------------------------------------------------
  // Group headers
  // ---------------------------------------------------------------------------

  function createGroupHeaderLi({ level, group1, group2 }) {
    const li = document.createElement('li');
    li.className = `pmg-group-header pmg-level${level}`;
    li.dataset.pmgLevel = String(level);
    li.dataset.pmgGroup1 = String(group1);
    if (group2) li.dataset.pmgGroup2 = String(group2);

    const row = document.createElement('div');
    row.className = 'pmg-group-header-row';

    const arrow = document.createElement('span');
    arrow.className = 'pmg-collapse-icon fa-solid fa-chevron-down';

    const title = document.createElement('span');
    title.className = 'pmg-group-title';
    title.textContent = level === 1 ? String(group1) : String(group2);

    const spacer = document.createElement('span');
    spacer.className = 'pmg-flex-spacer';

    let fav = null;
    if (config.favoritesEnabled) {
      fav = document.createElement('span');
      fav.className = 'pmg-group-fav fa-solid fa-star fa-xs interactable';
      fav.tabIndex = 0;
      fav.setAttribute('role', 'button');
    }

    row.appendChild(arrow);
    row.appendChild(title);
    row.appendChild(spacer);
    if (fav) row.appendChild(fav);
    li.appendChild(row);

    const refreshVisual = () => {
      if (level === 1) {
        const collapsed = isGroup1Collapsed(String(group1));
        arrow.classList.toggle('fa-chevron-right', collapsed);
        arrow.classList.toggle('fa-chevron-down', !collapsed);
        if (fav) {
          const favOn = isGroup1Favorited(String(group1));
          fav.classList.toggle('pmg-fav-on', favOn);
          fav.classList.toggle('pmg-fav-off', !favOn);
          fav.title = favOn ? '取消收藏一级分组' : '收藏一级分组';
        }
      } else {
        const key = group2Key(String(group1), String(group2));
        const collapsed = isGroup2Collapsed(key);
        arrow.classList.toggle('fa-chevron-right', collapsed);
        arrow.classList.toggle('fa-chevron-down', !collapsed);
        if (fav) {
          const favOn = isGroup2Favorited(key);
          fav.classList.toggle('pmg-fav-on', favOn);
          fav.classList.toggle('pmg-fav-off', !favOn);
          fav.title = favOn ? '取消收藏二级分组' : '收藏二级分组';
        }
      }
    };

    const toggleCollapse = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (level === 1) {
        const g1 = String(group1);
        setCollapsedGroup1(g1, !isGroup1Collapsed(g1));
      } else {
        const key = group2Key(String(group1), String(group2));
        setCollapsedGroup2(key, !isGroup2Collapsed(key));
      }
      refreshVisual();
      applyCollapseVisibility();
      await saveConfig();
      renderAllFavoritesPanels();
    };

    row.addEventListener('click', toggleCollapse);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggleCollapse(e);
    });

    const toggleFav = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (level === 1) {
        toggleFavoriteGroup1(String(group1));
      } else {
        toggleFavoriteGroup2(group2Key(String(group1), String(group2)));
      }
      refreshVisual();
      await saveConfig();
      renderAllFavoritesPanels();
    };

    if (fav) {
      fav.addEventListener('click', toggleFav);
      fav.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') toggleFav(e);
      });
    }

    refreshVisual();
    return li;
  }

  // ---------------------------------------------------------------------------
  // Apply grouping + collapse
  // ---------------------------------------------------------------------------

  function disableNativeSortable(listEl) {
    const $ = getJQuery();
    if ($ && typeof $(listEl).sortable === 'function') {
      try {
        const inst = $(listEl).data('ui-sortable');
        if (inst) { $(listEl).sortable('disable'); return; }
      } catch { /* ignore */ }
    }
    listEl.classList.add('pmg-no-native-drag');
  }

  function enableNativeSortable(listEl) {
    const $ = getJQuery();
    if ($ && typeof $(listEl).sortable === 'function') {
      try {
        const inst = $(listEl).data('ui-sortable');
        if (inst) { $(listEl).sortable('enable'); return; }
      } catch { /* ignore */ }
    }
    listEl.classList.remove('pmg-no-native-drag');
  }

  function applyGrouping() {
    if (!currentListEl) return;
    const listEl = currentListEl;

    removeInjectedGroupHeaders(listEl);
    cleanupPromptItemMarks(listEl);

    if (config.groupingEnabled) {
      disableNativeSortable(listEl);
    } else {
      enableNativeSortable(listEl);
    }

    const items = Array.from(listEl.children).filter(isPromptItemLi);

    if (config.favoritesEnabled) {
      for (const li of items) ensureItemFavoriteButton(li);
    } else {
      for (const li of items) removeItemFavoriteButton(li);
    }

    if (!config.groupingEnabled) {
      for (const li of items) restorePromptDisplayName(li);
      applyCollapseVisibility();
      return;
    }

    let currentGroup1 = null;
    let currentGroup2 = null;

    for (const li of items) {
      const a = getPromptNameAnchor(li);
      if (!a) continue;

      saveOriginalPromptDisplayName(li);
      const originalName = a.dataset.pmgOriginalName ?? getCanonicalPromptName(li) ?? a.textContent ?? '';
      const parsed = parsePromptName(originalName, config.secondLevelEnabled);

      if (!parsed.hasPrefix) {
        currentGroup1 = null;
        currentGroup2 = null;
        li.dataset.pmgHasPrefix = '0';
        li.classList.add('pmg-item-standalone');
        restorePromptDisplayName(li);
        continue;
      }

      li.dataset.pmgHasPrefix = '1';
      li.dataset.pmgGroup1 = parsed.group1;
      li.classList.add('pmg-in-group1');
      li.classList.remove('pmg-item-standalone');

      const g1 = parsed.group1;
      const g2 = parsed.group2;

      if (g1 && g1 !== currentGroup1) {
        const header1 = createGroupHeaderLi({ level: 1, group1: g1 });
        listEl.insertBefore(header1, li);
        currentGroup1 = g1;
        currentGroup2 = null;
      }

      if (config.secondLevelEnabled && g1 && g2) {
        li.dataset.pmgGroup2 = g2;
        li.classList.add('pmg-in-group2');
        if (g2 !== currentGroup2) {
          const header2 = createGroupHeaderLi({ level: 2, group1: g1, group2: g2 });
          listEl.insertBefore(header2, li);
          currentGroup2 = g2;
        }
      } else {
        delete li.dataset.pmgGroup2;
        li.classList.remove('pmg-in-group2');
        currentGroup2 = null;
      }

      if (config.hidePrefixes) {
        setPromptDisplayName(li, parsed.leaf || originalName);
      } else {
        restorePromptDisplayName(li);
      }
    }

    applyCollapseVisibility();
  }

  function applyCollapseVisibility() {
    if (!currentListEl) return;
    const listEl = currentListEl;

    for (const child of Array.from(listEl.children)) {
      if (!(child instanceof HTMLElement)) continue;

      if (child.classList.contains('pmg-group-header')) {
        const level = Number(child.dataset.pmgLevel || '0');
        const g1 = child.dataset.pmgGroup1;
        const g2 = child.dataset.pmgGroup2;

        if (level === 1) {
          child.style.display = '';
        } else if (level === 2) {
          child.style.display = g1 && isGroup1Collapsed(g1) ? 'none' : '';
          const arrow = child.querySelector('.pmg-collapse-icon');
          if (arrow) {
            const key = group2Key(g1, g2);
            const collapsed = isGroup2Collapsed(key);
            arrow.classList.toggle('fa-chevron-right', collapsed);
            arrow.classList.toggle('fa-chevron-down', !collapsed);
          }
        }

        const fav = child.querySelector('.pmg-group-fav');
        if (fav) {
          if (level === 1 && g1) {
            const on = isGroup1Favorited(g1);
            fav.classList.toggle('pmg-fav-on', on);
            fav.classList.toggle('pmg-fav-off', !on);
          } else if (level === 2 && g1 && g2) {
            const on = isGroup2Favorited(group2Key(g1, g2));
            fav.classList.toggle('pmg-fav-on', on);
            fav.classList.toggle('pmg-fav-off', !on);
          }
        }

        if (level === 1 && g1) {
          const arrow = child.querySelector('.pmg-collapse-icon');
          if (arrow) {
            const collapsed = isGroup1Collapsed(g1);
            arrow.classList.toggle('fa-chevron-right', collapsed);
            arrow.classList.toggle('fa-chevron-down', !collapsed);
          }
        }
        continue;
      }

      if (isPromptItemLi(child)) {
        const g1 = child.dataset.pmgGroup1;
        const g2 = child.dataset.pmgGroup2;
        const hasPrefix = child.dataset.pmgHasPrefix === '1';

        if (!config.groupingEnabled || !hasPrefix || !g1) {
          child.style.display = '';
          continue;
        }

        if (isGroup1Collapsed(g1)) {
          child.style.display = 'none';
          continue;
        }

        if (config.secondLevelEnabled && g2 && isGroup2Collapsed(group2Key(g1, g2))) {
          child.style.display = 'none';
          continue;
        }

        child.style.display = '';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared Favorites Content Rendering
  // ---------------------------------------------------------------------------

  function normalizeFavoritesData() {
    try {
      const snapshot = getPromptItemsSnapshot();
      const itemIdSet = new Set(snapshot.map((x) => x.identifier).filter(Boolean));
      config.favorites.items = (config.favorites.items || []).filter((id) => itemIdSet.has(id));

      const realGroup2 = new Set(
        snapshot
          .filter((x) => x.hasPrefix && x.group1 && x.group2)
          .map((x) => group2Key(x.group1, x.group2))
      );
      config.favorites.group2 = (config.favorites.group2 || []).filter((k) => realGroup2.has(k));

      const realGroup1 = new Set(snapshot.filter((x) => x.hasPrefix && x.group1).map((x) => x.group1));
      config.favorites.group1 = (config.favorites.group1 || []).filter((g1) => realGroup1.has(g1));
    } catch {
      // ignore
    }
  }

  function getPromptItemsSnapshot() {
    const listEl = findPromptManagerList();
    if (!listEl) return [];
    const items = Array.from(listEl.querySelectorAll('li.completion_prompt_manager_prompt'));
    return items.map((li) => {
      const identifier = getPromptIdentifier(li);
      const name = getCanonicalPromptName(li);
      const parsed = parsePromptName(name, true);
      const displayName = (config.hidePrefixes && parsed.leaf) ? parsed.leaf : name;
      return {
        li,
        identifier,
        name,
        group1: parsed.group1,
        group2: parsed.group2,
        leaf: parsed.leaf || name,
        hasPrefix: parsed.hasPrefix,
      };
    });
  }

  function isPromptEnabled(li) {
    const toggle = getPromptToggleIcon(li);
    if (!toggle) return false;
    return toggle.classList.contains('fa-toggle-on');
  }

  function clickPromptToggle(li, enable) {
    const toggle = getPromptToggleIcon(li);
    if (!toggle) return;
    const isOn = toggle.classList.contains('fa-toggle-on');
    if (config.blockPresetUiRefreshOnToggle) activateRenderFreeze();
    if (enable && !isOn) toggle.click();
    if (!enable && isOn) toggle.click();
  }

  function toggleGroupPrompts({ group1, group2 }) {
    const snapshot = getPromptItemsSnapshot();
    const items = snapshot.filter((x) => {
      if (!x.hasPrefix || x.group1 !== group1) return false;
      if (group2) return x.group2 === group2;
      return true;
    });
    if (items.length === 0) return;
    const enabledCount = items.reduce((acc, x) => acc + (isPromptEnabled(x.li) ? 1 : 0), 0);
    const targetEnable = enabledCount !== items.length;
    for (const it of items) clickPromptToggle(it.li, targetEnable);
  }

  function toggleItemPromptByIdentifier(identifier) {
    const snapshot = getPromptItemsSnapshot();
    const found = snapshot.find((x) => x.identifier === identifier);
    if (!found) return;
    clickPromptToggle(found.li, !isPromptEnabled(found.li));
  }

  /**
   * 共享：渲染收藏内容到指定容器
   * 供 inline 面板和 floating 面板共用
   */
  function renderFavoritesContent(body) {
    body.innerHTML = '';

    const listEl = findPromptManagerList();
    if (!listEl) {
      const msg = document.createElement('div');
      msg.className = 'pmg-fav-empty';
      msg.textContent = '请先打开预设面板以加载提示词列表';
      body.appendChild(msg);
      return;
    }

    normalizeFavoritesData();
    const favGroup1 = ensureArrayUnique(config.favorites.group1);
    const favGroup2 = ensureArrayUnique(config.favorites.group2);
    const favItems = ensureArrayUnique(config.favorites.items);

    const group1Set = new Set(favGroup1);
    const effectiveGroup2 = favGroup2.filter((k) => {
      const { group1 } = splitGroup2Key(k);
      return !group1Set.has(group1);
    });

    const snapshot = getPromptItemsSnapshot();

    const makeRow = (titleText) => {
      const row = document.createElement('div');
      row.className = 'pmg-fav-row';

      const title = document.createElement('div');
      title.className = 'pmg-fav-title';
      title.textContent = titleText;

      const spacer = document.createElement('div');
      spacer.className = 'pmg-flex-spacer';

      const btnToggle = document.createElement('span');
      btnToggle.className = 'pmg-fav-toggle fa-solid fa-toggle-on interactable';
      btnToggle.title = '开关';
      btnToggle.tabIndex = 0;
      btnToggle.setAttribute('role', 'button');

      const btnUnfav = document.createElement('span');
      btnUnfav.className = 'pmg-fav-unfav fa-solid fa-star fa-xs interactable pmg-fav-on';
      btnUnfav.title = '取消收藏';
      btnUnfav.tabIndex = 0;
      btnUnfav.setAttribute('role', 'button');

      row.appendChild(title);
      row.appendChild(spacer);
      row.appendChild(btnToggle);
      row.appendChild(btnUnfav);

      return { row, title, btnToggle, btnUnfav };
    };

    const makeGroupRow = ({ titleText, expanded }) => {
      const { row, title, btnToggle, btnUnfav } = makeRow(titleText);
      row.classList.add('pmg-fav-group-row');

      const exp = document.createElement('span');
      exp.className = `pmg-fav-expand fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} interactable`;
      exp.title = expanded ? '收起' : '展开';
      exp.tabIndex = 0;
      exp.setAttribute('role', 'button');
      row.insertBefore(exp, title);
      return { row, exp, btnToggle, btnUnfav };
    };

    const makeChildrenContainer = (visible) => {
      const div = document.createElement('div');
      div.className = 'pmg-fav-children';
      div.style.display = visible ? 'block' : 'none';
      return div;
    };

    const getDisplayName = (it) => config.hidePrefixes ? it.leaf : it.name;

    /** 渲染单个条目行并挂载到 container */
    const renderChildItem = (it, container, debugTag) => {
      const { row: cRow, btnToggle: cToggle, btnUnfav: cFav } = makeRow(getDisplayName(it));
      cRow.classList.add('pmg-fav-child-row');
      const on = isPromptEnabled(it.li);
      cToggle.classList.toggle('fa-toggle-on', on);
      cToggle.classList.toggle('fa-toggle-off', !on);
      cToggle.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleItemPromptByIdentifier(it.identifier);
        setTimeout(renderAllFavoritesPanels, 60);
      });
      const favOn = isItemFavorited(it.identifier);
      cFav.classList.toggle('pmg-fav-on', favOn);
      cFav.classList.toggle('pmg-fav-off', !favOn);
      cFav.title = favOn ? '取消收藏该条目' : '收藏该条目';
      cFav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteItem(it.identifier);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply(debugTag || 'toggle-fav-item', 0);
      });
      container.appendChild(cRow);
    };

    const hasAny = favGroup1.length + effectiveGroup2.length + favItems.length > 0;
    if (!hasAny) {
      const empty = document.createElement('div');
      empty.className = 'pmg-fav-empty';
      empty.textContent = '暂无收藏（可在提示词条目右侧点击\u2B50，或在分组标题右侧点击\u2B50）';
      body.appendChild(empty);
      return;
    }

    // 1) 一级组
    for (const g1 of favGroup1) {
      const expanded = isFavoritesGroup1Expanded(g1);
      const { row, exp, btnToggle, btnUnfav } = makeGroupRow({ titleText: `\u3010${g1}\u3011`, expanded });

      const toggleExpand = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        setFavoritesGroup1Expanded(g1, !isFavoritesGroup1Expanded(g1));
        await saveConfig();
        renderAllFavoritesPanels();
      };

      exp.addEventListener('click', toggleExpand);
      row.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.closest('.pmg-fav-toggle') || t.closest('.pmg-fav-unfav') || t.closest('.pmg-fav-expand')) return;
        toggleExpand(e);
      });

      btnToggle.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleGroupPrompts({ group1: g1 });
        setTimeout(renderAllFavoritesPanels, 60);
      });

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteGroup1(g1);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply('unfav-group1', 0);
      });

      body.appendChild(row);

      const children = makeChildrenContainer(expanded);
      const group2SetLocal = new Set(effectiveGroup2);
      // 属于该 group1 的所有条目（排除已单独收藏为二级组的）
      const allInG1 = snapshot.filter((x) => {
        if (!x.hasPrefix || x.group1 !== g1) return false;
        if (x.group2 && group2SetLocal.has(group2Key(g1, x.group2))) return false;
        return true;
      });

      if (config.secondLevelEnabled) {
        // 按 group2 分组
        const g2Map = new Map();  // group2 -> items[]
        const noG2Items = [];
        for (const it of allInG1) {
          if (it.group2) {
            if (!g2Map.has(it.group2)) g2Map.set(it.group2, []);
            g2Map.get(it.group2).push(it);
          } else {
            noG2Items.push(it);
          }
        }
        // 无 group2 的条目直接渲染
        for (const it of noG2Items) {
          renderChildItem(it, children, 'toggle-fav-item-in-group1');
        }
        // 有 group2 的按子分组渲染
        for (const [g2Name, g2Items] of g2Map) {
          const g2Key = group2Key(g1, g2Name);
          const g2Expanded = isFavoritesGroup2Expanded(g2Key);
          const { row: g2Row, exp: g2Exp, btnToggle: g2Toggle, btnUnfav: g2Fav } = makeGroupRow({ titleText: g2Name, expanded: g2Expanded });
          g2Row.classList.add('pmg-fav-sub-group-row');

          const toggleG2Expand = async (ev) => {
            if (ev?.preventDefault) ev.preventDefault();
            if (ev?.stopPropagation) ev.stopPropagation();
            setFavoritesGroup2Expanded(g2Key, !isFavoritesGroup2Expanded(g2Key));
            await saveConfig();
            renderAllFavoritesPanels();
          };
          g2Exp.addEventListener('click', toggleG2Expand);
          g2Row.addEventListener('click', (ev) => {
            const t = ev.target;
            if (!(t instanceof HTMLElement)) return;
            if (t.closest('.pmg-fav-toggle') || t.closest('.pmg-fav-unfav') || t.closest('.pmg-fav-expand')) return;
            toggleG2Expand(ev);
          });
          g2Toggle.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            toggleGroupPrompts({ group1: g1, group2: g2Name });
            setTimeout(renderAllFavoritesPanels, 60);
          });
          g2Fav.addEventListener('click', async (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            toggleFavoriteGroup2(g2Key);
            await saveConfig();
            renderAllFavoritesPanels();
            debounceApply('unfav-sub-group2', 0);
          });
          children.appendChild(g2Row);

          const g2Children = makeChildrenContainer(g2Expanded);
          for (const it of g2Items) renderChildItem(it, g2Children, 'toggle-fav-item-in-sub-g2');
          if (g2Items.length > 0) children.appendChild(g2Children);
        }
      } else {
        for (const it of allInG1) {
          renderChildItem(it, children, 'toggle-fav-item-in-group1');
        }
      }

      if (allInG1.length > 0) body.appendChild(children);
    }

    // 2) 二级组
    for (const key of effectiveGroup2) {
      const { group1, group2 } = splitGroup2Key(key);
      const expanded = isFavoritesGroup2Expanded(key);
      const { row, exp, btnToggle, btnUnfav } = makeGroupRow({ titleText: `\u3010${group1}\u3011 ${group2}`, expanded });

      const toggleExpand = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        setFavoritesGroup2Expanded(key, !isFavoritesGroup2Expanded(key));
        await saveConfig();
        renderAllFavoritesPanels();
      };

      exp.addEventListener('click', toggleExpand);
      row.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.closest('.pmg-fav-toggle') || t.closest('.pmg-fav-unfav') || t.closest('.pmg-fav-expand')) return;
        toggleExpand(e);
      });

      btnToggle.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!config.secondLevelEnabled) toggleGroupPrompts({ group1 });
        else toggleGroupPrompts({ group1, group2 });
        setTimeout(renderAllFavoritesPanels, 60);
      });

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteGroup2(key);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply('unfav-group2', 0);
      });

      body.appendChild(row);

      const children = makeChildrenContainer(expanded);
      const childItems = snapshot.filter((x) => {
        if (!x.hasPrefix || x.group1 !== group1) return false;
        if (!x.group2 || x.group2 !== group2) return false;
        return true;
      });

      for (const it of childItems) renderChildItem(it, children, 'toggle-fav-item-in-group2');

      if (childItems.length > 0) body.appendChild(children);
    }

    // 3) 单独条目
    const favGroup1Set2 = new Set(favGroup1);
    const effectiveGroup2Set2 = new Set(effectiveGroup2);
    const coveredFavItems = new Set();
    for (const x of snapshot) {
      if (!new Set(favItems).has(x.identifier)) continue;
      if (!x.hasPrefix) continue;
      if (x.group1 && favGroup1Set2.has(x.group1)) { coveredFavItems.add(x.identifier); continue; }
      if (x.group1 && x.group2 && effectiveGroup2Set2.has(group2Key(x.group1, x.group2))) { coveredFavItems.add(x.identifier); continue; }
    }

    for (const id of favItems) {
      if (coveredFavItems.has(id)) continue;
      const found = snapshot.find((x) => x.identifier === id);
      const titleText = found ? getDisplayName(found) : id;
      const { row, btnToggle, btnUnfav } = makeRow(titleText);

      if (found) {
        const on = isPromptEnabled(found.li);
        btnToggle.classList.toggle('fa-toggle-on', on);
        btnToggle.classList.toggle('fa-toggle-off', !on);
      } else {
        btnToggle.classList.add('fa-toggle-off');
        btnToggle.classList.remove('fa-toggle-on');
      }

      btnToggle.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleItemPromptByIdentifier(id);
        setTimeout(renderAllFavoritesPanels, 60);
      });

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteItem(id);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply('unfav-item', 0);
      });

      body.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Inline Favorites panel (inside prompt manager)
  // ---------------------------------------------------------------------------

  function ensureInlineFavoritesPanel() {
    const pm = getPromptManagerContainer();
    if (!pm) return null;

    let holder = pm.querySelector('#pmg-favorites-holder');
    if (holder) return holder;

    const listEl = findPromptManagerList();
    if (!listEl) return null;

    holder = document.createElement('div');
    holder.id = 'pmg-favorites-holder';
    holder.className = 'pmg-favorites-holder';

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer pmg-fav-drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header pmg-fav-header';
    header.innerHTML = `<b>\u2B50 收藏</b><div class="inline-drawer-icon fa-solid ${config.favoritesPanelExpanded ? 'fa-circle-chevron-up up' : 'fa-circle-chevron-down down'}"></div>`;

    const content = document.createElement('div');
    content.className = 'inline-drawer-content pmg-fav-content';
    content.style.display = config.favoritesPanelExpanded ? 'block' : 'none';

    const body = document.createElement('div');
    body.className = 'pmg-fav-body';
    content.appendChild(body);

    drawer.appendChild(header);
    drawer.appendChild(content);
    holder.appendChild(drawer);

    listEl.parentElement?.insertBefore(holder, listEl);

    const toggleDrawer = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      config.favoritesPanelExpanded = !config.favoritesPanelExpanded;
      const icon = header.querySelector('.inline-drawer-icon');
      if (config.favoritesPanelExpanded) {
        content.style.display = 'block';
        icon?.classList.remove('fa-circle-chevron-down', 'down');
        icon?.classList.add('fa-circle-chevron-up', 'up');
      } else {
        content.style.display = 'none';
        icon?.classList.remove('fa-circle-chevron-up', 'up');
        icon?.classList.add('fa-circle-chevron-down', 'down');
      }
      await saveConfig();
    };

    header.addEventListener('click', toggleDrawer);
    return holder;
  }

  function removeInlineFavoritesPanel() {
    const pm = getPromptManagerContainer();
    if (!pm) return;
    const holder = pm.querySelector('#pmg-favorites-holder');
    if (holder) holder.remove();
  }

  function renderInlineFavoritesPanel() {
    if (!config.favoritesEnabled || !config.favoritesPanelEnabled) {
      removeInlineFavoritesPanel();
      return;
    }
    const holder = ensureInlineFavoritesPanel();
    if (!holder) return;
    const body = holder.querySelector('.pmg-fav-body');
    if (!body) return;
    renderFavoritesContent(body);
  }

  // ---------------------------------------------------------------------------
  // Floating Favorites panel (independent, always accessible)
  // ---------------------------------------------------------------------------

  /**
   * 通用拖拽工具：让一个 fixed 元素可通过指定 handle 拖拽
   * 支持鼠标和触摸，带 click vs drag 区分
   *
   * @param {HTMLElement} el - 要移动的 fixed 元素
   * @param {HTMLElement} handle - 拖拽手柄（鼠标按下的区域）
   * @param {object} opts
   * @param {number}  [opts.threshold=5] - 拖拽阈值（px），小于此值视为点击
   * @param {(pos:{left:number,top:number})=>void} [opts.onDragEnd] - 拖拽结束回调
   * @param {(e:PointerEvent)=>boolean} [opts.shouldIgnore] - 是否忽略此次 pointerdown
   */
  function installDrag(el, handle, opts = {}) {
    const threshold = opts.threshold ?? 5;
    const onDragEnd = opts.onDragEnd;
    const shouldIgnore = opts.shouldIgnore;

    let dragging = false;
    let didDrag = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;

    const onPointerDown = (e) => {
      // 忽略右键
      if (e.button && e.button !== 0) return;
      // 如果点击了不该拖拽的子元素（如按钮），跳过
      if (shouldIgnore && shouldIgnore(e)) return;

      dragging = true;
      didDrag = false;
      startX = e.clientX;
      startY = e.clientY;

      // 读取当前 computed position
      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;

      el.classList.add('pmg-floating-dragging');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!didDrag && Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
      didDrag = true;

      let newLeft = origLeft + dx;
      let newTop = origTop + dy;

      // 限制在视口内
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      newLeft = Math.max(0, Math.min(vw - w, newLeft));
      newTop = Math.max(0, Math.min(vh - h, newTop));

      // 清除 CSS 的 right/bottom，改用 left/top
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('pmg-floating-dragging');

      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

      if (didDrag) {
        // 保存最终位置
        const rect = el.getBoundingClientRect();
        const pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        if (onDragEnd) onDragEnd(pos);
      }
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    // 返回 didDrag 查询函数，供外部区分 click vs drag
    return {
      /** 在 click handler 中调用以判断刚才是否是拖拽（是则应跳过 click 逻辑） */
      wasDrag() {
        return didDrag;
      },
    };
  }

  /**
   * 将保存的位置应用到 fixed 元素上
   */
  function applyFloatingPos(el, pos) {
    if (!el || !pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 44;
    const h = el.offsetHeight || 44;
    const left = Math.max(0, Math.min(vw - w, pos.left));
    const top = Math.max(0, Math.min(vh - h, pos.top));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  let floatingPanelEl = null;
  let floatingToggleBtn = null;

  function createFloatingPanel() {
    if (floatingPanelEl) return;

    const panel = document.createElement('div');
    panel.id = 'pmg-floating-panel';
    panel.className = 'pmg-floating-panel';
    if (!config.floatingPanelExpanded) panel.classList.add('pmg-floating-collapsed');

    const header = document.createElement('div');
    header.className = 'pmg-floating-header';
    header.innerHTML = '<span class="pmg-floating-title">\u2B50 收藏快捷栏</span>';

    const closeBtn = document.createElement('span');
    closeBtn.className = 'pmg-floating-close fa-solid fa-xmark interactable';
    closeBtn.title = '收起';
    closeBtn.tabIndex = 0;
    closeBtn.setAttribute('role', 'button');
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'pmg-floating-content';

    const body = document.createElement('div');
    body.className = 'pmg-floating-body pmg-fav-body';
    content.appendChild(body);

    panel.appendChild(header);
    panel.appendChild(content);

    const toggleBtn = document.createElement('div');
    toggleBtn.id = 'pmg-floating-toggle';
    toggleBtn.className = 'pmg-floating-toggle interactable';
    toggleBtn.innerHTML = '<i class="fa-solid fa-star"></i>';
    toggleBtn.title = '收藏快捷栏';
    toggleBtn.tabIndex = 0;
    toggleBtn.setAttribute('role', 'button');

    // 安装拖拽 - 星形按钮
    const toggleDrag = installDrag(toggleBtn, toggleBtn, {
      threshold: 6,
      onDragEnd: async (pos) => {
        config.floatingTogglePos = pos;
        await saveConfig();
      },
    });

    const togglePanel = async () => {
      config.floatingPanelExpanded = !config.floatingPanelExpanded;
      panel.classList.toggle('pmg-floating-collapsed', !config.floatingPanelExpanded);
      toggleBtn.classList.toggle('pmg-floating-toggle-active', config.floatingPanelExpanded);
      if (config.floatingPanelExpanded) renderFloatingFavoritesPanel();
      await saveConfig();
    };

    // 点击星形按钮：仅在非拖拽时 toggle
    toggleBtn.addEventListener('click', (e) => {
      if (toggleDrag.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    // 安装拖拽 - 面板（通过 header 拖拽）
    installDrag(panel, header, {
      threshold: 5,
      shouldIgnore: (e) => {
        // 不拦截关闭按钮的点击
        const t = e.target;
        return t instanceof HTMLElement && !!t.closest('.pmg-floating-close');
      },
      onDragEnd: async (pos) => {
        config.floatingPanelPos = pos;
        await saveConfig();
      },
    });

    document.body.appendChild(panel);
    document.body.appendChild(toggleBtn);

    floatingPanelEl = panel;
    floatingToggleBtn = toggleBtn;

    // 恢复保存的位置
    if (config.floatingTogglePos) applyFloatingPos(toggleBtn, config.floatingTogglePos);
    if (config.floatingPanelPos) applyFloatingPos(panel, config.floatingPanelPos);

    if (config.floatingPanelExpanded) {
      toggleBtn.classList.add('pmg-floating-toggle-active');
    }
  }

  function removeFloatingPanel() {
    if (floatingPanelEl) { floatingPanelEl.remove(); floatingPanelEl = null; }
    if (floatingToggleBtn) { floatingToggleBtn.remove(); floatingToggleBtn = null; }
  }

  function renderFloatingFavoritesPanel() {
    if (!floatingPanelEl || !config.floatingPanelExpanded) return;
    const body = floatingPanelEl.querySelector('.pmg-floating-body');
    if (!body) return;
    renderFavoritesContent(body);
  }

  function updateFloatingPanelVisibility() {
    if (config.favoritesEnabled && config.floatingPanelEnabled) {
      if (!floatingPanelEl) createFloatingPanel();
      if (floatingToggleBtn) floatingToggleBtn.style.display = '';
      if (floatingPanelEl) floatingPanelEl.classList.toggle('pmg-floating-collapsed', !config.floatingPanelExpanded);
    } else {
      removeFloatingPanel();
    }
  }

  // ---------------------------------------------------------------------------
  // Render all favorites panels
  // ---------------------------------------------------------------------------

  function renderAllFavoritesPanels() {
    renderInlineFavoritesPanel();
    renderFloatingFavoritesPanel();
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  async function registerSettingsPanel() {
    const ST_API = getSTApi();
    if (!ST_API?.ui?.registerSettingsPanel) {
      warn('ST_API.ui.registerSettingsPanel not available');
      return;
    }

    const panelId = `${PLUGIN_NS}.settings`;

    try {
      await ST_API.ui.unregisterSettingsPanel({ id: panelId });
    } catch { /* ignore */ }

    await ST_API.ui.registerSettingsPanel({
      id: panelId,
      title: 'Prompt Manager 分组/收藏',
      target: 'right',
      expanded: false,
      order: 50,
      content: {
        kind: 'render',
        render: (container) => {
          container.innerHTML = `
<div class="pmg-settings">
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_grouping_enabled">
      <span>启用分组（启用后将禁用原生拖拽）</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_second_level">
      <span>启用二级分组</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_hide_prefix">
      <span>分组时隐藏前缀（仅显示，不修改原名称）</span>
    </label>
  </div>
  <hr>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_favorites_enabled">
      <span>启用收藏（提示词条目右侧显示\u2B50）</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_favorites_panel">
      <span>显示"内联收藏栏"（预设面板内）</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_floating_panel">
      <span>显示"浮动收藏快捷栏"（不需打开预设面板即可使用）</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_favorites_expand_default">
      <span>收藏栏：分组默认展开</span>
    </label>
  </div>
  <div class="pmg-settings-row">
    <label class="checkbox_label">
      <input type="checkbox" id="pmg_block_refresh">
      <span>预设条目开关时阻止预设面板刷新</span>
    </label>
  </div>
  <div class="pmg-settings-row flex-container gap10px">
    <div class="menu_button" id="pmg_btn_apply">立即刷新列表</div>
    <div class="menu_button caution" id="pmg_btn_clear_fav">清空所有收藏</div>
  </div>
  <div class="pmg-settings-hint">
    <small>
      <b>命名示例：</b><br>
      1）<code>\u3010常用\u3011阡濯自制</code> \u2192 一级组：<code>常用</code><br>
      2）<code>文生图-测试1</code> \u2192 一级组：<code>文生图</code><br>
      3）<code>文生图-\u3010常用\u3011测试2</code> \u2192 组：<code>文生图 / 常用</code><br>
      4）<code>\u3010文生图\u3011常用-测试3</code> \u2192 组：<code>文生图 / 常用</code><br>
    </small>
  </div>
</div>
          `.trim();

          const $ = (sel) => container.querySelector(sel);
          const elGrouping = $('#pmg_grouping_enabled');
          const elSecond = $('#pmg_second_level');
          const elHide = $('#pmg_hide_prefix');
          const elFav = $('#pmg_favorites_enabled');
          const elFavPanel = $('#pmg_favorites_panel');
          const elFloatingPanel = $('#pmg_floating_panel');
          const elBlockRefresh = $('#pmg_block_refresh');
          const elFavExpandDefault = $('#pmg_favorites_expand_default');
          const btnApply = $('#pmg_btn_apply');
          const btnClear = $('#pmg_btn_clear_fav');

          const syncToUI = () => {
            if (elGrouping) elGrouping.checked = !!config.groupingEnabled;
            if (elSecond) elSecond.checked = !!config.secondLevelEnabled;
            if (elHide) elHide.checked = !!config.hidePrefixes;
            if (elFav) elFav.checked = !!config.favoritesEnabled;
            if (elFavPanel) elFavPanel.checked = !!config.favoritesPanelEnabled;
            if (elFloatingPanel) elFloatingPanel.checked = !!config.floatingPanelEnabled;
            if (elBlockRefresh) elBlockRefresh.checked = !!config.blockPresetUiRefreshOnToggle;
            if (elFavExpandDefault) elFavExpandDefault.checked = !!config.favoritesExpandGroupsByDefault;
            if (elSecond) elSecond.disabled = !config.groupingEnabled;
            if (elHide) elHide.disabled = !config.groupingEnabled;
          };

          const onChange = async () => {
            config.groupingEnabled = !!elGrouping?.checked;
            config.secondLevelEnabled = !!elSecond?.checked;
            config.hidePrefixes = !!elHide?.checked;
            config.favoritesEnabled = !!elFav?.checked;
            config.favoritesPanelEnabled = !!elFavPanel?.checked;
            config.floatingPanelEnabled = !!elFloatingPanel?.checked;
            config.blockPresetUiRefreshOnToggle = !!elBlockRefresh?.checked;
            config.favoritesExpandGroupsByDefault = !!elFavExpandDefault?.checked;

            if (config.blockPresetUiRefreshOnToggle) installRenderPatch();
            else uninstallRenderPatch();

            updateFloatingPanelVisibility();
            syncToUI();
            await saveConfig();
            debounceApply('settings-changed', 0);
          };

          elGrouping?.addEventListener('change', onChange);
          elSecond?.addEventListener('change', onChange);
          elHide?.addEventListener('change', onChange);
          elFav?.addEventListener('change', onChange);
          elFavPanel?.addEventListener('change', onChange);
          elFloatingPanel?.addEventListener('change', onChange);
          elBlockRefresh?.addEventListener('change', onChange);
          elFavExpandDefault?.addEventListener('change', onChange);

          btnApply?.addEventListener('click', () => debounceApply('manual-apply', 0));
          btnClear?.addEventListener('click', async () => {
            config.favorites = { group1: [], group2: [], items: [] };
            await saveConfig();
            debounceApply('clear-fav', 0);
          });

          syncToUI();
          return () => { };
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------

  function attachToList(listEl) {
    currentListEl = listEl;

    listEl.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.closest('.prompt-manager-toggle-action')) {
          if (config.blockPresetUiRefreshOnToggle) activateRenderFreeze();
          setTimeout(renderAllFavoritesPanels, 80);
        }
      },
      true
    );

    listObserver?.disconnect();
    listObserver = new MutationObserver((mutations) => {
      if (applying) return;
      let shouldApply = false;
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (m.attributeName === 'data-pm-name') { shouldApply = true; break; }
          continue;
        }
        if (m.type !== 'childList') continue;
        if (m.target !== listEl) continue;
        const nodes = [...m.addedNodes, ...m.removedNodes].filter((n) => n instanceof HTMLElement);
        if (nodes.length === 0) continue;
        const headerOnly = nodes.every((n) => n.classList.contains('pmg-group-header'));
        if (headerOnly) continue;
        shouldApply = true;
        break;
      }
      if (shouldApply) debounceApply('list-mutation', 60);
    });

    listObserver.observe(listEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pm-name'],
    });

    debounceApply('attach', 0);
  }

  function detachFromList() {
    if (renderPatchState?.installed) {
      renderPatchState.freezeActive = false;
      renderPatchState.pendingDryRun = false;
    }
    listObserver?.disconnect();
    listObserver = null;
    currentListEl = null;
  }

  function startBodyObserver() {
    bodyObserver?.disconnect();
    bodyObserver = new MutationObserver(() => {
      const list = findPromptManagerList();
      if (list && list !== currentListEl) attachToList(list);
      else if (!list && currentListEl) detachFromList();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    const list = findPromptManagerList();
    if (list) attachToList(list);
  }

  // ---------------------------------------------------------------------------
  // Apply all
  // ---------------------------------------------------------------------------

  function applyAll(reason) {
    if (applying) return;
    applying = true;
    try {
      const list = findPromptManagerList();
      if (list && list !== currentListEl) attachToList(list);

      if (!currentListEl) {
        applying = false;
        renderFloatingFavoritesPanel();
        return;
      }

      applyGrouping();
      renderAllFavoritesPanels();
    } catch (e) {
      warn('applyAll failed:', e);
    } finally {
      applying = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    try {
      await waitFor(() => {
        const hasApi = !!getSTApi();
        const hasCtx = !!window.SillyTavern?.getContext?.();
        return hasApi && hasCtx;
      }, 20000, 150);
    } catch {
      if (!getSTApi()) {
        warn('window.ST_API not found. 请先安装并启用 st-api-wrapper。');
      } else {
        warn('SillyTavern context not ready. 插件初始化被跳过。');
      }
      return;
    }

    await loadConfig();

    if (config.blockPresetUiRefreshOnToggle) {
      try { await installRenderPatch(); } catch { /* ignore */ }
    }

    try { await registerSettingsPanel(); } catch (e) { warn('registerSettingsPanel failed:', e); }

    updateFloatingPanelVisibility();
    startBodyObserver();
    debounceApply('init', 0);

    log('Initialized');
  }

  init();
})();
