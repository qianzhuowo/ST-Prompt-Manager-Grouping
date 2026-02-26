/*
 * Prompt Manager Grouping (PMG)
 *
 * 一个用于管理 SillyTavern Prompt Manager 列表（#completion_prompt_manager_list）的前端扩展：
 * - 基于名称前缀（【】/ - / 自定义包裹 / 自定义分隔符）进行 1~2 级分组
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

  /** @type {string|null} 当前激活的预设名称（用于按预设隔离收藏） */
  let activePresetName = null;

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
      // 先刷新当前预设名称（用于按预设隔离收藏），再应用 UI
      void applyAllWithPresetCheck(reason);
    }, delayMs);
  }

  function createDefaultConfig() {
    return {
      version: 5,

      // 分组
      groupingEnabled: true,
      secondLevelEnabled: true,
      hidePrefixes: true,

      // 前缀解析规则
      prefixBracketEnabled: true,
      // 初次使用默认关闭（见需求）：避免 '-' 误触发分组
      prefixDashEnabled: false,
      // 其余解析规则默认开启
      prefixCustomWrapperEnabled: true,
      prefixCustomWrapperLeft: '「',
      prefixCustomWrapperRight: '」',
      prefixCustomSeparatorEnabled: true,
      prefixCustomSeparator: '=',

      // 快捷收藏栏（浮动收藏快捷栏）的按钮位置
      // - floating: 悬浮自由位置（可拖拽）
      // - qr: 放到 QR 栏（.qr--buttons）
      // - send: 放到发送按钮旁（#rightSendForm.alignContentCenter）
      // 初次使用默认：发送按钮旁
      quickFavoritesButtonPlacement: 'send',

      // 快捷收藏栏按钮在“嵌入模式”(qr/send)下的插入位置（0-based）。
      // 说明：嵌入到容器后，若用户（或其他插件）对按钮顺序做了拖拽排序，
      // 通过 MutationObserver 记录当前位置并保存；下次启动会按该 index 插入。
      // { qr: number|null, send: number|null }
      quickFavoritesEmbeddedIndexByPlacement: { qr: null, send: null },

      // 收藏
      favoritesEnabled: true,
      // 初次使用默认关闭（见需求）
      favoritesPanelEnabled: false,
      favoritesPanelExpanded: true,

      // 浮动收藏快捷栏（独立于预设面板）
      floatingPanelEnabled: true,
      floatingPanelExpanded: false,

      // 浮动元素位置（null = 使用默认 CSS 位置；拖拽后保存，兼容：
      // - 旧格式：{ left, top }
      // - 新格式：{ left, top, relX, relY }（相对位置，窗口缩放后更稳定）
      floatingTogglePos: null,
      floatingPanelPos: null,

      // 收藏栏里"组"项是否默认展开
      // 初次使用默认关闭（见需求）
      favoritesExpandGroupsByDefault: false,

      // 收藏栏里各组的展开状态（legacy：v1）
      favoritesExpanded: { group1: [], group2: [] },

      // 收藏栏里各组的展开状态（按预设隔离：v2）
      favoritesExpandedByPreset: {},

      // 防刷新：通过 render 补丁跳过 dry-run
      // 其余默认开启
      blockPresetUiRefreshOnToggle: true,

      // 收藏数据（legacy：v1）
      favorites: { group1: [], group2: [], items: [] },

      // 收藏数据（按预设隔离：v2）
      favoritesByPreset: {},

      // v1 -> v2 迁移标记：避免每次切换预设都重复把 legacy 收藏灌进来
      legacyFavoritesMigrated: false,

      // 折叠状态
      collapsed: {
        group1: [],
        group2: [],
      },

      // 折叠状态（按预设隔离：v3）
      collapsedByPreset: {},

      // collapsed v1 -> v3 迁移标记
      legacyCollapsedMigrated: false,

      // 设置页折叠栏展开状态（记忆上次状态）
      // { [drawerKey: string]: boolean }
      settingsDrawerExpanded: {},
    };
  }

  function mergeConfig(base, incoming) {
    const out = safeJsonClone(base);
    if (!incoming || typeof incoming !== 'object') return out;

    // 兼容旧配置：如果没有 version 字段，视为 v1（避免直接把 legacy 收藏“吞掉”）
    if (!('version' in incoming)) {
      out.version = 1;
    }

    const keys = [
      'version',
      'groupingEnabled',
      'secondLevelEnabled',
      'hidePrefixes',
      'prefixBracketEnabled',
      'prefixDashEnabled',
      'prefixCustomWrapperEnabled',
      'prefixCustomWrapperLeft',
      'prefixCustomWrapperRight',
      'prefixCustomSeparatorEnabled',
      'prefixCustomSeparator',
      'quickFavoritesButtonPlacement',
      'quickFavoritesEmbeddedIndexByPlacement',
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
      'favoritesByPreset',
      'legacyFavoritesMigrated',
      'favoritesExpanded',
      'favoritesExpandedByPreset',
      'collapsed',
      'collapsedByPreset',
      'legacyCollapsedMigrated',
      'settingsDrawerExpanded',
    ];

    for (const k of keys) {
      if (k in incoming) out[k] = incoming[k];
    }

    out.favorites = {
      group1: Array.isArray(out.favorites?.group1) ? out.favorites.group1 : [],
      group2: Array.isArray(out.favorites?.group2) ? out.favorites.group2 : [],
      items: Array.isArray(out.favorites?.items) ? out.favorites.items : [],
    };

    // favoritesByPreset: { [presetName]: { group1: string[], group2: string[], items: string[] } }
    if (!out.favoritesByPreset || typeof out.favoritesByPreset !== 'object') out.favoritesByPreset = {};
    for (const [k, v] of Object.entries(out.favoritesByPreset)) {
      if (!v || typeof v !== 'object') { out.favoritesByPreset[k] = { group1: [], group2: [], items: [] }; continue; }
      out.favoritesByPreset[k] = {
        group1: Array.isArray(v.group1) ? v.group1 : [],
        group2: Array.isArray(v.group2) ? v.group2 : [],
        items: Array.isArray(v.items) ? v.items : [],
      };
    }

    out.collapsed = {
      group1: Array.isArray(out.collapsed?.group1) ? out.collapsed.group1 : [],
      group2: Array.isArray(out.collapsed?.group2) ? out.collapsed.group2 : [],
    };

    if (!out.collapsedByPreset || typeof out.collapsedByPreset !== 'object') out.collapsedByPreset = {};
    for (const [k, v] of Object.entries(out.collapsedByPreset)) {
      if (!v || typeof v !== 'object') { out.collapsedByPreset[k] = { group1: [], group2: [] }; continue; }
      out.collapsedByPreset[k] = {
        group1: Array.isArray(v.group1) ? v.group1 : [],
        group2: Array.isArray(v.group2) ? v.group2 : [],
      };
    }

    out.favoritesExpanded = {
      group1: Array.isArray(out.favoritesExpanded?.group1) ? out.favoritesExpanded.group1 : [],
      group2: Array.isArray(out.favoritesExpanded?.group2) ? out.favoritesExpanded.group2 : [],
    };

    if (!out.favoritesExpandedByPreset || typeof out.favoritesExpandedByPreset !== 'object') out.favoritesExpandedByPreset = {};
    for (const [k, v] of Object.entries(out.favoritesExpandedByPreset)) {
      if (!v || typeof v !== 'object') { out.favoritesExpandedByPreset[k] = { group1: [], group2: [] }; continue; }
      out.favoritesExpandedByPreset[k] = {
        group1: Array.isArray(v.group1) ? v.group1 : [],
        group2: Array.isArray(v.group2) ? v.group2 : [],
      };
    }

    if (!out.settingsDrawerExpanded || typeof out.settingsDrawerExpanded !== 'object' || Array.isArray(out.settingsDrawerExpanded)) {
      out.settingsDrawerExpanded = {};
    }

    // 嵌入模式下的按钮顺序记忆
    if (
      !out.quickFavoritesEmbeddedIndexByPlacement ||
      typeof out.quickFavoritesEmbeddedIndexByPlacement !== 'object' ||
      Array.isArray(out.quickFavoritesEmbeddedIndexByPlacement)
    ) {
      out.quickFavoritesEmbeddedIndexByPlacement = { qr: null, send: null };
    }
    for (const k of ['qr', 'send']) {
      const v = out.quickFavoritesEmbeddedIndexByPlacement[k];
      const n = typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : NaN;
      out.quickFavoritesEmbeddedIndexByPlacement[k] = Number.isInteger(n) && n >= 0 ? n : null;
    }

    return out;
  }

  function isFavoritesGroup1Expanded(group1) {
    const set = new Set(getScopedFavoritesExpanded().group1 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    return defaultExpanded ? !set.has(group1) : set.has(group1);
  }

  function isFavoritesGroup2Expanded(key) {
    const set = new Set(getScopedFavoritesExpanded().group2 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    return defaultExpanded ? !set.has(key) : set.has(key);
  }

  function setFavoritesGroup1Expanded(group1, expanded) {
    const store = getScopedFavoritesExpanded();
    const set = new Set(store.group1 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    if (defaultExpanded) {
      if (expanded) set.delete(group1);
      else set.add(group1);
    } else {
      if (expanded) set.add(group1);
      else set.delete(group1);
    }
    store.group1 = Array.from(set);
  }

  function setFavoritesGroup2Expanded(key, expanded) {
    const store = getScopedFavoritesExpanded();
    const set = new Set(store.group2 || []);
    const defaultExpanded = !!config.favoritesExpandGroupsByDefault;
    if (defaultExpanded) {
      if (expanded) set.delete(key);
      else set.add(key);
    } else {
      if (expanded) set.add(key);
      else set.delete(key);
    }
    store.group2 = Array.from(set);
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

  // ---------------------------------------------------------------------------
  // Preset-aware favorites scope
  // ---------------------------------------------------------------------------

  let presetNameFetchInFlight = null;
  let lastPresetNameFetchAt = 0;

  async function refreshActivePresetName(force = false) {
    const ST_API = getSTApi();
    if (!ST_API?.preset?.get) return activePresetName;

    const now = Date.now();
    if (!force) {
      if (presetNameFetchInFlight) return presetNameFetchInFlight;
      if (now - lastPresetNameFetchAt < 400) return activePresetName;
    }

    lastPresetNameFetchAt = now;
    presetNameFetchInFlight = (async () => {
      try {
        const res = await ST_API.preset.get();
        const name = res?.preset?.name;
        if (typeof name === 'string' && name.trim()) {
          const prev = activePresetName;
          activePresetName = name.trim();
          if (prev !== activePresetName) {
            // 尝试将 v1 的“全局收藏”迁移到当前预设名下
            void maybeMigrateLegacyFavorites();
            void maybeMigrateLegacyCollapsed();
          }
        }
      } catch {
        // ignore
      }
      return activePresetName;
    })();

    try {
      return await presetNameFetchInFlight;
    } finally {
      presetNameFetchInFlight = null;
    }
  }

  function ensureFavoritesStoreShape(store) {
    if (!store || typeof store !== 'object') return { group1: [], group2: [], items: [] };
    return {
      group1: Array.isArray(store.group1) ? store.group1 : [],
      group2: Array.isArray(store.group2) ? store.group2 : [],
      items: Array.isArray(store.items) ? store.items : [],
    };
  }

  function ensureFavoritesExpandedShape(store) {
    if (!store || typeof store !== 'object') return { group1: [], group2: [] };
    return {
      group1: Array.isArray(store.group1) ? store.group1 : [],
      group2: Array.isArray(store.group2) ? store.group2 : [],
    };
  }

  function ensureCollapsedShape(store) {
    if (!store || typeof store !== 'object') return { group1: [], group2: [] };
    return {
      group1: Array.isArray(store.group1) ? store.group1 : [],
      group2: Array.isArray(store.group2) ? store.group2 : [],
    };
  }

  function getScopedFavoritesStore() {
    if (activePresetName) {
      config.favoritesByPreset = config.favoritesByPreset && typeof config.favoritesByPreset === 'object'
        ? config.favoritesByPreset
        : {};
      if (!config.favoritesByPreset[activePresetName]) {
        config.favoritesByPreset[activePresetName] = { group1: [], group2: [], items: [] };
      }
      // 保证 shape
      config.favoritesByPreset[activePresetName] = ensureFavoritesStoreShape(config.favoritesByPreset[activePresetName]);
      return config.favoritesByPreset[activePresetName];
    }
    config.favorites = ensureFavoritesStoreShape(config.favorites);
    return config.favorites;
  }

  function getScopedFavoritesExpanded() {
    if (activePresetName) {
      config.favoritesExpandedByPreset =
        config.favoritesExpandedByPreset && typeof config.favoritesExpandedByPreset === 'object'
          ? config.favoritesExpandedByPreset
          : {};
      if (!config.favoritesExpandedByPreset[activePresetName]) {
        config.favoritesExpandedByPreset[activePresetName] = { group1: [], group2: [] };
      }
      config.favoritesExpandedByPreset[activePresetName] =
        ensureFavoritesExpandedShape(config.favoritesExpandedByPreset[activePresetName]);
      return config.favoritesExpandedByPreset[activePresetName];
    }
    config.favoritesExpanded = ensureFavoritesExpandedShape(config.favoritesExpanded);
    return config.favoritesExpanded;
  }

  function getScopedCollapsedStore() {
    if (activePresetName) {
      config.collapsedByPreset = config.collapsedByPreset && typeof config.collapsedByPreset === 'object'
        ? config.collapsedByPreset
        : {};
      if (!config.collapsedByPreset[activePresetName]) {
        config.collapsedByPreset[activePresetName] = { group1: [], group2: [] };
      }
      config.collapsedByPreset[activePresetName] = ensureCollapsedShape(config.collapsedByPreset[activePresetName]);
      return config.collapsedByPreset[activePresetName];
    }
    config.collapsed = ensureCollapsedShape(config.collapsed);
    return config.collapsed;
  }

  async function maybeMigrateLegacyCollapsed() {
    if (!activePresetName) return;
    if (config.legacyCollapsedMigrated) return;

    config.collapsedByPreset = config.collapsedByPreset && typeof config.collapsedByPreset === 'object'
      ? config.collapsedByPreset
      : {};

    const legacy = ensureCollapsedShape(config.collapsed);
    const cur = ensureCollapsedShape(config.collapsedByPreset[activePresetName]);
    const curIsEmpty = (cur.group1.length + cur.group2.length) === 0;
    if (curIsEmpty && (legacy.group1.length + legacy.group2.length) > 0) {
      config.collapsedByPreset[activePresetName] = safeJsonClone(legacy);
    }

    config.legacyCollapsedMigrated = true;
    await saveConfig();
  }

  async function maybeMigrateLegacyFavorites() {
    if (!activePresetName) return;
    // 不在此处强制升级版本号：因为我们同时支持 v1 legacy（全局）和 v2（按预设）。
    // 迁移只做一次“尽量复制”，不破坏旧数据。
    if (config.legacyFavoritesMigrated) return;

    config.favoritesByPreset = config.favoritesByPreset && typeof config.favoritesByPreset === 'object'
      ? config.favoritesByPreset
      : {};
    config.favoritesExpandedByPreset =
      config.favoritesExpandedByPreset && typeof config.favoritesExpandedByPreset === 'object'
        ? config.favoritesExpandedByPreset
        : {};

    const legacyFav = ensureFavoritesStoreShape(config.favorites);
    const legacyExp = ensureFavoritesExpandedShape(config.favoritesExpanded);

    const cur = ensureFavoritesStoreShape(config.favoritesByPreset[activePresetName]);
    const curIsEmpty = (cur.group1.length + cur.group2.length + cur.items.length) === 0;
    if (curIsEmpty && (legacyFav.group1.length + legacyFav.group2.length + legacyFav.items.length) > 0) {
      config.favoritesByPreset[activePresetName] = safeJsonClone(legacyFav);
    }

    const curExp = ensureFavoritesExpandedShape(config.favoritesExpandedByPreset[activePresetName]);
    const curExpIsEmpty = (curExp.group1.length + curExp.group2.length) === 0;
    if (curExpIsEmpty && (legacyExp.group1.length + legacyExp.group2.length) > 0) {
      config.favoritesExpandedByPreset[activePresetName] = safeJsonClone(legacyExp);
    }

    config.legacyFavoritesMigrated = true;
    await saveConfig();
  }

  // ---------------------------------------------------------------------------
  // Group instance IDs (avoid same-name groups being linked)
  // ---------------------------------------------------------------------------

  function buildGroup1Id(group1Name, occ) {
    return `${String(group1Name)}#${String(occ)}`;
  }

  function splitGroup1Id(id) {
    const s = String(id ?? '');
    const i = s.lastIndexOf('#');
    if (i > 0) {
      const maybeNum = s.slice(i + 1);
      if (/^\d+$/.test(maybeNum)) {
        return { group1: s.slice(0, i), occ: Number(maybeNum) };
      }
    }
    return { group1: s, occ: null };
  }

  function buildGroup2Id(group1Id, group2Name, occ) {
    return `${String(group1Id)}|||${String(group2Name)}#${String(occ)}`;
  }

  function splitGroup2Id(id) {
    const s = String(id ?? '');
    const idx = s.indexOf('|||');
    if (idx < 0) {
      return { group1Id: s, group1: splitGroup1Id(s).group1, group2: '', occ: null };
    }
    const group1Id = s.slice(0, idx);
    const right = s.slice(idx + 3);
    const i = right.lastIndexOf('#');
    if (i > 0) {
      const maybeNum = right.slice(i + 1);
      if (/^\d+$/.test(maybeNum)) {
        return {
          group1Id,
          group1: splitGroup1Id(group1Id).group1,
          group2: right.slice(0, i),
          occ: Number(maybeNum),
        };
      }
    }
    return {
      group1Id,
      group1: splitGroup1Id(group1Id).group1,
      group2: right,
      occ: null,
    };
  }

  function setCollapsedGroup1(group1, collapsed) {
    const store = getScopedCollapsedStore();
    const set = new Set(store.group1);
    if (collapsed) set.add(group1);
    else set.delete(group1);
    store.group1 = Array.from(set);
  }

  function setCollapsedGroup2(key, collapsed) {
    const store = getScopedCollapsedStore();
    const set = new Set(store.group2);
    if (collapsed) set.add(key);
    else set.delete(key);
    store.group2 = Array.from(set);
  }

  function isGroup1Collapsed(group1) {
    const store = getScopedCollapsedStore();
    return new Set(store.group1).has(group1);
  }

  function isGroup2Collapsed(key) {
    const store = getScopedCollapsedStore();
    return new Set(store.group2).has(key);
  }

  // legacy alias for collapse keys (group2Id is now used, but collapse still uses string keys)
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

  function isGroup1Favorited(group1Id) {
    const store = getScopedFavoritesStore();
    return new Set(store.group1).has(String(group1Id));
  }

  function isGroup2Favorited(group2Id) {
    const store = getScopedFavoritesStore();
    return new Set(store.group2).has(String(group2Id));
  }

  function isItemFavorited(identifier) {
    const store = getScopedFavoritesStore();
    return new Set(store.items).has(String(identifier));
  }

  function toggleFavoriteGroup1(group1Id) {
    const store = getScopedFavoritesStore();
    const set = new Set(store.group1);
    const key = String(group1Id);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    store.group1 = Array.from(set);
  }

  function toggleFavoriteGroup2(group2Id) {
    const store = getScopedFavoritesStore();
    const set = new Set(store.group2);
    const key = String(group2Id);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    store.group2 = Array.from(set);
  }

  function toggleFavoriteItem(identifier) {
    const store = getScopedFavoritesStore();
    const set = new Set(store.items);
    const key = String(identifier);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    store.items = Array.from(set);
  }

  async function loadConfig() {
    const ST_API = getSTApi();
    // variables.get 不可用时仍尝试 localStorage 兜底（至少保证浮动面板/按钮位置可记忆）

    let loaded = null;

    if (ST_API?.variables?.get) {
      try {
        const res = await ST_API.variables.get({ name: CONFIG_VAR_NAME, scope: 'global' });
        loaded = res?.value;
      } catch (e) {
        warn('Config load failed (variables.get):', e);
        loaded = null;
      }
    }

    try {
      // SillyTavern 变量系统可能将值存为字符串，需要反序列化
      if (typeof loaded === 'string') {
        try { loaded = JSON.parse(loaded); } catch {
          warn('Config value is not valid JSON, using defaults');
          loaded = null;
        }
      }

      config = mergeConfig(createDefaultConfig(), loaded);

      // legacy
      config.favorites.group1 = ensureArrayUnique(config.favorites.group1);
      config.favorites.group2 = ensureArrayUnique(config.favorites.group2);
      config.favorites.items = ensureArrayUnique(config.favorites.items);

      // per-preset
      config.favoritesByPreset = config.favoritesByPreset && typeof config.favoritesByPreset === 'object' ? config.favoritesByPreset : {};
      for (const [pn, store] of Object.entries(config.favoritesByPreset)) {
        const s = ensureFavoritesStoreShape(store);
        s.group1 = ensureArrayUnique(s.group1);
        s.group2 = ensureArrayUnique(s.group2);
        s.items = ensureArrayUnique(s.items);
        config.favoritesByPreset[pn] = s;
      }

      // legacy collapsed
      config.collapsed.group1 = ensureArrayUnique(config.collapsed.group1);
      config.collapsed.group2 = ensureArrayUnique(config.collapsed.group2);

      // per-preset collapsed
      config.collapsedByPreset = config.collapsedByPreset && typeof config.collapsedByPreset === 'object' ? config.collapsedByPreset : {};
      for (const [pn, st] of Object.entries(config.collapsedByPreset)) {
        const s = ensureCollapsedShape(st);
        s.group1 = ensureArrayUnique(s.group1);
        s.group2 = ensureArrayUnique(s.group2);
        config.collapsedByPreset[pn] = s;
      }
      config.favoritesExpanded = config.favoritesExpanded || { group1: [], group2: [] };
      config.favoritesExpanded.group1 = ensureArrayUnique(config.favoritesExpanded.group1);
      config.favoritesExpanded.group2 = ensureArrayUnique(config.favoritesExpanded.group2);

      config.favoritesExpandedByPreset =
        config.favoritesExpandedByPreset && typeof config.favoritesExpandedByPreset === 'object'
          ? config.favoritesExpandedByPreset
          : {};
      for (const [pn, st] of Object.entries(config.favoritesExpandedByPreset)) {
        const s = ensureFavoritesExpandedShape(st);
        s.group1 = ensureArrayUnique(s.group1);
        s.group2 = ensureArrayUnique(s.group2);
        config.favoritesExpandedByPreset[pn] = s;
      }

      log('Config loaded:', config);

      // localStorage 兜底：浮动按钮/面板位置 & 嵌入模式顺序
      restoreQuickFavoritesPosFromLocalStorageIfNeeded();
      restoreQuickFavoritesEmbeddedIndexFromLocalStorageIfNeeded();

      // 尝试补一次迁移（如果已能拿到预设名）
      try { await refreshActivePresetName(false); } catch { /* ignore */ }
    } catch (e) {
      warn('Config load failed, using defaults:', e);
      config = createDefaultConfig();

      // localStorage 兜底：即使整体配置加载失败，也尽量恢复“拖拽位置”
      restoreQuickFavoritesPosFromLocalStorageIfNeeded();
      restoreQuickFavoritesEmbeddedIndexFromLocalStorageIfNeeded();
    }
  }

  async function saveConfig() {
    const ST_API = getSTApi();

    // 无论 variables.set 是否可用，都写一份 localStorage 兜底（主要解决“拖拽位置不记忆”）
    persistQuickFavoritesPosToLocalStorage();
    persistQuickFavoritesEmbeddedIndexToLocalStorage();

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

  // ---------------------------------------------------------------------------
  // Name parsing rules (customizable)
  // ---------------------------------------------------------------------------

  const BUILTIN_WRAPPER_BRACKET_V2 = { open: '【', close: '】' };
  const BUILTIN_DASH_SEPARATORS_V2 = ['-', '－'];

  function decodeUnicodeEscapes(input) {
    let s = String(input ?? '');
    // \u{1F600}
    s = s.replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return m; }
    });
    // \u300C
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return m; }
    });
    return s;
  }

  function parseSeparatorList(input) {
    if (Array.isArray(input)) {
      return input.map((x) => decodeUnicodeEscapes(String(x)).trim()).filter(Boolean);
    }
    const s = decodeUnicodeEscapes(String(input ?? '')).trim();
    if (!s) return [];
    return s
      .split(/[,，;；]+/g)
      .map((x) => decodeUnicodeEscapes(x).trim())
      .filter(Boolean);
  }

  function uniqueStrings(arr) {
    const out = [];
    const seen = new Set();
    for (const v of (arr || [])) {
      const s = String(v ?? '');
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function buildPrefixParseRules() {
    const wrappers = [];
    if (config?.prefixBracketEnabled) wrappers.push(BUILTIN_WRAPPER_BRACKET_V2);

    if (config?.prefixCustomWrapperEnabled) {
      const open = decodeUnicodeEscapes(String(config.prefixCustomWrapperLeft ?? '')).trim();
      const close = decodeUnicodeEscapes(String(config.prefixCustomWrapperRight ?? '')).trim();
      if (open && close) wrappers.push({ open, close });
    }

    const seps = [];
    if (config?.prefixDashEnabled) seps.push(...BUILTIN_DASH_SEPARATORS_V2);
    if (config?.prefixCustomSeparatorEnabled) seps.push(...parseSeparatorList(config.prefixCustomSeparator));

    // de-dup wrappers/seps (keep order)
    const wrapperKeys = new Set();
    const uniqWrappers = [];
    for (const w of wrappers) {
      const open = String(w?.open ?? '');
      const close = String(w?.close ?? '');
      if (!open || !close) continue;
      const key = `${open}\u0000${close}`;
      if (wrapperKeys.has(key)) continue;
      wrapperKeys.add(key);
      uniqWrappers.push({ open, close });
    }

    return { wrappers: uniqWrappers, seps: uniqueStrings(seps) };
  }

  function matchWrappedPrefix(s, open, close) {
    const str = String(s ?? '');
    const o = String(open ?? '');
    const c = String(close ?? '');
    if (!o || !c) return null;
    if (!str.startsWith(o)) return null;
    const endIdx = str.indexOf(c, o.length);
    if (endIdx < 0) return null;
    const value = str.slice(o.length, endIdx).trim();
    if (!value) return null;
    const rest = str.slice(endIdx + c.length).replace(/^\s+/, '');
    return { value, rest };
  }

  function matchAnyWrappedPrefix(s, wrappers) {
    for (const w of wrappers || []) {
      const m = matchWrappedPrefix(s, w.open, w.close);
      if (m) return m;
    }
    return null;
  }

  function splitBySeparators(s, seps) {
    const str = String(s ?? '');
    const list = Array.isArray(seps) ? seps : [];
    let bestIdx = -1;
    let bestSep = '';

    for (const sep of list) {
      const d = String(sep ?? '');
      if (!d) continue;
      const idx = str.indexOf(d);
      if (idx <= 0) continue;
      if (bestIdx < 0 || idx < bestIdx || (idx === bestIdx && d.length > bestSep.length)) {
        bestIdx = idx;
        bestSep = d;
      }
    }
    if (bestIdx < 0) return null;

    const left = str.slice(0, bestIdx).trim();
    if (!left) return null;
    const right = str.slice(bestIdx + bestSep.length).trimStart();
    return { left, right, sep: bestSep };
  }

  // Override legacy parsePromptName (adds custom rules + enable/disable)
  function parsePromptName(name, enableSecondLevel, rules) {
    let rest = String(name ?? '');
    const original = rest;

    const r = rules || buildPrefixParseRules();
    const wrappers = Array.isArray(r?.wrappers) ? r.wrappers : [];
    const seps = Array.isArray(r?.seps) ? r.seps : [];

    let group1;
    let group2;

    // level 1
    const w1 = matchAnyWrappedPrefix(rest, wrappers);
    if (w1) {
      group1 = w1.value;
      rest = w1.rest;
    } else {
      const d1 = splitBySeparators(rest, seps);
      if (d1) {
        group1 = d1.left;
        rest = d1.right;
      }
    }

    // level 2
    if (enableSecondLevel && group1) {
      const r2 = String(rest).trimStart();
      const w2 = matchAnyWrappedPrefix(r2, wrappers);
      if (w2) {
        group2 = w2.value;
        rest = w2.rest;
      } else {
        const d2 = splitBySeparators(r2, seps);
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
      delete li.dataset.pmgGroupId;
      delete li.dataset.pmgGroup2Id;
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
  // Prompt Manager toolbar (insert between footer and list)
  // ---------------------------------------------------------------------------

  /** @type {HTMLElement|null} */
  let promptManagerToolbarEl = null;

  /** @type {HTMLElement|null} */
  let standaloneSettingsModalEl = null;

  /** @type {HTMLElement|null} */
  let prefixEditorModalEl = null;

  function cssEscapeCompat(s) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(String(s));
      }
    } catch {
      // ignore
    }
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function ensurePromptManagerToolbar(listEl) {
    const list = listEl || findPromptManagerList();
    const pm = getPromptManagerContainer();
    if (!pm || !list) return;

    let bar = pm.querySelector('#pmg-prompt-manager-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'pmg-prompt-manager-toolbar';
      bar.className = 'pmg-pm-toolbar flex-container gap10px';

      const btnSettings = document.createElement('div');
      btnSettings.className = 'menu_button';
      btnSettings.textContent = 'PMG 设置';
      btnSettings.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPmgStandaloneSettings();
      });

      const btnPrefix = document.createElement('div');
      btnPrefix.className = 'menu_button';
      btnPrefix.textContent = '快速编辑前缀';
      btnPrefix.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openPmgPrefixEditor();
      });

      bar.appendChild(btnSettings);
      bar.appendChild(btnPrefix);
      promptManagerToolbarEl = bar;
    } else {
      promptManagerToolbarEl = bar;
    }

    // 插入位置：footer 与 list 之间
    const footer = pm.querySelector('.completion_prompt_manager_footer');
    if (footer && footer.parentElement === pm) {
      if (footer.nextElementSibling !== bar) {
        footer.insertAdjacentElement('afterend', bar);
      }
    } else {
      if (list.previousElementSibling !== bar) {
        list.insertAdjacentElement('beforebegin', bar);
      }
    }
  }

  function ensureModalBase(id) {
    const existing = document.getElementById(id);
    if (existing instanceof HTMLElement) return existing;

    const el = document.createElement('div');
    el.id = id;
    el.className = 'pmg-modal pmg-hidden';

    const backdrop = document.createElement('div');
    backdrop.className = 'pmg-modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'pmg-modal-dialog';

    const header = document.createElement('div');
    header.className = 'pmg-modal-header';

    const title = document.createElement('div');
    title.className = 'pmg-modal-title';

    const close = document.createElement('span');
    close.className = 'pmg-modal-close fa-solid fa-xmark interactable';
    close.tabIndex = 0;
    close.setAttribute('role', 'button');
    close.title = '关闭';

    const body = document.createElement('div');
    body.className = 'pmg-modal-body';

    header.appendChild(title);
    header.appendChild(close);
    dialog.appendChild(header);
    dialog.appendChild(body);

    el.appendChild(backdrop);
    el.appendChild(dialog);
    document.body.appendChild(el);

    const hide = () => hideModal(el);
    backdrop.addEventListener('click', hide);
    close.addEventListener('click', hide);
    close.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') hide();
    });

    // Esc
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!el.classList.contains('pmg-hidden')) hide();
    });

    return el;
  }

  function getModalBody(el) {
    if (!(el instanceof HTMLElement)) return null;
    const b = el.querySelector('.pmg-modal-body');
    return b instanceof HTMLElement ? b : null;
  }

  function showModal(el, titleText) {
    if (!(el instanceof HTMLElement)) return;
    const title = el.querySelector('.pmg-modal-title');
    if (title) title.textContent = titleText || '';
    el.classList.remove('pmg-hidden');

    const close = el.querySelector('.pmg-modal-close');
    if (close instanceof HTMLElement) setTimeout(() => close.focus(), 0);
  }

  function hideModal(el) {
    if (!(el instanceof HTMLElement)) return;
    el.classList.add('pmg-hidden');
  }

  function openPmgStandaloneSettings() {
    standaloneSettingsModalEl = ensureModalBase('pmg-standalone-settings-modal');
    const body = getModalBody(standaloneSettingsModalEl);
    if (body) {
      renderSettingsUI(body);
    }
    showModal(standaloneSettingsModalEl, 'Prompt Manager Grouping 设置');
  }

  // ---------------------------------------------------------------------------
  // Prefix quick editor
  // ---------------------------------------------------------------------------

  function buildPrefixParseRulesAll() {
    const wrappers = [BUILTIN_WRAPPER_BRACKET_V2];

    const open = decodeUnicodeEscapes(String(config.prefixCustomWrapperLeft ?? '')).trim();
    const close = decodeUnicodeEscapes(String(config.prefixCustomWrapperRight ?? '')).trim();
    if (open && close) wrappers.push({ open, close });

    const seps = [...BUILTIN_DASH_SEPARATORS_V2, ...parseSeparatorList(config.prefixCustomSeparator)];

    // de-dup wrappers
    const wrapperKeys = new Set();
    const uniqWrappers = [];
    for (const w of wrappers) {
      const key = `${String(w.open)}\u0000${String(w.close)}`;
      if (wrapperKeys.has(key)) continue;
      wrapperKeys.add(key);
      uniqWrappers.push(w);
    }

    return {
      wrappers: uniqWrappers,
      seps: uniqueStrings(seps),
    };
  }

  function getDefaultCustomSeparator() {
    const list = parseSeparatorList(config.prefixCustomSeparator);
    if (Array.isArray(list) && list.length > 0) return list[0];
    return '=';
  }

  function buildNameWithPrefix({ leaf, group1, group2, format1, format2, customSep1, customSep2 }) {
    const l = String(leaf ?? '').trimStart();
    const g1 = String(group1 ?? '').trim();
    const g2 = String(group2 ?? '').trim();
    const f1 = String(format1 || 'bracket');
    const f2 = String(format2 || 'bracket');

    const applyOne = (prefixValue, restText, fmt, sepValue) => {
      const pv = String(prefixValue ?? '').trim();
      const rest = String(restText ?? '').trimStart();
      if (!pv) return rest;

      if (fmt === 'dash') {
        return `${pv}-${rest}`;
      }

      if (fmt === 'customSeparator') {
        const sep = String(sepValue ?? '').trim() || '=';
        return `${pv}${sep}${rest}`;
      }

      if (fmt === 'customWrapper') {
        const open = decodeUnicodeEscapes(String(config.prefixCustomWrapperLeft ?? '')) || '「';
        const close = decodeUnicodeEscapes(String(config.prefixCustomWrapperRight ?? '')) || '」';
        return `${open}${pv}${close}${rest}`;
      }

      // default: bracket
      return `【${pv}】${rest}`;
    };

    // group1 为空：视为清除前缀（忽略 group2）
    if (!g1) return l;

    const rest2 = g2 ? applyOne(g2, l, f2, customSep2) : l;
    return applyOne(g1, rest2, f1, customSep1);
  }

  function collectPromptItemsForPrefixEditor() {
    const listEl = findPromptManagerList();
    if (!listEl) return [];

    const rulesAll = buildPrefixParseRulesAll();

    const items = Array.from(listEl.querySelectorAll('li.completion_prompt_manager_prompt'));
    return items
      .map((li) => {
        const identifier = getPromptIdentifier(li);
        const name = getCanonicalPromptName(li);
        const parsed = parsePromptName(name, true, rulesAll);
        return {
          li,
          identifier,
          name,
          group1: parsed.group1,
          group2: parsed.group2,
          leaf: parsed.leaf || name,
          hasPrefix: parsed.hasPrefix,
        };
      })
      .filter((x) => x.identifier && x.name);
  }

  async function openPmgPrefixEditor() {
    try {
      await refreshActivePresetName(false);
    } catch {
      // ignore
    }

    prefixEditorModalEl = ensureModalBase('pmg-prefix-editor-modal');
    const body = getModalBody(prefixEditorModalEl);
    if (!body) return;

    const presetLabel = activePresetName ? `（${activePresetName}）` : '';
    showModal(prefixEditorModalEl, `快速编辑预设条目前缀${presetLabel}`);
    renderPrefixEditorUI(body);
  }

  function renderPrefixEditorUI(container) {
    const items = collectPromptItemsForPrefixEditor();
    const customSepDefault = getDefaultCustomSeparator();

    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'pmg-prefix-editor';

    const controls = document.createElement('div');
    controls.className = 'pmg-prefix-editor-controls';

    controls.innerHTML = `
      <div class="pmg-prefix-editor-row flex-container gap10px pmg-pe-inputs-row" style="align-items:center; flex-wrap:wrap;">
        <input type="text" class="text_pole" data-pmg-pe="group1" placeholder="一级前缀（留空=清除前缀）" style="flex: 1; min-width: 160px;">
        <input type="text" class="text_pole" data-pmg-pe="group2" placeholder="二级前缀（可选）" style="flex: 1; min-width: 160px;">
      </div>
      <div class="pmg-prefix-editor-row flex-container gap10px pmg-pe-formats-row" style="align-items:center; flex-wrap:wrap;">
        <div class="pmg-pe-format-cell" style="flex: 1; min-width: 160px; display:flex; gap: 10px; align-items:center; flex-wrap:wrap;">
          <select class="text_pole" data-pmg-pe="format1" style="flex: 1; min-width: 150px;">
            <option value="bracket">【】包裹</option>
            <option value="dash">- 分割</option>
            <option value="customWrapper">自定义包裹</option>
            <option value="customSeparator">自定义分隔符</option>
          </select>
          <input type="text" class="text_pole" data-pmg-pe="wrapLeft1" placeholder="左" style="width: 60px; display:none;">
          <input type="text" class="text_pole" data-pmg-pe="wrapRight1" placeholder="右" style="width: 60px; display:none;">
          <input type="text" class="text_pole" data-pmg-pe="customSep1" placeholder="一级分隔符" style="width: 90px; display:none;">
        </div>
        <div class="pmg-pe-format-cell" style="flex: 1; min-width: 160px; display:flex; gap: 10px; align-items:center; flex-wrap:wrap;">
          <select class="text_pole" data-pmg-pe="format2" style="flex: 1; min-width: 150px;">
            <option value="bracket">【】包裹</option>
            <option value="dash">- 分割</option>
            <option value="customWrapper">自定义包裹</option>
            <option value="customSeparator">自定义分隔符</option>
          </select>
          <input type="text" class="text_pole" data-pmg-pe="wrapLeft2" placeholder="左" style="width: 60px; display:none;">
          <input type="text" class="text_pole" data-pmg-pe="wrapRight2" placeholder="右" style="width: 60px; display:none;">
          <input type="text" class="text_pole" data-pmg-pe="customSep2" placeholder="二级分隔符" style="width: 90px; display:none;">
        </div>
      </div>
      <div class="pmg-prefix-editor-row flex-container gap10px" style="align-items:center; flex-wrap:wrap;">
        <div class="menu_button" data-pmg-pe="btn-apply">应用到选中</div>
        <div class="menu_button caution" data-pmg-pe="btn-clear">清除选中前缀</div>
        <div class="menu_button" data-pmg-pe="btn-select-all">全选</div>
        <div class="menu_button" data-pmg-pe="btn-select-none">全不选</div>
        <div class="menu_button" data-pmg-pe="btn-invert">反选</div>
      </div>
      <div class="pmg-prefix-editor-status" data-pmg-pe="status"></div>
    `.trim();

    const list = document.createElement('div');
    list.className = 'pmg-prefix-editor-list';

    const renderPrefixEditorCurrent = (subEl, info) => {
      if (!(subEl instanceof HTMLElement)) return;

      const g1 = String(info?.group1 ?? '').trim();
      const g2 = String(info?.group2 ?? '').trim();
      const leafRaw = String(info?.leaf ?? '').trimStart();
      const leaf = leafRaw || String(info?.name ?? '').trimStart();

      subEl.innerHTML = '';

      const label = document.createElement('span');
      label.className = 'pmg-pe-label';
      label.textContent = '当前： ';
      subEl.appendChild(label);

      if (!g1) {
        const np = document.createElement('span');
        np.className = 'pmg-pe-no-prefix';
        np.textContent = '无前缀';
        subEl.appendChild(np);
        return;
      }

      const arrow = () => {
        const a = document.createElement('span');
        a.className = 'pmg-pe-arrow';
        a.textContent = ' → ';
        return a;
      };

      const elG1 = document.createElement('span');
      elG1.className = 'pmg-pe-g1';
      elG1.textContent = g1;
      subEl.appendChild(elG1);

      if (g2) {
        subEl.appendChild(arrow());
        const elG2 = document.createElement('span');
        elG2.className = 'pmg-pe-g2';
        elG2.textContent = g2;
        subEl.appendChild(elG2);
      }

      subEl.appendChild(arrow());
      const elLeaf = document.createElement('span');
      elLeaf.className = 'pmg-pe-leaf';
      elLeaf.textContent = leaf;
      subEl.appendChild(elLeaf);
    };

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmg-prefix-editor-empty';
      empty.textContent = '未找到可编辑的预设条目（请先打开 Prompt Manager 列表）';
      list.appendChild(empty);
    } else {
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'pmg-prefix-editor-item';
        row.dataset.pmgId = it.identifier;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-pmg-pe', 'sel');
        cb.value = it.identifier;

        const title = document.createElement('div');
        title.className = 'pmg-prefix-editor-item-title';
        title.textContent = it.name;

        const sub = document.createElement('div');
        sub.className = 'pmg-prefix-editor-item-sub';
        renderPrefixEditorCurrent(sub, it);

        const textWrap = document.createElement('div');
        textWrap.className = 'pmg-prefix-editor-item-text';
        textWrap.appendChild(title);
        textWrap.appendChild(sub);

        row.appendChild(cb);
        row.appendChild(textWrap);

        row.addEventListener('click', (e) => {
          const t = e.target;
          if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.closest('input'))) return;
          cb.checked = !cb.checked;
        });

        list.appendChild(row);
      }
    }

    wrapper.appendChild(controls);
    wrapper.appendChild(list);
    container.appendChild(wrapper);

    const elGroup1 = controls.querySelector('[data-pmg-pe="group1"]');
    const elGroup2 = controls.querySelector('[data-pmg-pe="group2"]');
    const elFormat1 = controls.querySelector('[data-pmg-pe="format1"]');
    const elFormat2 = controls.querySelector('[data-pmg-pe="format2"]');
    const elWrapLeft1 = controls.querySelector('[data-pmg-pe="wrapLeft1"]');
    const elWrapRight1 = controls.querySelector('[data-pmg-pe="wrapRight1"]');
    const elWrapLeft2 = controls.querySelector('[data-pmg-pe="wrapLeft2"]');
    const elWrapRight2 = controls.querySelector('[data-pmg-pe="wrapRight2"]');
    const elCustomSep1 = controls.querySelector('[data-pmg-pe="customSep1"]');
    const elCustomSep2 = controls.querySelector('[data-pmg-pe="customSep2"]');
    const status = controls.querySelector('[data-pmg-pe="status"]');

    if (elCustomSep1 instanceof HTMLInputElement) elCustomSep1.value = customSepDefault;
    if (elCustomSep2 instanceof HTMLInputElement) elCustomSep2.value = customSepDefault;
    if (elWrapLeft1 instanceof HTMLInputElement) elWrapLeft1.value = String(config.prefixCustomWrapperLeft ?? '');
    if (elWrapRight1 instanceof HTMLInputElement) elWrapRight1.value = String(config.prefixCustomWrapperRight ?? '');
    if (elWrapLeft2 instanceof HTMLInputElement) elWrapLeft2.value = String(config.prefixCustomWrapperLeft ?? '');
    if (elWrapRight2 instanceof HTMLInputElement) elWrapRight2.value = String(config.prefixCustomWrapperRight ?? '');

    const setStatus = (msg) => {
      if (status) status.textContent = msg || '';
    };

    const updateExtraInputsVisibility = () => {
      if (elFormat1 instanceof HTMLSelectElement) {
        const v1 = elFormat1.value;
        if (elCustomSep1 instanceof HTMLInputElement) elCustomSep1.style.display = v1 === 'customSeparator' ? '' : 'none';
        if (elWrapLeft1 instanceof HTMLInputElement) elWrapLeft1.style.display = v1 === 'customWrapper' ? '' : 'none';
        if (elWrapRight1 instanceof HTMLInputElement) elWrapRight1.style.display = v1 === 'customWrapper' ? '' : 'none';
      }
      if (elFormat2 instanceof HTMLSelectElement) {
        const v2 = elFormat2.value;
        if (elCustomSep2 instanceof HTMLInputElement) elCustomSep2.style.display = v2 === 'customSeparator' ? '' : 'none';
        if (elWrapLeft2 instanceof HTMLInputElement) elWrapLeft2.style.display = v2 === 'customWrapper' ? '' : 'none';
        if (elWrapRight2 instanceof HTMLInputElement) elWrapRight2.style.display = v2 === 'customWrapper' ? '' : 'none';
      }
    };

    if (elFormat1 instanceof HTMLSelectElement) elFormat1.addEventListener('change', updateExtraInputsVisibility);
    if (elFormat2 instanceof HTMLSelectElement) elFormat2.addEventListener('change', updateExtraInputsVisibility);
    updateExtraInputsVisibility();

    const getSelected = () =>
      Array.from(container.querySelectorAll('input[data-pmg-pe="sel"]:checked'))
        .filter((x) => x instanceof HTMLInputElement)
        .map((x) => x.value);

    const setAll = (checked) => {
      for (const cb of Array.from(container.querySelectorAll('input[data-pmg-pe="sel"]'))) {
        if (cb instanceof HTMLInputElement) cb.checked = checked;
      }
    };

    const invert = () => {
      for (const cb of Array.from(container.querySelectorAll('input[data-pmg-pe="sel"]'))) {
        if (cb instanceof HTMLInputElement) cb.checked = !cb.checked;
      }
    };

    const btnApply = controls.querySelector('[data-pmg-pe="btn-apply"]');
    const btnClear = controls.querySelector('[data-pmg-pe="btn-clear"]');
    const btnAll = controls.querySelector('[data-pmg-pe="btn-select-all"]');
    const btnNone = controls.querySelector('[data-pmg-pe="btn-select-none"]');
    const btnInv = controls.querySelector('[data-pmg-pe="btn-invert"]');

    btnAll?.addEventListener('click', () => setAll(true));
    btnNone?.addEventListener('click', () => setAll(false));
    btnInv?.addEventListener('click', () => invert());

    const apply = async (mode) => {
      const ids = getSelected();
      if (ids.length === 0) {
        setStatus('未选择任何条目');
        return;
      }

      const g1 = elGroup1 instanceof HTMLInputElement ? elGroup1.value.trim() : '';
      const g2 = elGroup2 instanceof HTMLInputElement ? elGroup2.value.trim() : '';
      const format1 = elFormat1 instanceof HTMLSelectElement ? elFormat1.value : 'bracket';
      const format2 = elFormat2 instanceof HTMLSelectElement ? elFormat2.value : format1;
      const customSep1 = elCustomSep1 instanceof HTMLInputElement ? elCustomSep1.value.trim() : customSepDefault;
      const customSep2 = elCustomSep2 instanceof HTMLInputElement ? elCustomSep2.value.trim() : customSep1;
      const wrapLeft1 = elWrapLeft1 instanceof HTMLInputElement ? elWrapLeft1.value.trim() : '';
      const wrapRight1 = elWrapRight1 instanceof HTMLInputElement ? elWrapRight1.value.trim() : '';
      const wrapLeft2 = elWrapLeft2 instanceof HTMLInputElement ? elWrapLeft2.value.trim() : '';
      const wrapRight2 = elWrapRight2 instanceof HTMLInputElement ? elWrapRight2.value.trim() : '';

      // 预览/编辑自定义包裹时，同时同步两级的输入框显示（避免两边不一致导致困惑）
      if (format1 === 'customWrapper' || format2 === 'customWrapper') {
        const wl = (format1 === 'customWrapper' ? wrapLeft1 : '') || (format2 === 'customWrapper' ? wrapLeft2 : '') || String(config.prefixCustomWrapperLeft ?? '');
        const wr = (format1 === 'customWrapper' ? wrapRight1 : '') || (format2 === 'customWrapper' ? wrapRight2 : '') || String(config.prefixCustomWrapperRight ?? '');
        if (elWrapLeft1 instanceof HTMLInputElement && wl) elWrapLeft1.value = wl;
        if (elWrapRight1 instanceof HTMLInputElement && wr) elWrapRight1.value = wr;
        if (elWrapLeft2 instanceof HTMLInputElement && wl) elWrapLeft2.value = wl;
        if (elWrapRight2 instanceof HTMLInputElement && wr) elWrapRight2.value = wr;
      }

      const itemMap = new Map(items.map((x) => [x.identifier, x]));
      /** @type {Map<string, string>} */
      const updates = new Map();

      const getLeafForRename = (it) => {
        const leaf = String(it?.leaf ?? '').trimStart();
        if (leaf) return leaf;
        const g2 = String(it?.group2 ?? '').trim();
        if (g2) return g2;
        const g1n = String(it?.group1 ?? '').trim();
        if (g1n) return g1n;
        return String(it?.name ?? '').trimStart();
      };

      for (const id of ids) {
        const it = itemMap.get(id);
        if (!it) continue;

        const leaf = getLeafForRename(it);
        const newName =
          mode === 'clear'
            ? String(leaf).trimStart()
            : buildNameWithPrefix({ leaf, group1: g1, group2: g2, format1, format2, customSep1, customSep2 });
        updates.set(id, newName);
      }

      if (updates.size === 0) {
        setStatus('没有可更新的条目');
        return;
      }

      if (!confirm(`将修改 ${updates.size} 个条目的名称（前缀），是否继续？`)) return;

      // 若用户在快速编辑中使用了自定义包裹/分隔符：自动同步到 PMG 配置，确保分组解析能识别。
      let shouldSaveCfg = false;
      if (format1 === 'customWrapper' || format2 === 'customWrapper') {
        const wl = (format1 === 'customWrapper' ? wrapLeft1 : wrapLeft2) || (format2 === 'customWrapper' ? wrapLeft2 : wrapLeft1) || String(config.prefixCustomWrapperLeft ?? '');
        const wr = (format1 === 'customWrapper' ? wrapRight1 : wrapRight2) || (format2 === 'customWrapper' ? wrapRight2 : wrapRight1) || String(config.prefixCustomWrapperRight ?? '');
        if (wl && wr) {
          if (config.prefixCustomWrapperLeft !== wl) { config.prefixCustomWrapperLeft = wl; shouldSaveCfg = true; }
          if (config.prefixCustomWrapperRight !== wr) { config.prefixCustomWrapperRight = wr; shouldSaveCfg = true; }
        }
        if (!config.prefixCustomWrapperEnabled) { config.prefixCustomWrapperEnabled = true; shouldSaveCfg = true; }
      }

      if (format1 === 'customSeparator' || format2 === 'customSeparator') {
        const seps = [];
        if (format1 === 'customSeparator' && customSep1) seps.push(customSep1);
        if (format2 === 'customSeparator' && customSep2) seps.push(customSep2);
        const curList = parseSeparatorList(config.prefixCustomSeparator);
        const set = new Set(curList);
        let changed = false;
        for (const s of seps) {
          if (!set.has(s)) { set.add(s); changed = true; }
        }
        if (changed) {
          config.prefixCustomSeparator = Array.from(set).join(',');
          shouldSaveCfg = true;
        }
        if (!config.prefixCustomSeparatorEnabled) { config.prefixCustomSeparatorEnabled = true; shouldSaveCfg = true; }
      }

      if (shouldSaveCfg) {
        await saveConfig();
      }

      setStatus('处理中...');

      try {
        await applyBatchPromptRename(updates);
        updatePromptManagerDomNames(updates);
        debounceApply('prefix-editor-applied', 0);
        setTimeout(renderAllFavoritesPanels, 80);

        // 更新 editor 列表的显示（不重渲染，保留勾选状态）
        const rulesAll = buildPrefixParseRulesAll();
        for (const [id, newName] of updates.entries()) {
          const row = list.querySelector(`.pmg-prefix-editor-item[data-pmg-id="${cssEscapeCompat(id)}"]`);
          if (!(row instanceof HTMLElement)) continue;
          const titleEl = row.querySelector('.pmg-prefix-editor-item-title');
          if (titleEl) titleEl.textContent = String(newName);
          const subEl = row.querySelector('.pmg-prefix-editor-item-sub');
          if (subEl instanceof HTMLElement) {
            const parsed = parsePromptName(String(newName), true, rulesAll);
            const leafNow = parsed.leaf || String(newName);
            renderPrefixEditorCurrent(subEl, {
              group1: parsed.group1,
              group2: parsed.group2,
              leaf: leafNow,
              name: String(newName),
            });
          }
        }

        setStatus(`完成：已更新 ${updates.size} 项`);
      } catch (e) {
        warn('Prefix editor apply failed:', e);
        setStatus(`失败：${String(e?.message || e)}`);
      }
    };

    btnApply?.addEventListener('click', () => void apply('apply'));
    btnClear?.addEventListener('click', () => void apply('clear'));
  }

  async function applyBatchPromptRename(updatesMap) {
    const updates = updatesMap instanceof Map ? updatesMap : new Map(Object.entries(updatesMap || {}));
    if (updates.size === 0) return;

    const ctx = window.SillyTavern?.getContext?.();
    if (!ctx) throw new Error('SillyTavern context not ready');

    // 直接修改“当前 in-use 预设”的原始 settings，避免整体替换 prompts 导致的数据丢失。
    const presetManager = ctx.getPresetManager?.('openai');
    if (!presetManager) throw new Error('Preset manager not found');

    const getName = presetManager.getSelectedPresetName;
    if (typeof getName !== 'function') throw new Error('Preset manager getSelectedPresetName not found');
    const presetName = getName.call(presetManager);
    if (!presetName) throw new Error('Active preset name not found');

    const save = presetManager.savePreset;
    if (typeof save !== 'function') throw new Error('Preset manager savePreset not found');

    const settings = ctx.chatCompletionSettings;
    if (!settings || typeof settings !== 'object') throw new Error('chatCompletionSettings not found');

    if (!Array.isArray(settings.prompts) || settings.prompts.length === 0) {
      throw new Error('Active preset prompts is empty/unavailable; abort to prevent wiping data');
    }

    let changed = 0;
    for (const p of settings.prompts) {
      if (!p || typeof p !== 'object') continue;
      const pid = p.identifier ?? p.id ?? p.pmIdentifier ?? p.uuid;
      if (pid === undefined || pid === null) continue;
      const key = String(pid);
      if (!updates.has(key)) continue;
      p.name = String(updates.get(key) ?? '');
      changed++;
    }

    if (changed === 0) {
      throw new Error('No matched prompts found in current preset');
    }

    // 保存：使用可序列化的副本，避免引用/原型污染
    const toSave = JSON.parse(JSON.stringify(settings));
    await save.call(presetManager, presetName, toSave);
  }

  function updatePromptManagerDomNames(updatesMap) {
    const updates = updatesMap instanceof Map ? updatesMap : new Map(Object.entries(updatesMap || {}));
    const list = findPromptManagerList();
    if (!list) return;

    for (const [id, newName] of updates.entries()) {
      const li = list.querySelector(`[data-pm-identifier="${cssEscapeCompat(id)}"]`);
      if (!(li instanceof HTMLElement)) continue;

      const nameSpan = li.querySelector('.completion_prompt_manager_prompt_name');
      if (nameSpan instanceof HTMLElement) {
        nameSpan.dataset.pmName = String(newName);
        nameSpan.setAttribute('data-pm-name', String(newName));
      }

      const a = getPromptNameAnchor(li);
      if (a) {
        a.dataset.pmgOriginalName = String(newName);
        a.dataset.pmgOriginalTitle = String(newName);
        a.title = String(newName);
        a.textContent = String(newName);
      }
    }
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

  function createGroupHeaderLi({ level, group1, group2, groupId, group2Id, displayTitle }) {
    const li = document.createElement('li');
    li.className = `pmg-group-header pmg-level${level}`;
    li.dataset.pmgLevel = String(level);
    li.dataset.pmgGroup1 = String(group1);
    if (group2) li.dataset.pmgGroup2 = String(group2);
    if (groupId) li.dataset.pmgGroupId = String(groupId);
    if (group2Id) li.dataset.pmgGroup2Id = String(group2Id);

    const row = document.createElement('div');
    row.className = 'pmg-group-header-row';

    const arrow = document.createElement('span');
    arrow.className = 'pmg-collapse-icon fa-solid fa-chevron-down';

    const title = document.createElement('span');
    title.className = 'pmg-group-title';
    title.textContent =
      typeof displayTitle === 'string' && displayTitle.trim()
        ? displayTitle
        : (level === 1 ? String(group1) : String(group2));

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
        const collapseKey = groupId || String(group1);
        const collapsed = isGroup1Collapsed(collapseKey);
        arrow.classList.toggle('fa-chevron-right', collapsed);
        arrow.classList.toggle('fa-chevron-down', !collapsed);
        if (fav) {
          const favOn = isGroup1Favorited(String(groupId || group1));
          fav.classList.toggle('pmg-fav-on', favOn);
          fav.classList.toggle('pmg-fav-off', !favOn);
          fav.title = favOn ? '取消收藏一级分组' : '收藏一级分组';
        }
      } else {
        const key = String(li.dataset.pmgGroup2Id || group2Id || buildGroup2Id(String(groupId || group1), String(group2), 0));
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
        const g1 = groupId || String(group1);
        setCollapsedGroup1(g1, !isGroup1Collapsed(g1));
      } else {
        const key = String(li.dataset.pmgGroup2Id || group2Id || buildGroup2Id(String(groupId || group1), String(group2), 0));
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
        toggleFavoriteGroup1(String(groupId || group1));
      } else {
        const key = String(li.dataset.pmgGroup2Id || group2Id || buildGroup2Id(String(groupId || group1), String(group2), 0));
        toggleFavoriteGroup2(key);
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

    const group1OccCount = {};
    const group2OccCount = {};
    let currentGroupId = null;

    const prefixRules = buildPrefixParseRules();

    for (const li of items) {
      const a = getPromptNameAnchor(li);
      if (!a) continue;

      saveOriginalPromptDisplayName(li);
      const originalName = a.dataset.pmgOriginalName ?? getCanonicalPromptName(li) ?? a.textContent ?? '';
      const parsed = parsePromptName(originalName, config.secondLevelEnabled, prefixRules);

      if (!parsed.hasPrefix) {
        currentGroup1 = null;
        currentGroup2 = null;
        currentGroupId = null;
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
        const occ = group1OccCount[g1] || 0;
        group1OccCount[g1] = occ + 1;
        currentGroupId = buildGroup1Id(g1, occ);
        const header1Title = occ > 0 ? `${g1} (${occ + 1})` : g1;
        const header1 = createGroupHeaderLi({ level: 1, group1: g1, groupId: currentGroupId, displayTitle: header1Title });
        listEl.insertBefore(header1, li);
        currentGroup1 = g1;
        currentGroup2 = null;
      }

      li.dataset.pmgGroupId = currentGroupId;

      if (config.secondLevelEnabled && g1 && g2) {
        li.dataset.pmgGroup2 = g2;
        li.classList.add('pmg-in-group2');
        // 在同一个 group1 实例下，对同名 group2 也分配 occurrence id（以及显示编号），避免联动
        const g2CounterKey = `${String(currentGroupId)}|||${String(g2)}`;
        if (!(g2CounterKey in group2OccCount)) group2OccCount[g2CounterKey] = 0;

        // 只有在遇到新二级标题时才递增 occ
        if (g2 !== currentGroup2) {
          group2OccCount[g2CounterKey] = group2OccCount[g2CounterKey] + 1;
        }
        const effectiveG2Occ = Math.max(0, (group2OccCount[g2CounterKey] || 1) - 1);

        const group2Id = buildGroup2Id(currentGroupId, g2, effectiveG2Occ);
        li.dataset.pmgGroup2Id = group2Id;

        if (g2 !== currentGroup2) {
          const header2Title = effectiveG2Occ > 0 ? `${g2} (${effectiveG2Occ + 1})` : g2;
          const header2 = createGroupHeaderLi({ level: 2, group1: g1, group2: g2, groupId: currentGroupId, group2Id, displayTitle: header2Title });
          listEl.insertBefore(header2, li);
          currentGroup2 = g2;
        }
      } else {
        delete li.dataset.pmgGroup2;
        delete li.dataset.pmgGroup2Id;
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

    // 以 DOM 顺序跟踪当前一级组的折叠状态，避免 dataset 丢失/错配导致的“一级折叠但二级仍显示”
    let activeGroup1Id = null;
    let activeGroup1Collapsed = false;

    for (const child of Array.from(listEl.children)) {
      if (!(child instanceof HTMLElement)) continue;

      if (child.classList.contains('pmg-group-header')) {
        const level = Number(child.dataset.pmgLevel || '0');
        const g1 = child.dataset.pmgGroup1;
        const g2 = child.dataset.pmgGroup2;
        const gId = child.dataset.pmgGroupId || g1;
        const g2Id = child.dataset.pmgGroup2Id;

        if (level === 1) {
          activeGroup1Id = gId || null;
          activeGroup1Collapsed = !!(activeGroup1Id && isGroup1Collapsed(activeGroup1Id));
          // 组标题的 CSS 里有 display: block !important，因此这里不要用 style.display 控制显示
          child.style.removeProperty('display');
        } else if (level === 2) {
          // 若父一级组折叠，则二级组标题也应隐藏
          // 注意：组标题 CSS 使用了 display: block !important，必须用 inline !important 才能真正隐藏
          if (activeGroup1Collapsed) {
            child.style.setProperty('display', 'none', 'important');
          } else {
            child.style.removeProperty('display');
          }
          const arrow = child.querySelector('.pmg-collapse-icon');
          if (arrow) {
            const key = String(g2Id || buildGroup2Id(String(gId || g1), String(g2), 0));
            const collapsed = isGroup2Collapsed(key);
            arrow.classList.toggle('fa-chevron-right', collapsed);
            arrow.classList.toggle('fa-chevron-down', !collapsed);
          }
        }

        const fav = child.querySelector('.pmg-group-fav');
        if (fav) {
          if (level === 1 && g1) {
            const on = isGroup1Favorited(gId || g1);
            fav.classList.toggle('pmg-fav-on', on);
            fav.classList.toggle('pmg-fav-off', !on);
          } else if (level === 2 && g1 && g2) {
            const on = isGroup2Favorited(String(g2Id || buildGroup2Id(String(gId || g1), String(g2), 0)));
            fav.classList.toggle('pmg-fav-on', on);
            fav.classList.toggle('pmg-fav-off', !on);
          }
        }

        if (level === 1 && gId) {
          const arrow = child.querySelector('.pmg-collapse-icon');
          if (arrow) {
            const collapsed = isGroup1Collapsed(gId);
            arrow.classList.toggle('fa-chevron-right', collapsed);
            arrow.classList.toggle('fa-chevron-down', !collapsed);
          }
        }
        continue;
      }

      if (isPromptItemLi(child)) {
        const g1 = child.dataset.pmgGroup1;
        const g2 = child.dataset.pmgGroup2;
        const gId = child.dataset.pmgGroupId || g1;
        const g2Id = child.dataset.pmgGroup2Id;
        const hasPrefix = child.dataset.pmgHasPrefix === '1';

        if (!config.groupingEnabled || !hasPrefix || !gId) {
          child.style.display = '';
          // standalone item：重置组上下文
          if (!hasPrefix) {
            activeGroup1Id = null;
            activeGroup1Collapsed = false;
          }
          continue;
        }

        // 基于“当前父一级组”优先判断（避免偶发错配导致二级标题/条目穿透）
        const parentCollapsed = activeGroup1Id ? isGroup1Collapsed(activeGroup1Id) : isGroup1Collapsed(gId);
        if (parentCollapsed) {
          child.style.display = 'none';
          continue;
        }

        if (config.secondLevelEnabled && g2 && g2Id && isGroup2Collapsed(String(g2Id))) {
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
      const store = getScopedFavoritesStore();

      const itemIdSet = new Set(snapshot.map((x) => x.identifier).filter(Boolean));
      store.items = (store.items || []).filter((id) => itemIdSet.has(id));

      const group1IdSet = new Set(snapshot.filter((x) => x.hasPrefix && x.group1Id).map((x) => x.group1Id));
      const group2IdSet = new Set(snapshot.filter((x) => x.hasPrefix && x.group2Id).map((x) => x.group2Id));

      // legacy key -> ids 的映射（用于从 v1/v2-early 的“按名称”收藏迁移到“按实例 ID”）
      const group1NameToId = new Map();
      const group2KeyToId = new Map();
      for (const x of snapshot) {
        if (!x.hasPrefix) continue;
        if (x.group1 && x.group1Id) {
          if (!group1NameToId.has(x.group1)) group1NameToId.set(x.group1, x.group1Id);
        }
        if (x.group1 && x.group2 && x.group2Id) {
          const k = group2Key(x.group1, x.group2);
          if (!group2KeyToId.has(k)) group2KeyToId.set(k, x.group2Id);
        }
      }

      const looksLikeGroup1Id = (s) => typeof s === 'string' && /#\d+$/.test(s);
      const looksLikeGroup2Id = (s) => {
        if (typeof s !== 'string') return false;
        // group1Id|||group2#n
        const parts = s.split('|||');
        if (parts.length !== 2) return false;
        if (!/#\d+$/.test(parts[0])) return false;
        if (!/#\d+$/.test(parts[1])) return false;
        return true;
      };

      // group1
      const migratedGroup1 = [];
      for (const g of (store.group1 || [])) {
        if (group1IdSet.has(g)) { migratedGroup1.push(g); continue; }
        // legacy: group1 name
        if (!looksLikeGroup1Id(g)) {
          const id = group1NameToId.get(String(g));
          if (id) migratedGroup1.push(id);
        }
      }
      store.group1 = ensureArrayUnique(migratedGroup1).filter((id) => group1IdSet.has(id));

      // group2
      const migratedGroup2 = [];
      for (const k of (store.group2 || [])) {
        if (group2IdSet.has(k)) { migratedGroup2.push(k); continue; }
        // legacy: group2Key(group1Name, group2Name)
        if (!looksLikeGroup2Id(k) && String(k).includes('|||')) {
          const id = group2KeyToId.get(String(k));
          if (id) migratedGroup2.push(id);
        }
      }
      store.group2 = ensureArrayUnique(migratedGroup2).filter((id) => group2IdSet.has(id));
    } catch {
      // ignore
    }
  }

  function getPromptItemsSnapshot() {
    const listEl = findPromptManagerList();
    if (!listEl) return [];
    const items = Array.from(listEl.querySelectorAll('li.completion_prompt_manager_prompt'));

    // 计算“组实例 ID”（不依赖已注入的 header / dataset），确保在关闭分组时收藏仍可按实例生效
    const group1OccCount = {};
    const group2OccCount = {}; // key: group1Id|||group2Name -> occCounter
    let currentGroup1 = null;
    let currentGroup1Id = null;
    let currentGroup2 = null;
    let currentGroup2Id = null;

    const prefixRules = buildPrefixParseRules();

    return items.map((li) => {
      const identifier = getPromptIdentifier(li);
      const name = getCanonicalPromptName(li);
      const parsed = parsePromptName(name, true, prefixRules);
      const displayName = (config.hidePrefixes && parsed.leaf) ? parsed.leaf : name;

      let group1Id = null;
      let group2Id = null;

      if (!parsed.hasPrefix) {
        currentGroup1 = null;
        currentGroup1Id = null;
        currentGroup2 = null;
        currentGroup2Id = null;
      } else {
        if (parsed.group1 && parsed.group1 !== currentGroup1) {
          const occ = group1OccCount[parsed.group1] || 0;
          group1OccCount[parsed.group1] = occ + 1;
          currentGroup1 = parsed.group1;
          currentGroup1Id = buildGroup1Id(parsed.group1, occ);
          currentGroup2 = null;
          currentGroup2Id = null;
        }

        group1Id = currentGroup1Id;

        if (config.secondLevelEnabled && parsed.group2) {
          if (parsed.group2 !== currentGroup2) {
            const k = `${String(currentGroup1Id)}|||${String(parsed.group2)}`;
            const occ2 = group2OccCount[k] || 0;
            group2OccCount[k] = occ2 + 1;
            currentGroup2 = parsed.group2;
            currentGroup2Id = buildGroup2Id(String(currentGroup1Id), String(parsed.group2), occ2);
          }
          group2Id = currentGroup2Id;
        } else {
          currentGroup2 = null;
          currentGroup2Id = null;
          group2Id = null;
        }
      }

      return {
        li,
        identifier,
        name,
        displayName,
        group1: parsed.group1,
        group2: parsed.group2,
        group1Id,
        group2Id,
        leaf: parsed.leaf || name,
        hasPrefix: parsed.hasPrefix,
      };
    });
  }

  function toggleGroupPromptsByGroup1Id(group1Id) {
    const snapshot = getPromptItemsSnapshot();
    const items = snapshot.filter((x) => x.hasPrefix && x.group1Id === group1Id);
    if (items.length === 0) return;
    const enabledCount = items.reduce((acc, x) => acc + (isPromptEnabled(x.li) ? 1 : 0), 0);
    const targetEnable = enabledCount !== items.length;
    for (const it of items) clickPromptToggle(it.li, targetEnable);
  }

  function toggleGroupPromptsByGroup2Id(group2Id) {
    const snapshot = getPromptItemsSnapshot();
    const items = snapshot.filter((x) => x.hasPrefix && x.group2Id === group2Id);
    if (items.length === 0) return;
    const enabledCount = items.reduce((acc, x) => acc + (isPromptEnabled(x.li) ? 1 : 0), 0);
    const targetEnable = enabledCount !== items.length;
    for (const it of items) clickPromptToggle(it.li, targetEnable);
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

  // v1 legacy: by group names (kept for compatibility, but favorites now use instance IDs)
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

    // quick favorites（浮动快捷栏）里：
    // - 普通条目需要更“多字显示”（CSS 处理）
    // - 一级/二级分类的“整组开关”容易误触，这里移除该按钮
    const isFloatingQuickBar =
      body instanceof HTMLElement &&
      (body.classList.contains('pmg-floating-body') || !!body.closest('#pmg-floating-panel'));

    const listEl = findPromptManagerList();
    if (!listEl) {
      const msg = document.createElement('div');
      msg.className = 'pmg-fav-empty';
      msg.textContent = '请先打开预设面板以加载提示词列表';
      body.appendChild(msg);
      return;
    }

    normalizeFavoritesData();
    const favStore = getScopedFavoritesStore();
    const favGroup1Ids = ensureArrayUnique(favStore.group1);
    const favGroup2Ids = ensureArrayUnique(favStore.group2);
    const favItems = ensureArrayUnique(favStore.items);

    const snapshot = getPromptItemsSnapshot();

    // id -> display mapping
    const group1IdToName = new Map();
    const group2IdToInfo = new Map();
    for (const it of snapshot) {
      if (!it.hasPrefix) continue;
      if (it.group1Id && it.group1) group1IdToName.set(it.group1Id, it.group1);
      if (it.group2Id && it.group1Id && it.group1 && it.group2) {
        group2IdToInfo.set(it.group2Id, { group1Id: it.group1Id, group1: it.group1, group2: it.group2 });
      }
    }

    // 二级组：如果其所属的一级组实例已经收藏，则二级组行不再单独显示
    const favGroup1IdSet = new Set(favGroup1Ids);
    const effectiveGroup2Ids = favGroup2Ids.filter((g2id) => {
      const info = group2IdToInfo.get(g2id);
      if (!info) return false;
      return !favGroup1IdSet.has(info.group1Id);
    });

    const makeRow = (titleText) => {
      const row = document.createElement('div');
      row.className = 'pmg-fav-row';

      const title = document.createElement('div');
      title.className = 'pmg-fav-title';
      title.textContent = titleText;

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

      // title 本身 flex:1，足以把按钮推到右侧；不再插入 spacer，避免标题可用宽度被“吃掉”
      row.appendChild(title);
      row.appendChild(btnToggle);
      row.appendChild(btnUnfav);

      return { row, title, btnToggle, btnUnfav };
    };

    const makeGroupRow = ({ titleText, expanded }) => {
      const { row, title, btnToggle, btnUnfav } = makeRow(titleText);
      row.classList.add('pmg-fav-group-row');

      // 浮动快捷栏里移除“整组开关”按钮（避免误触一键开关整组）
      if (isFloatingQuickBar && btnToggle) {
        try { btnToggle.remove(); } catch { /* ignore */ }
      }

      const exp = document.createElement('span');
      exp.className = `pmg-fav-expand fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} interactable`;
      exp.title = expanded ? '收起' : '展开';
      exp.tabIndex = 0;
      exp.setAttribute('role', 'button');
      row.insertBefore(exp, title);
      return { row, exp, btnToggle: isFloatingQuickBar ? null : btnToggle, btnUnfav };
    };

    const makeChildrenContainer = (visible) => {
      const div = document.createElement('div');
      div.className = 'pmg-fav-children';
      div.style.display = visible ? 'block' : 'none';
      return div;
    };

    const getDisplayName = (it) => it.displayName || (config.hidePrefixes ? it.leaf : it.name);

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

    const hasAny = favGroup1Ids.length + effectiveGroup2Ids.length + favItems.length > 0;
    if (!hasAny) {
      const empty = document.createElement('div');
      empty.className = 'pmg-fav-empty';
      empty.textContent = '暂无收藏（可在提示词条目右侧点击\u2B50，或在分组标题右侧点击\u2B50）';
      body.appendChild(empty);
      return;
    }

    // 1) 一级组（同名但不同位置的组实例，加编号以便区分）
    const g1NameOccCounter = {};
    for (const g1Id of favGroup1Ids) {
      const g1NameRaw = group1IdToName.get(g1Id) || splitGroup1Id(g1Id).group1 || g1Id;
      const occ = (g1NameOccCounter[g1NameRaw] || 0) + 1;
      g1NameOccCounter[g1NameRaw] = occ;
      const g1Name = occ > 1 ? `${g1NameRaw} (${occ})` : g1NameRaw;
      const expanded = isFavoritesGroup1Expanded(g1Id);
      const { row, exp, btnToggle, btnUnfav } = makeGroupRow({ titleText: `\u3010${g1Name}\u3011`, expanded });

      const toggleExpand = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        setFavoritesGroup1Expanded(g1Id, !isFavoritesGroup1Expanded(g1Id));
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

      if (btnToggle) {
        btnToggle.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          toggleGroupPromptsByGroup1Id(g1Id);
          setTimeout(renderAllFavoritesPanels, 60);
        });
      }

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteGroup1(g1Id);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply('unfav-group1', 0);
      });

      body.appendChild(row);

      const children = makeChildrenContainer(expanded);
      const group2SetLocal = new Set(effectiveGroup2Ids);
      // 属于该 group1 实例 的所有条目（排除已单独收藏为二级组实例的）
      const allInG1 = snapshot.filter((x) => {
        if (!x.hasPrefix || x.group1Id !== g1Id) return false;
        if (x.group2Id && group2SetLocal.has(x.group2Id)) return false;
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
        // 有 group2 的按子分组渲染（同名子组也加编号）
        const g2NameOccCounterLocal = {};
        for (const [g2Name, g2Items] of g2Map) {
          const occNum = (g2NameOccCounterLocal[g2Name] || 0) + 1;
          g2NameOccCounterLocal[g2Name] = occNum;
          const g2Id = g2Items[0]?.group2Id;
          if (!g2Id) {
            // fallback: no id, render items directly
            for (const it of g2Items) renderChildItem(it, children, 'toggle-fav-item-in-sub-g2');
            continue;
          }
          const g2Expanded = isFavoritesGroup2Expanded(g2Id);
          const g2Title = occNum > 1 ? `${g2Name} (${occNum})` : g2Name;
          const { row: g2Row, exp: g2Exp, btnToggle: g2Toggle, btnUnfav: g2Fav } = makeGroupRow({ titleText: g2Title, expanded: g2Expanded });
          g2Row.classList.add('pmg-fav-sub-group-row');

          const toggleG2Expand = async (ev) => {
            if (ev?.preventDefault) ev.preventDefault();
            if (ev?.stopPropagation) ev.stopPropagation();
            setFavoritesGroup2Expanded(g2Id, !isFavoritesGroup2Expanded(g2Id));
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
          if (g2Toggle) {
            g2Toggle.addEventListener('click', (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              toggleGroupPromptsByGroup2Id(g2Id);
              setTimeout(renderAllFavoritesPanels, 60);
            });
          }
          g2Fav.addEventListener('click', async (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            toggleFavoriteGroup2(g2Id);
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

    // 2) 二级组（脱离“名称显示”：同名二级组显示 (n) 后缀）
    const g2NameOccCounter = {};
    for (const g2Id of effectiveGroup2Ids) {
      const info = group2IdToInfo.get(g2Id);
      if (!info) continue;

      const baseName = `\u3010${info.group1}\u3011 ${info.group2}`;
      const occ = (g2NameOccCounter[baseName] || 0) + 1;
      g2NameOccCounter[baseName] = occ;
      const titleText = occ > 1 ? `${baseName} (${occ})` : baseName;

      const expanded = isFavoritesGroup2Expanded(g2Id);
      const { row, exp, btnToggle, btnUnfav } = makeGroupRow({ titleText, expanded });

      const toggleExpand = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        setFavoritesGroup2Expanded(g2Id, !isFavoritesGroup2Expanded(g2Id));
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

      if (btnToggle) {
        btnToggle.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          toggleGroupPromptsByGroup2Id(g2Id);
          setTimeout(renderAllFavoritesPanels, 60);
        });
      }

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleFavoriteGroup2(g2Id);
        await saveConfig();
        renderAllFavoritesPanels();
        debounceApply('unfav-group2', 0);
      });

      body.appendChild(row);

      const children = makeChildrenContainer(expanded);
      const childItems = snapshot.filter((x) => x.hasPrefix && x.group2Id === g2Id);

      for (const it of childItems) renderChildItem(it, children, 'toggle-fav-item-in-group2');

      if (childItems.length > 0) body.appendChild(children);
    }

    // 3) 单独条目
    const favGroup1Set2 = new Set(favGroup1Ids);
    const effectiveGroup2Set2 = new Set(effectiveGroup2Ids);
    const coveredFavItems = new Set();
    for (const x of snapshot) {
      if (!new Set(favItems).has(x.identifier)) continue;
      if (!x.hasPrefix) continue;
      if (x.group1Id && favGroup1Set2.has(x.group1Id)) { coveredFavItems.add(x.identifier); continue; }
      if (x.group2Id && effectiveGroup2Set2.has(x.group2Id)) { coveredFavItems.add(x.identifier); continue; }
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

    // 标题显示当前预设名（按预设隔离收藏，避免混淆）
    const header = holder.querySelector('.pmg-fav-header b');
    if (header) {
      const pn = activePresetName ? `（${activePresetName}）` : '';
      header.textContent = `\u2B50 收藏${pn}`;
    }

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
    if (!el || !pos || typeof pos !== 'object') return;

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 44;
    const h = el.offsetHeight || 44;
    const denomX = Math.max(1, vw - w);
    const denomY = Math.max(1, vh - h);

    let left = null;
    let top = null;

    // 新格式（相对位置）：relX/relY ∈ [0, 1]，相对于“可移动区域”(vw-w, vh-h)
    if (typeof pos.relX === 'number' && typeof pos.relY === 'number') {
      left = pos.relX * denomX;
      top = pos.relY * denomY;
    }

    // 旧格式（绝对像素）：left/top
    if (left === null || top === null) {
      if (typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
      left = pos.left;
      top = pos.top;
    }

    left = clamp(left, 0, denomX);
    top = clamp(top, 0, denomY);

    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  /**
   * 将当前元素位置转为相对位置（relX/relY），用于在缩放窗口后保持相对位置，避免挤出屏幕。
   * @param {HTMLElement} el
   * @param {{left:number, top:number}} abs
   */
  function toRelativeFloatingPos(el, abs) {
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 44;
    const h = el.offsetHeight || 44;
    const denomX = Math.max(1, vw - w);
    const denomY = Math.max(1, vh - h);
    return {
      relX: clamp01(abs.left / denomX),
      relY: clamp01(abs.top / denomY),
    };
  }

  /**
   * 把历史配置（仅 left/top）迁移为 relX/relY（仅迁移一次）。
   * 迁移时以“应用后”的实际位置为准（避免历史 left/top 越界）。
   */
  function migrateFloatingPosIfNeeded(configKey, el) {
    try {
      if (!el) return;
      const pos = config?.[configKey];
      if (!pos || typeof pos !== 'object') return;
      if (typeof pos.relX === 'number' && typeof pos.relY === 'number') return;
      if (typeof pos.left !== 'number' || typeof pos.top !== 'number') return;

      const rect = el.getBoundingClientRect();
      const rel = toRelativeFloatingPos(el, { left: rect.left, top: rect.top });
      pos.relX = rel.relX;
      pos.relY = rel.relY;
      void saveConfig();
    } catch {
      // ignore
    }
  }

  let floatingViewportGuardInstalled = false;
  function ensureFloatingViewportGuardInstalled() {
    if (floatingViewportGuardInstalled) return;
    floatingViewportGuardInstalled = true;

    let raf = null;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;

        // 面板始终悬浮，按钮仅在悬浮模式需要 clamp
        if (floatingPanelEl && config?.floatingPanelPos) {
          applyFloatingPos(floatingPanelEl, config.floatingPanelPos);
        }
        if (floatingToggleBtn && getQuickFavoritesButtonPlacement() === 'floating' && config?.floatingTogglePos) {
          applyFloatingPos(floatingToggleBtn, config.floatingTogglePos);
        }
      });
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  let floatingPanelEl = null;
  let floatingToggleBtn = null;

  // localStorage keys (仅存最容易被用户感知的“拖拽位置/顺序”)
  const LS_KEY_FLOATING_TOGGLE_POS = '__pmg_floating_toggle_pos_v1';
  const LS_KEY_FLOATING_PANEL_POS = '__pmg_floating_panel_pos_v1';
  const LS_KEY_EMBEDDED_INDEX = '__pmg_quick_favorites_embedded_index_v1';

  function safeReadLocalStorageJson(key) {
    try {
      const s = window.localStorage?.getItem(key);
      if (!s) return null;
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function safeWriteLocalStorageJson(key, value) {
    try {
      if (!window.localStorage) return;
      if (value === null || value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  function persistQuickFavoritesPosToLocalStorage() {
    safeWriteLocalStorageJson(LS_KEY_FLOATING_TOGGLE_POS, config?.floatingTogglePos ?? null);
    safeWriteLocalStorageJson(LS_KEY_FLOATING_PANEL_POS, config?.floatingPanelPos ?? null);
  }

  function restoreQuickFavoritesPosFromLocalStorageIfNeeded() {
    try {
      if (!config || typeof config !== 'object') return;

      // localStorage 作为“拖拽位置”的最终来源：只要有合法值就覆盖（避免 variables 保存失败导致回退）
      const tp = safeReadLocalStorageJson(LS_KEY_FLOATING_TOGGLE_POS);
      if (tp && typeof tp === 'object') config.floatingTogglePos = tp;
      const pp = safeReadLocalStorageJson(LS_KEY_FLOATING_PANEL_POS);
      if (pp && typeof pp === 'object') config.floatingPanelPos = pp;
    } catch {
      // ignore
    }
  }

  function persistQuickFavoritesEmbeddedIndexToLocalStorage() {
    safeWriteLocalStorageJson(LS_KEY_EMBEDDED_INDEX, config?.quickFavoritesEmbeddedIndexByPlacement ?? null);
  }

  function restoreQuickFavoritesEmbeddedIndexFromLocalStorageIfNeeded() {
    try {
      if (!config || typeof config !== 'object') return;
      const v = safeReadLocalStorageJson(LS_KEY_EMBEDDED_INDEX);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        config.quickFavoritesEmbeddedIndexByPlacement = {
          qr: Number.isInteger(v.qr) && v.qr >= 0 ? v.qr : null,
          send: Number.isInteger(v.send) && v.send >= 0 ? v.send : null,
        };
      }
    } catch {
      // ignore
    }
  }

  function getQuickFavoritesButtonPlacement() {
    const v = String(config?.quickFavoritesButtonPlacement || 'floating');
    if (v === 'qr' || v === 'send' || v === 'floating') return v;
    return 'floating';
  }

  function getQuickFavoritesEmbeddedIndex(placement) {
    if (placement !== 'qr' && placement !== 'send') return null;
    const store = config?.quickFavoritesEmbeddedIndexByPlacement;
    if (!store || typeof store !== 'object' || Array.isArray(store)) return null;
    const v = store[placement];
    return Number.isInteger(v) && v >= 0 ? v : null;
  }

  function setQuickFavoritesEmbeddedIndex(placement, index) {
    if (placement !== 'qr' && placement !== 'send') return;
    config.quickFavoritesEmbeddedIndexByPlacement =
      config.quickFavoritesEmbeddedIndexByPlacement &&
        typeof config.quickFavoritesEmbeddedIndexByPlacement === 'object' &&
        !Array.isArray(config.quickFavoritesEmbeddedIndexByPlacement)
        ? config.quickFavoritesEmbeddedIndexByPlacement
        : { qr: null, send: null };
    config.quickFavoritesEmbeddedIndexByPlacement[placement] = Number.isInteger(index) && index >= 0 ? index : null;
  }

  function placeElementAtIndex(parent, el, index) {
    if (!(parent instanceof HTMLElement) || !(el instanceof HTMLElement)) return;
    const children = Array.from(parent.children).filter((x) => x !== el);
    const i = Number.isInteger(index) && index >= 0 ? index : null;
    const ref = i !== null ? (children[i] || null) : null;
    if (ref) parent.insertBefore(el, ref);
    else parent.appendChild(el);
  }

  // 监听嵌入容器内的顺序变化（用户或其他插件拖拽排序），并将 index 写入配置
  let quickFavEmbeddedObserver = null;
  let quickFavEmbeddedObserverTarget = null;
  let quickFavEmbeddedObserverPlacement = null;
  let quickFavEmbeddedObserverApplying = false;
  let quickFavEmbeddedSaveTimer = null;

  function teardownQuickFavEmbeddedObserver() {
    try { quickFavEmbeddedObserver?.disconnect(); } catch { /* ignore */ }
    quickFavEmbeddedObserver = null;
    quickFavEmbeddedObserverTarget = null;
    quickFavEmbeddedObserverPlacement = null;
  }

  function scheduleSaveQuickFavEmbeddedIndex() {
    if (quickFavEmbeddedSaveTimer) clearTimeout(quickFavEmbeddedSaveTimer);
    quickFavEmbeddedSaveTimer = setTimeout(() => {
      quickFavEmbeddedSaveTimer = null;
      void saveConfig();
    }, 250);
  }

  function recordQuickFavEmbeddedIndexNow(target, placement) {
    if (!floatingToggleBtn) return;
    if (!(target instanceof HTMLElement)) return;
    if (placement !== 'qr' && placement !== 'send') return;
    const idx = Array.from(target.children).indexOf(floatingToggleBtn);
    if (idx < 0) return;
    const prev = getQuickFavoritesEmbeddedIndex(placement);
    if (prev === idx) return;
    setQuickFavoritesEmbeddedIndex(placement, idx);
    scheduleSaveQuickFavEmbeddedIndex();
  }

  function ensureQuickFavEmbeddedObserver(target, placement) {
    if (placement !== 'qr' && placement !== 'send') {
      teardownQuickFavEmbeddedObserver();
      return;
    }
    if (quickFavEmbeddedObserver && quickFavEmbeddedObserverTarget === target && quickFavEmbeddedObserverPlacement === placement) return;
    teardownQuickFavEmbeddedObserver();
    quickFavEmbeddedObserverTarget = target;
    quickFavEmbeddedObserverPlacement = placement;
    quickFavEmbeddedObserver = new MutationObserver(() => {
      if (quickFavEmbeddedObserverApplying) return;
      recordQuickFavEmbeddedIndexNow(target, placement);
    });
    try {
      quickFavEmbeddedObserver.observe(target, { childList: true });
    } catch {
      // ignore
    }
  }

  function findQrButtonsContainer() {
    return document.querySelector('.qr--buttons');
  }

  function findSendButtonsContainer() {
    return (
      document.getElementById('rightSendForm') ||
      document.querySelector('#rightSendForm.alignContentCenter') ||
      document.querySelector('.alignContentCenter')
    );
  }

  function applyQuickFavoritesButtonPlacement() {
    if (!floatingToggleBtn) return;

    const placement = getQuickFavoritesButtonPlacement();
    const isEmbedded = placement !== 'floating';
    floatingToggleBtn.classList.toggle('pmg-toggle-embedded', isEmbedded);

    if (!isEmbedded) {
      if (floatingToggleBtn.parentElement !== document.body) {
        document.body.appendChild(floatingToggleBtn);
      }
      teardownQuickFavEmbeddedObserver();
      // 恢复保存的位置（仅悬浮模式有效）
      if (config.floatingTogglePos) applyFloatingPos(floatingToggleBtn, config.floatingTogglePos);
      return;
    }

    // 嵌入模式：清除悬浮定位样式
    try {
      floatingToggleBtn.style.removeProperty('left');
      floatingToggleBtn.style.removeProperty('top');
      floatingToggleBtn.style.removeProperty('right');
      floatingToggleBtn.style.removeProperty('bottom');
    } catch {
      // ignore
    }

    let target = null;
    if (placement === 'qr') target = findQrButtonsContainer();
    if (placement === 'send') target = findSendButtonsContainer();
    if (target instanceof HTMLElement) {
      const desiredIndex = getQuickFavoritesEmbeddedIndex(placement);
      // 尽量按上次记录的 index 插入，避免每次 apply 都把按钮“塞到最后面”
      try {
        quickFavEmbeddedObserverApplying = true;
        placeElementAtIndex(target, floatingToggleBtn, desiredIndex);
      } finally {
        quickFavEmbeddedObserverApplying = false;
      }

      ensureQuickFavEmbeddedObserver(target, placement);
      // 记录一次当前 index（首次插入/容器重建时会更新）
      recordQuickFavEmbeddedIndexNow(target, placement);
    } else {
      // 找不到目标容器时 fallback：仍挂到 body（避免按钮丢失）
      if (floatingToggleBtn.parentElement !== document.body) document.body.appendChild(floatingToggleBtn);
      teardownQuickFavEmbeddedObserver();
    }
  }

  function createFloatingPanel() {
    if (floatingPanelEl) return;

    const panel = document.createElement('div');
    panel.id = 'pmg-floating-panel';
    panel.className = 'pmg-floating-panel';
    if (!config.floatingPanelExpanded) panel.classList.add('pmg-floating-collapsed');

    const header = document.createElement('div');
    header.className = 'pmg-floating-header';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'pmg-floating-title';
    titleSpan.textContent = '\u2B50 收藏快捷栏';
    header.appendChild(titleSpan);

    const settingsBtn = document.createElement('span');
    settingsBtn.className = 'pmg-floating-settings fa-solid fa-gear interactable';
    settingsBtn.title = '打开 PMG 设置';
    settingsBtn.tabIndex = 0;
    settingsBtn.setAttribute('role', 'button');
    settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPmgStandaloneSettings();
    });
    settingsBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        openPmgStandaloneSettings();
      }
    });
    header.appendChild(settingsBtn);

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

    // 安装拖拽 - 星形按钮（仅悬浮模式启用；嵌入到 QR/发送栏时禁用拖拽）
    const toggleDrag = installDrag(toggleBtn, toggleBtn, {
      threshold: 6,
      shouldIgnore: () => getQuickFavoritesButtonPlacement() !== 'floating',
      onDragEnd: async (pos) => {
        if (getQuickFavoritesButtonPlacement() !== 'floating') return;
        config.floatingTogglePos = { ...pos, ...toRelativeFloatingPos(toggleBtn, pos) };
        await saveConfig();
      },
    });

    const togglePanel = async () => {
      config.floatingPanelExpanded = !config.floatingPanelExpanded;
      panel.classList.toggle('pmg-floating-collapsed', !config.floatingPanelExpanded);
      toggleBtn.classList.toggle('pmg-floating-toggle-active', config.floatingPanelExpanded);
      if (config.floatingPanelExpanded) {
        try { await refreshActivePresetName(false); } catch { /* ignore */ }
        renderFloatingFavoritesPanel();
      }
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
        return t instanceof HTMLElement && (!!t.closest('.pmg-floating-close') || !!t.closest('.pmg-floating-settings'));
      },
      onDragEnd: async (pos) => {
        config.floatingPanelPos = { ...pos, ...toRelativeFloatingPos(panel, pos) };
        await saveConfig();
      },
    });

    document.body.appendChild(panel);

    floatingPanelEl = panel;
    floatingToggleBtn = toggleBtn;

    // 恢复保存的位置（面板始终是悬浮）
    if (config.floatingPanelPos) applyFloatingPos(panel, config.floatingPanelPos);

    // 迁移旧配置（left/top）到相对位置（relX/relY）
    if (config.floatingPanelPos) migrateFloatingPosIfNeeded('floatingPanelPos', panel);

    // 按配置挂载按钮位置
    applyQuickFavoritesButtonPlacement();

    // 确保按钮的相对位置也完成迁移（需要已挂载到 DOM 才能计算尺寸）
    // 注意：仅在悬浮模式迁移，否则会把“嵌入到 QR/发送栏”时的布局位置误写入。
    if (floatingToggleBtn && config.floatingTogglePos && getQuickFavoritesButtonPlacement() === 'floating') {
      migrateFloatingPosIfNeeded('floatingTogglePos', floatingToggleBtn);
    }

    // 安装窗口缩放守卫：缩小窗口时自动 clamp 回视口内
    ensureFloatingViewportGuardInstalled();

    if (config.floatingPanelExpanded) {
      toggleBtn.classList.add('pmg-floating-toggle-active');
    }
  }

  function removeFloatingPanel() {
    if (floatingPanelEl) { floatingPanelEl.remove(); floatingPanelEl = null; }
    if (floatingToggleBtn) { floatingToggleBtn.remove(); floatingToggleBtn = null; }
    teardownQuickFavEmbeddedObserver();
  }

  function renderFloatingFavoritesPanel() {
    if (!floatingPanelEl || !config.floatingPanelExpanded) return;

    // 标题显示当前预设名（按预设隔离收藏，避免混淆）
    const title = floatingPanelEl.querySelector('.pmg-floating-title');
    if (title) {
      const pn = activePresetName ? `（${activePresetName}）` : '';
      title.textContent = `\u2B50 收藏快捷栏${pn}`;
    }

    const body = floatingPanelEl.querySelector('.pmg-floating-body');
    if (!body) return;
    renderFavoritesContent(body);
  }

  function updateFloatingPanelVisibility() {
    if (config.favoritesEnabled && config.floatingPanelEnabled) {
      if (!floatingPanelEl) createFloatingPanel();
      if (floatingToggleBtn) floatingToggleBtn.style.display = '';
      if (floatingPanelEl) floatingPanelEl.classList.toggle('pmg-floating-collapsed', !config.floatingPanelExpanded);
      applyQuickFavoritesButtonPlacement();
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

  function renderSettingsUI(container) {
    container.innerHTML = `
<div class="pmg-settings">
  <div class="pmg-settings-intro">
    <small>
      如有建议或者bug, 欢迎反馈! 反馈帖子链接→ <a href="https://www.example.com" target="_blank" rel="noopener noreferrer">预设折叠插件</a>
      <br>在GitHub提issue也行！链接→ <a href="https://github.com/qianzhuowo/ST-Prompt-Manager-Grouping" target="_blank" rel="noopener noreferrer">GitHub插件链接</a>
    </small>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title">📁 分组</div>
    <div class="pmg-settings-row">
      <label class="checkbox_label">
        <input type="checkbox" id="pmg_grouping_enabled">
        <span>启用分组（启用后将禁用原生拖拽）</span>
      </label>
    </div>

    <div class="inline-drawer pmg-settings-drawer">
      <div class="inline-drawer-toggle inline-drawer-header" data-pmg-drawer="grouping_options">
        <b>更多分组选项</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content" data-pmg-drawer-content="grouping_options" style="display:none;">
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
      </div>
    </div>

    <div class="inline-drawer pmg-settings-drawer">
      <div class="inline-drawer-toggle inline-drawer-header" data-pmg-drawer="prefix_rules">
        <b>前缀解析规则</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content" data-pmg-drawer-content="prefix_rules" style="display:none;">
        <div class="pmg-settings-row">
          <label class="checkbox_label">
            <input type="checkbox" id="pmg_prefix_bracket">
            <span>启用【】包裹前缀（如：<code>【常用】提示词</code>）</span>
          </label>
        </div>
        <div class="pmg-settings-row">
          <label class="checkbox_label">
            <input type="checkbox" id="pmg_prefix_dash">
            <span>启用短横线分割前缀（如：<code>常用-提示词</code>）</span>
          </label>
        </div>
        <div class="pmg-settings-row">
          <label class="checkbox_label">
            <input type="checkbox" id="pmg_prefix_custom_wrapper">
            <span>启用自定义包裹前缀</span>
          </label>
          <div class="flex-container gap10px" style="margin-left: 28px; align-items: center; flex-wrap:wrap;">
            <span>左</span>
            <input type="text" class="text_pole" id="pmg_prefix_custom_wrapper_left" placeholder="例如：「" style="width: 70px;">
            <span>右</span>
            <input type="text" class="text_pole" id="pmg_prefix_custom_wrapper_right" placeholder="例如：」" style="width: 70px;">
          </div>
        </div>
        <div class="pmg-settings-row">
          <label class="checkbox_label">
            <input type="checkbox" id="pmg_prefix_custom_separator">
            <span>启用自定义分隔符前缀（如：<code>常用=提示词</code>）</span>
          </label>
          <div class="flex-container gap10px" style="margin-left: 28px; align-items: center; flex-wrap:wrap;">
            <span>分隔符</span>
            <input type="text" class="text_pole" id="pmg_prefix_custom_separator_value" placeholder="例如：= 或 =,＝" style="width: 160px;">
          </div>
          <div style="margin-left: 28px; opacity: 0.85;"><small>支持用逗号分隔多个分隔符（例如：<code>=,＝</code>）</small></div>
        </div>
      </div>
    </div>

    <div class="inline-drawer pmg-settings-drawer">
      <div class="inline-drawer-toggle inline-drawer-header" data-pmg-drawer="help">
        <b>命名示例 / 帮助</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content pmg-settings-hint" data-pmg-drawer-content="help" style="display:none;">
        <small>
          <b>命名示例：</b><br>
          1）<code>【常用】阡濯自制</code> → 一级组：<code>常用</code><br>
          2）<code>文生图-测试1</code> → 一级组：<code>文生图</code><br>
          3）<code>文生图-【常用】测试2</code> → 组：<code>文生图 / 常用</code><br>
          4）<code>【文生图】常用-测试3</code> → 组：<code>文生图 / 常用</code><br>
          5）<code>常用=测试4</code> → 一级组：<code>常用</code>（需启用自定义分隔符）<br>
          6）<code>「常用」测试5</code> → 一级组：<code>常用</code>（需启用自定义包裹前缀）<br>
        </small>
      </div>
    </div>

  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title">⭐ 收藏 / 快捷栏</div>
    <div class="pmg-settings-row">
      <label class="checkbox_label">
        <input type="checkbox" id="pmg_favorites_enabled">
        <span>启用收藏（提示词条目右侧显示\u2B50）</span>
      </label>
    </div>

    <div class="inline-drawer pmg-settings-drawer">
      <div class="inline-drawer-toggle inline-drawer-header" data-pmg-drawer="favorites_options">
        <b>更多收藏选项</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content" data-pmg-drawer-content="favorites_options" style="display:none;">
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
        <div class="pmg-settings-row" style="margin-left: 28px;">
          <div style="opacity: 0.9; margin-bottom: 4px;">快捷收藏栏按钮位置</div>
          <select class="text_pole" id="pmg_quick_fav_btn_place" style="width: min(420px, 100%);">
            <option value="floating">悬浮自由位置（可拖拽）</option>
            <option value="qr">QR 栏</option>
            <option value="send">发送按钮旁</option>
          </select>
          <div style="opacity: 0.75; margin-top: 4px;"><small>提示：切换到 QR/发送按钮旁后将禁用拖拽（切回悬浮后恢复上次悬浮位置）。</small></div>
        </div>
        <div class="pmg-settings-row">
          <label class="checkbox_label">
            <input type="checkbox" id="pmg_favorites_expand_default">
            <span>收藏栏：分组默认展开</span>
          </label>
        </div>
      </div>
    </div>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title">⚡ 性能</div>
    <div class="pmg-settings-row">
      <label class="checkbox_label">
        <input type="checkbox" id="pmg_block_refresh">
        <span>预设条目开关时阻止预设面板刷新</span>
      </label>
    </div>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-row flex-container gap10px pmg-settings-op-row" style="align-items:center; flex-wrap:nowrap; overflow-x:auto;">
      <div class="pmg-settings-section-title">🛠 操作</div>
      <span class="pmg-flex-spacer"></span>
      <div class="menu_button" id="pmg_btn_apply">立即刷新列表</div>
      <div class="menu_button caution" id="pmg_btn_clear_fav">清空所有收藏</div>
    </div>
  </div>
</div>
    `.trim();

    const $ = (sel) => container.querySelector(sel);
    const elGrouping = $('#pmg_grouping_enabled');
    const elSecond = $('#pmg_second_level');
    const elHide = $('#pmg_hide_prefix');
    const elPrefixBracket = $('#pmg_prefix_bracket');
    const elPrefixDash = $('#pmg_prefix_dash');
    const elPrefixCustomWrapper = $('#pmg_prefix_custom_wrapper');
    const elPrefixCustomWrapperLeft = $('#pmg_prefix_custom_wrapper_left');
    const elPrefixCustomWrapperRight = $('#pmg_prefix_custom_wrapper_right');
    const elPrefixCustomSeparator = $('#pmg_prefix_custom_separator');
    const elPrefixCustomSeparatorValue = $('#pmg_prefix_custom_separator_value');
    const elFav = $('#pmg_favorites_enabled');
    const elFavPanel = $('#pmg_favorites_panel');
    const elFloatingPanel = $('#pmg_floating_panel');
    const elQuickFavPlace = $('#pmg_quick_fav_btn_place');
    const elBlockRefresh = $('#pmg_block_refresh');
    const elFavExpandDefault = $('#pmg_favorites_expand_default');
    const btnApply = $('#pmg_btn_apply');
    const btnClear = $('#pmg_btn_clear_fav');

    const installDrawer = (drawerKey, defaultExpanded = false) => {
      const header = container.querySelector(`[data-pmg-drawer="${drawerKey}"]`);
      const content = container.querySelector(`[data-pmg-drawer-content="${drawerKey}"]`);
      if (!(header instanceof HTMLElement) || !(content instanceof HTMLElement)) return;
      const icon = header.querySelector('.inline-drawer-icon');
      const remembered = config?.settingsDrawerExpanded && typeof config.settingsDrawerExpanded === 'object'
        ? config.settingsDrawerExpanded[drawerKey]
        : undefined;
      let expanded = typeof remembered === 'boolean' ? remembered : !!defaultExpanded;

      const refresh = () => {
        content.style.display = expanded ? 'block' : 'none';
        if (icon instanceof HTMLElement) {
          icon.classList.toggle('fa-circle-chevron-up', expanded);
          icon.classList.toggle('up', expanded);
          icon.classList.toggle('fa-circle-chevron-down', !expanded);
          icon.classList.toggle('down', !expanded);
        }
      };

      header.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        expanded = !expanded;
        config.settingsDrawerExpanded =
          config.settingsDrawerExpanded && typeof config.settingsDrawerExpanded === 'object'
            ? config.settingsDrawerExpanded
            : {};
        config.settingsDrawerExpanded[drawerKey] = expanded;
        refresh();

        try {
          await saveConfig();
        } catch {
          // ignore
        }
      });

      refresh();
    };

    // 次要选项默认收起，保持简洁
    installDrawer('grouping_options', false);
    installDrawer('prefix_rules', false);
    installDrawer('favorites_options', false);
    installDrawer('help', true);

    const syncToUI = () => {
      if (elGrouping) elGrouping.checked = !!config.groupingEnabled;
      if (elSecond) elSecond.checked = !!config.secondLevelEnabled;
      if (elHide) elHide.checked = !!config.hidePrefixes;
      if (elPrefixBracket) elPrefixBracket.checked = !!config.prefixBracketEnabled;
      if (elPrefixDash) elPrefixDash.checked = !!config.prefixDashEnabled;
      if (elPrefixCustomWrapper) elPrefixCustomWrapper.checked = !!config.prefixCustomWrapperEnabled;
      if (elPrefixCustomWrapperLeft) elPrefixCustomWrapperLeft.value = String(config.prefixCustomWrapperLeft ?? '');
      if (elPrefixCustomWrapperRight) elPrefixCustomWrapperRight.value = String(config.prefixCustomWrapperRight ?? '');
      if (elPrefixCustomSeparator) elPrefixCustomSeparator.checked = !!config.prefixCustomSeparatorEnabled;
      if (elPrefixCustomSeparatorValue) elPrefixCustomSeparatorValue.value = String(config.prefixCustomSeparator ?? '');
      if (elFav) elFav.checked = !!config.favoritesEnabled;
      if (elFavPanel) elFavPanel.checked = !!config.favoritesPanelEnabled;
      if (elFloatingPanel) elFloatingPanel.checked = !!config.floatingPanelEnabled;
      if (elQuickFavPlace instanceof HTMLSelectElement) elQuickFavPlace.value = String(config.quickFavoritesButtonPlacement || 'floating');
      if (elBlockRefresh) elBlockRefresh.checked = !!config.blockPresetUiRefreshOnToggle;
      if (elFavExpandDefault) elFavExpandDefault.checked = !!config.favoritesExpandGroupsByDefault;

      if (elQuickFavPlace instanceof HTMLSelectElement) {
        elQuickFavPlace.disabled = !(config.favoritesEnabled && config.floatingPanelEnabled);
      }

      // 不再强制要求“启用分组”才能配置其他选项（允许提前设置）
      if (elPrefixCustomWrapperLeft) elPrefixCustomWrapperLeft.disabled = !config.prefixCustomWrapperEnabled;
      if (elPrefixCustomWrapperRight) elPrefixCustomWrapperRight.disabled = !config.prefixCustomWrapperEnabled;
      if (elPrefixCustomSeparatorValue) elPrefixCustomSeparatorValue.disabled = !config.prefixCustomSeparatorEnabled;
    };

    const onChange = async () => {
      config.groupingEnabled = !!elGrouping?.checked;
      config.secondLevelEnabled = !!elSecond?.checked;
      config.hidePrefixes = !!elHide?.checked;
      config.prefixBracketEnabled = !!elPrefixBracket?.checked;
      config.prefixDashEnabled = !!elPrefixDash?.checked;
      config.prefixCustomWrapperEnabled = !!elPrefixCustomWrapper?.checked;
      config.prefixCustomWrapperLeft = String(elPrefixCustomWrapperLeft?.value ?? config.prefixCustomWrapperLeft ?? '').trim();
      config.prefixCustomWrapperRight = String(elPrefixCustomWrapperRight?.value ?? config.prefixCustomWrapperRight ?? '').trim();
      config.prefixCustomSeparatorEnabled = !!elPrefixCustomSeparator?.checked;
      config.prefixCustomSeparator = String(elPrefixCustomSeparatorValue?.value ?? config.prefixCustomSeparator ?? '').trim();
      config.favoritesEnabled = !!elFav?.checked;
      config.favoritesPanelEnabled = !!elFavPanel?.checked;
      config.floatingPanelEnabled = !!elFloatingPanel?.checked;
      if (elQuickFavPlace instanceof HTMLSelectElement) {
        config.quickFavoritesButtonPlacement = String(elQuickFavPlace.value || 'floating');
      }
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
    elPrefixBracket?.addEventListener('change', onChange);
    elPrefixDash?.addEventListener('change', onChange);
    elPrefixCustomWrapper?.addEventListener('change', onChange);
    elPrefixCustomWrapperLeft?.addEventListener('change', onChange);
    elPrefixCustomWrapperRight?.addEventListener('change', onChange);
    elPrefixCustomSeparator?.addEventListener('change', onChange);
    elPrefixCustomSeparatorValue?.addEventListener('change', onChange);
    elFav?.addEventListener('change', onChange);
    elFavPanel?.addEventListener('change', onChange);
    elFloatingPanel?.addEventListener('change', onChange);
    elQuickFavPlace?.addEventListener('change', onChange);
    elBlockRefresh?.addEventListener('change', onChange);
    elFavExpandDefault?.addEventListener('change', onChange);

    btnApply?.addEventListener('click', () => debounceApply('manual-apply', 0));
    btnClear?.addEventListener('click', async () => {
      if (activePresetName) {
        config.favoritesByPreset =
          config.favoritesByPreset && typeof config.favoritesByPreset === 'object'
            ? config.favoritesByPreset
            : {};
        config.favoritesByPreset[activePresetName] = { group1: [], group2: [], items: [] };
      } else {
        config.favorites = { group1: [], group2: [], items: [] };
      }
      await saveConfig();
      debounceApply('clear-fav', 0);
    });

    syncToUI();
    return () => { };
  }


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
        render: (container) => renderSettingsUI(container),

      },
    });
  }

  async function unregisterSettingsPanelEntry() {
    const ST_API = getSTApi();
    if (!ST_API?.ui?.unregisterSettingsPanel) return;
    const panelId = `${PLUGIN_NS}.settings`;
    try {
      await ST_API.ui.unregisterSettingsPanel({ id: panelId });
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------

  function attachToList(listEl) {
    currentListEl = listEl;


    // 注入 Prompt Manager 顶部工具栏（设置 / 快速前缀编辑）
    ensurePromptManagerToolbar(listEl);

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

  async function applyAllWithPresetCheck(reason) {
    try {
      await refreshActivePresetName(false);
    } catch {
      // ignore
    }
    applyAll(reason);
  }

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


      ensurePromptManagerToolbar(currentListEl);

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

    // 预先获取当前预设名（用于按预设隔离收藏）
    try { await refreshActivePresetName(true); } catch { /* ignore */ }

    if (config.blockPresetUiRefreshOnToggle) {
      try { await installRenderPatch(); } catch { /* ignore */ }
    }

    try { await unregisterSettingsPanelEntry(); } catch { /* ignore */ }

    updateFloatingPanelVisibility();
    startBodyObserver();
    debounceApply('init', 0);

    log('Initialized');
  }

  init();
})();
