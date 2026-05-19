/*
 * Prompt Manager Grouping (PMG)
 *
 * 一个用于管理 SillyTavern Prompt Manager 列表（#completion_prompt_manager_list）的前端扩展：
 * - 基于名称前缀（【】/ - / 自定义包裹 / 自定义分隔符）进行 1~2 级分组
 * - 分组标题支持收起/展开
 * - 支持隐藏前缀（仅显示，不修改原始 prompt 名称/数据）
 * - 支持收藏（一级/二级/单独条目）+ 内联收藏面板 + 独立浮动收藏快捷栏
 * - 可选禁用酒馆原生拖拽（sortable），避免分组视图被原生排序打乱
 *
 * 前置依赖插件：st-api-wrapper（window.ST_API）
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

  // 拖拽排序性能保护：拖拽过程中 jQuery UI sortable 会产生大量 childList mutation。
  // 如果每次 mutation 都触发 PMG 重分组 / 收藏栏刷新，会导致明显卡顿。
  let promptListDragActive = false;
  let promptListDragSettleTimer = null;
  let pendingApplyAfterPromptDrag = false;
  let pendingApplyAfterPromptDragReason = '';
  let forceRegroupAfterPromptDrag = false;
  let promptListDragStartedBySortable = false;
  let suppressListMutationUntil = 0;

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

  function isDelayableApplyReasonDuringPromptDrag(reason) {
    const r = String(reason || '');
    return (
      r.includes('list-mutation') ||
      r.includes('body-mutation') ||
      r.includes('attach') ||
      r.includes('native-sortable') ||
      r.includes('prompt-drag')
    );
  }

  function markApplyPendingAfterPromptDrag(reason) {
    pendingApplyAfterPromptDrag = true;
    pendingApplyAfterPromptDragReason = String(reason || pendingApplyAfterPromptDragReason || 'prompt-drag');
  }

  function suppressOwnListMutations(durationMs = 180) {
    suppressListMutationUntil = Math.max(suppressListMutationUntil, Date.now() + durationMs);
  }

  function isOwnListMutationSuppressed() {
    return Date.now() < suppressListMutationUntil;
  }

  function debounceApply(reason, delayMs = 80) {
    if (promptListDragActive && isDelayableApplyReasonDuringPromptDrag(reason)) {
      markApplyPendingAfterPromptDrag(reason);
      return;
    }

    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      if (promptListDragActive && isDelayableApplyReasonDuringPromptDrag(reason)) {
        markApplyPendingAfterPromptDrag(reason);
        return;
      }
      // 先刷新当前预设名称（用于按预设隔离收藏），再应用 UI
      void applyAllWithPresetCheck(reason);
    }, delayMs);
  }

  function beginPromptListDrag(reason = 'prompt-drag-start', options = {}) {
    promptListDragActive = true;
    if (options.sortableStarted) promptListDragStartedBySortable = true;
    if (promptListDragSettleTimer) {
      clearTimeout(promptListDragSettleTimer);
      promptListDragSettleTimer = null;
    }
    if (options.markPending !== false) markApplyPendingAfterPromptDrag(reason);
    if (currentListEl instanceof HTMLElement) currentListEl.dataset.pmgPromptDragActive = '1';
  }

  function endPromptListDrag(reason = 'prompt-drag-stop') {
    if (!promptListDragActive && !pendingApplyAfterPromptDrag) return;

    if (promptListDragSettleTimer) clearTimeout(promptListDragSettleTimer);
    // update / stop / DOM settle 的触发顺序在不同 jQuery UI 版本中略有差异，延迟一小段时间再统一刷新。
    promptListDragSettleTimer = setTimeout(() => {
      promptListDragSettleTimer = null;
      promptListDragActive = false;
      if (currentListEl instanceof HTMLElement) delete currentListEl.dataset.pmgPromptDragActive;

      const pendingReason = pendingApplyAfterPromptDragReason || reason;
      const shouldFlushAfterDrag = pendingApplyAfterPromptDrag || promptListDragStartedBySortable;
      pendingApplyAfterPromptDrag = false;
      pendingApplyAfterPromptDragReason = '';
      promptListDragStartedBySortable = false;

      if (!shouldFlushAfterDrag) return;
      forceRegroupAfterPromptDrag = true;

      // 拖拽结束后只做一次重分组/折叠/收藏栏刷新，避免拖拽过程中连续重建 DOM。
      debounceApply(`${pendingReason}-settled`, 0);
    }, 120);
  }

  function createDefaultConfig() {
    return {
      version: 8,

      // 分组
      groupingEnabled: true,
      secondLevelEnabled: true,
      hidePrefixes: true,
      // 是否禁用 SillyTavern 原生 Prompt Manager 拖拽排序（独立于分组开关）
      disableNativeDragWhenGrouped: true,

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
      // 浮动面板当前页签：favorites=收藏条目，presets=收藏预设
      floatingPanelActiveTab: 'favorites',

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

      // ---------------------------------------------------------------------
      // 原生预设界面统一卷轴折叠（聊天补全设置面板内若干常用区域）
      // ---------------------------------------------------------------------
      // 是否启用该功能（总开关，默认开启）
      nativePanelCollapseEnabled: true,
      // 统一卷轴折叠状态：true=折叠，false/缺省=展开
      // { [regionId: string]: boolean }
      // regionId: 'nativePresetRoll'
      nativePanelCollapsed: {},

      // ---------------------------------------------------------------------
      // 原生 OpenAI 预设下拉栏增强（#settings_preset_openai）
      // ---------------------------------------------------------------------
      // 收藏的预设会在原生下拉栏中置顶；增强管理面板支持不切换预设直接改名/导出/删除/另存为。
      nativePresetEnhancedEnabled: true,
      nativePresetFavorites: [],

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
      'disableNativeDragWhenGrouped',
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
      'floatingPanelActiveTab',
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
      'nativePanelCollapseEnabled',
      'nativePanelCollapsed',
      'nativePresetEnhancedEnabled',
      'nativePresetFavorites',
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

    if (typeof out.nativePanelCollapseEnabled !== 'boolean') {
      out.nativePanelCollapseEnabled = true;
    }
    if (!out.nativePanelCollapsed || typeof out.nativePanelCollapsed !== 'object' || Array.isArray(out.nativePanelCollapsed)) {
      out.nativePanelCollapsed = {};
    } else {
      // 规范化为布尔值
      const cleaned = {};
      for (const [k, v] of Object.entries(out.nativePanelCollapsed)) {
        cleaned[String(k)] = !!v;
      }

      // 如果用户旧配置里有任一区域处于折叠状态，则迁移为统一卷轴折叠，尽量保留用户意图。
      if (!('nativePresetRoll' in cleaned)) {
        const legacyRegionIds = ['chatBehavior', 'quickPrompts', 'utilityPrompts', 'seed', 'logitBias'];
        if (legacyRegionIds.some((id) => cleaned[id])) {
          cleaned.nativePresetRoll = true;
        }
      }
      out.nativePanelCollapsed = cleaned;
    }

    if (typeof out.nativePresetEnhancedEnabled !== 'boolean') {
      out.nativePresetEnhancedEnabled = true;
    }
    if (!Array.isArray(out.nativePresetFavorites)) {
      out.nativePresetFavorites = [];
    }

    if (out.floatingPanelActiveTab !== 'favorites' && out.floatingPanelActiveTab !== 'presets') {
      out.floatingPanelActiveTab = 'favorites';
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
  // Native PromptManager enhancement patch
  //
  // 不再代理/隐藏原生列表，而是 patch PromptManager 的原生渲染方法：
  // - renderPromptManagerListItems：直接渲染 PMG 分组标题 + 原生 prompt 条目
  // - init：增强实例 handleToggle，阻止单条开关触发 PromptManager.render() 重建 DOM
  // ---------------------------------------------------------------------------

  const INJECTION_POSITION_ABSOLUTE = 1;

  /** @type {null | {
   *  installed: boolean;
   *  proto: any;
   *  originalRenderPromptManagerListItems: Function;
   *  originalInit: Function|null;
   *  originalMakeDraggable: Function|null;
   *  lastInstance: any;
   * }} */
  let promptManagerNativePatchState = null;

  function escapeHtmlLocal(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function escapeAttrLocal(value) {
    return escapeHtmlLocal(value).replace(/`/g, '&#96;');
  }

  async function installPromptManagerNativePatch() {
    if (promptManagerNativePatchState?.installed) return;

    let mod;
    try {
      mod = await import('/scripts/PromptManager.js');
    } catch (e) {
      warn('Failed to import PromptManager.js for native patch:', e);
      return;
    }

    const PromptManager = mod?.PromptManager;
    const proto = PromptManager?.prototype;
    if (!proto || typeof proto.renderPromptManagerListItems !== 'function') {
      warn('PromptManager.prototype.renderPromptManagerListItems not found');
      return;
    }

    if (proto.renderPromptManagerListItems.__pmgNativePatched) {
      promptManagerNativePatchState = {
        installed: true,
        proto,
        originalRenderPromptManagerListItems: proto.renderPromptManagerListItems.__pmgOriginalRenderPromptManagerListItems || proto.renderPromptManagerListItems,
        originalInit: proto.init?.__pmgOriginalInit || null,
        originalMakeDraggable: proto.makeDraggable?.__pmgOriginalMakeDraggable || null,
        lastInstance: null,
      };
      return;
    }

    const originalRenderPromptManagerListItems = proto.renderPromptManagerListItems;
    const originalInit = typeof proto.init === 'function' ? proto.init : null;
    const originalMakeDraggable = typeof proto.makeDraggable === 'function' ? proto.makeDraggable : null;

    proto.renderPromptManagerListItems = async function pmgNativeRenderPromptManagerListItems() {
      if (!config.groupingEnabled) {
        if (this.listElement instanceof HTMLElement) {
          delete this.listElement.dataset.pmgNativeRendered;
        }
        return originalRenderPromptManagerListItems.call(this);
      }

      promptManagerNativePatchState && (promptManagerNativePatchState.lastInstance = this);
      return renderPromptManagerListItemsWithPmgGroups.call(this);
    };
    proto.renderPromptManagerListItems.__pmgNativePatched = true;
    proto.renderPromptManagerListItems.__pmgOriginalRenderPromptManagerListItems = originalRenderPromptManagerListItems;

    if (originalInit && !proto.init.__pmgInitPatched) {
      proto.init = function pmgPatchedPromptManagerInit(...args) {
        const result = originalInit.apply(this, args);
        patchPromptManagerInstanceToggle(this);
        return result;
      };
      proto.init.__pmgInitPatched = true;
      proto.init.__pmgOriginalInit = originalInit;
    }

    if (originalMakeDraggable && !proto.makeDraggable.__pmgMakeDraggablePatched) {
      proto.makeDraggable = function pmgPatchedMakeDraggable(...args) {
        promptManagerNativePatchState && (promptManagerNativePatchState.lastInstance = this);
        const list = this.listElement || document.getElementById(this.configuration.prefix + 'prompt_manager_list');
        if (config.disableNativeDragWhenGrouped) {
          if (list instanceof HTMLElement) disableNativeSortable(list);
          return;
        }
        const result = originalMakeDraggable.apply(this, args);
        if (list instanceof HTMLElement) enableNativeSortable(list);
        return result;
      };
      proto.makeDraggable.__pmgMakeDraggablePatched = true;
      proto.makeDraggable.__pmgOriginalMakeDraggable = originalMakeDraggable;
    }

    promptManagerNativePatchState = {
      installed: true,
      proto,
      originalRenderPromptManagerListItems,
      originalInit,
      originalMakeDraggable,
      lastInstance: null,
    };

    log('PromptManager native render patched');
  }

  function uninstallPromptManagerNativePatch() {
    const state = promptManagerNativePatchState;
    if (!state?.installed) return;
    // 不主动恢复 prototype，避免破坏其他插件链式 patch；只关闭 PMG 原生增强行为。
    config.groupingEnabled = false;
    promptManagerNativePatchState = null;
  }

  function patchPromptManagerInstanceToggle(instance) {
    if (!instance || instance.__pmgTogglePatched) return;
    const originalHandleToggle = instance.handleToggle;
    if (typeof originalHandleToggle !== 'function') return;

    instance.handleToggle = function pmgInstanceHandleToggle(event) {
      if (!config.blockPresetUiRefreshOnToggle) {
        return originalHandleToggle.call(this, event);
      }
      return handlePromptToggleWithoutRender.call(instance, event);
    };
    instance.handleToggle.__pmgOriginalHandleToggle = originalHandleToggle;
    instance.__pmgTogglePatched = true;
  }

  function handlePromptToggleWithoutRender(event) {
    const target = event?.target;
    if (!(target instanceof HTMLElement)) return;
    const promptLi = target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt');
    const promptID = promptLi?.dataset?.pmIdentifier;
    if (!promptID) return;

    const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
    if (!promptOrderEntry) return;

    const counts = this.tokenHandler?.getCounts?.();
    if (counts) counts[promptID] = null;

    promptOrderEntry.enabled = !promptOrderEntry.enabled;
    updatePromptToggleDom(this, promptID, promptOrderEntry.enabled);

    try {
      this.saveServiceSettings();
    } catch (e) {
      warn('Failed to save prompt toggle state:', e);
    }

    setTimeout(renderAllFavoritesPanels, 30);
  }

  function updatePromptToggleDom(pm, promptID, enabled) {
    const list = pm?.listElement || findPromptManagerList();
    if (!list) return;
    const selector = `.${pm.configuration.prefix}prompt_manager_prompt[data-pm-identifier="${cssEscapeCompat(promptID)}"]`;
    const disabledClass = `${pm.configuration.prefix}prompt_manager_prompt_disabled`;
    for (const li of Array.from(list.querySelectorAll(selector))) {
      if (!(li instanceof HTMLElement)) continue;
      li.classList.toggle(disabledClass, !enabled);
      const toggle = li.querySelector('.prompt-manager-toggle-action');
      if (toggle) {
        toggle.classList.toggle('fa-toggle-on', enabled);
        toggle.classList.toggle('fa-toggle-off', !enabled);
      }
    }
  }

  function buildPromptManagerListHeaderHtml(prefix) {
    return `
      <li class="${escapeAttrLocal(prefix)}prompt_manager_list_head">
        <span data-i18n="Name">Name</span>
        <span></span>
        <span class="prompt_manager_prompt_tokens" data-i18n="Tokens;prompt_manager_tokens">Tokens</span>
      </li>
      <li class="${escapeAttrLocal(prefix)}prompt_manager_list_separator"><hr></li>
    `;
  }

  function buildPromptItemHtml(pm, prompt, parsed) {
    const { prefix } = pm.configuration;
    const listEntry = pm.getPromptOrderEntry(pm.activeCharacter, prompt.identifier);
    if (!listEntry) return '';

    const enabledClass = listEntry.enabled ? '' : `${prefix}prompt_manager_prompt_disabled`;
    const draggableClass = `${prefix}prompt_manager_prompt_draggable`;
    const markerClass = prompt.marker ? `${prefix}prompt_manager_marker` : '';
    const tokens = pm.tokenHandler?.getCounts?.()[prompt.identifier] ?? 0;

    let warningClass = '';
    let warningTitle = '';
    const tokenBudget = Number(pm.serviceSettings.openai_max_context || 0) - Number(pm.serviceSettings.openai_max_tokens || 0);
    if (pm.tokenUsage > tokenBudget * 0.8 && prompt.identifier === 'chatHistory') {
      const warningThreshold = pm.configuration.warningTokenThreshold;
      const dangerThreshold = pm.configuration.dangerTokenThreshold;
      if (tokens <= dangerThreshold) {
        warningClass = 'fa-solid tooltip fa-triangle-exclamation text_danger';
        warningTitle = 'Very little of your chat history is being sent, consider deactivating some other prompts.';
      } else if (tokens <= warningThreshold) {
        warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
        warningTitle = 'Only a few messages worth chat history are being sent.';
      }
    }

    const calculatedTokens = tokens ? tokens : '-';
    const detachSpanHtml = pm.isPromptDeletionAllowed(prompt)
      ? '<span title="Remove" class="prompt-manager-detach-action caution fa-solid fa-chain-broken fa-xs"></span>'
      : '<span class="fa-solid"></span>';
    const editSpanHtml = pm.isPromptEditAllowed(prompt)
      ? '<span title="edit" class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>'
      : '<span class="fa-solid"></span>';
    const toggleSpanHtml = pm.isPromptToggleAllowed(prompt)
      ? `<span class="prompt-manager-toggle-action ${listEntry.enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>`
      : '<span class="fa-solid"></span>';

    const originalName = String(prompt.name ?? '');
    const displayName = config.hidePrefixes && parsed?.hasPrefix ? (parsed.leaf || originalName) : originalName;
    const encodedName = escapeHtmlLocal(displayName);
    const encodedOriginalName = escapeAttrLocal(originalName);
    const encodedIdentifier = escapeAttrLocal(prompt.identifier);
    const isMarkerPrompt = prompt.marker && prompt.injection_position !== INJECTION_POSITION_ABSOLUTE;
    const isSystemPrompt = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION_ABSOLUTE && !prompt.forbid_overrides;
    const isImportantPrompt = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION_ABSOLUTE && prompt.forbid_overrides;
    const isUserPrompt = !prompt.marker && !prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION_ABSOLUTE;
    const isInjectionPrompt = prompt.injection_position === INJECTION_POSITION_ABSOLUTE;
    const isOverriddenPrompt = Array.isArray(pm.overriddenPrompts) && pm.overriddenPrompts.includes(prompt.identifier);
    const importantClass = isImportantPrompt ? `${prefix}prompt_manager_important` : '';
    const iconLookup = prompt.role === 'system' && (prompt.marker || prompt.system_prompt) ? '' : prompt.role;
    const promptRoles = {
      assistant: { roleIcon: 'fa-robot', roleTitle: 'Prompt will be sent as Assistant' },
      user: { roleIcon: 'fa-user', roleTitle: 'Prompt will be sent as User' },
    };
    const roleIcon = promptRoles[iconLookup]?.roleIcon || '';
    const roleTitle = promptRoles[iconLookup]?.roleTitle || '';
    const depthText = prompt.injection_depth ?? '';

    return `
      <li class="${escapeAttrLocal(prefix)}prompt_manager_prompt ${escapeAttrLocal(draggableClass)} ${escapeAttrLocal(enabledClass)} ${escapeAttrLocal(markerClass)} ${escapeAttrLocal(importantClass)}" data-pm-identifier="${encodedIdentifier}">
        <span class="drag-handle">☰</span>
        <span class="${escapeAttrLocal(prefix)}prompt_manager_prompt_name" data-pm-name="${encodedOriginalName}">
          ${isMarkerPrompt ? '<span class="fa-fw fa-solid fa-thumb-tack" title="Marker"></span>' : ''}
          ${isSystemPrompt ? '<span class="fa-fw fa-solid fa-square-poll-horizontal" title="Global Prompt"></span>' : ''}
          ${isImportantPrompt ? '<span class="fa-fw fa-solid fa-star" title="Important Prompt"></span>' : ''}
          ${isUserPrompt ? '<span class="fa-fw fa-solid fa-asterisk" title="Preset Prompt"></span>' : ''}
          ${isInjectionPrompt ? '<span class="fa-fw fa-solid fa-syringe" title="In-Chat Injection"></span>' : ''}
          ${pm.isPromptInspectionAllowed(prompt) ? `<a title="${encodedOriginalName}" class="prompt-manager-inspect-action">${encodedName}</a>` : `<span title="${encodedOriginalName}">${encodedName}</span>`}
          ${roleIcon ? `<span data-role="${escapeAttrLocal(prompt.role)}" class="fa-xs fa-solid ${escapeAttrLocal(roleIcon)}" title="${escapeAttrLocal(roleTitle)}"></span>` : ''}
          ${isInjectionPrompt ? `<small class="prompt-manager-injection-depth">@ ${escapeHtmlLocal(depthText)}</small>` : ''}
          ${isOverriddenPrompt ? '<small class="fa-solid fa-address-card prompt-manager-overridden" title="Pulled from a character card"></small>' : ''}
        </span>
        <span>
          <span class="prompt_manager_prompt_controls">
            ${detachSpanHtml}
            ${editSpanHtml}
            ${toggleSpanHtml}
          </span>
        </span>
        <span class="prompt_manager_prompt_tokens" data-pm-tokens="${escapeAttrLocal(calculatedTokens)}"><span class="${escapeAttrLocal(warningClass)}" title="${escapeAttrLocal(warningTitle)}"> </span>${escapeHtmlLocal(calculatedTokens)}</span>
      </li>
    `;
  }

  function bindPromptManagerListEvents(pm, promptManagerList) {
    Array.from(promptManagerList.getElementsByClassName('prompt-manager-detach-action')).forEach(el => {
      el.addEventListener('click', pm.handleDetach);
    });
    Array.from(promptManagerList.getElementsByClassName('prompt-manager-inspect-action')).forEach(el => {
      el.addEventListener('click', pm.handleInspect);
    });
    Array.from(promptManagerList.getElementsByClassName('prompt-manager-edit-action')).forEach(el => {
      el.addEventListener('click', pm.handleEdit);
    });
    Array.from(promptManagerList.querySelectorAll('.prompt-manager-toggle-action')).forEach(el => {
      el.addEventListener('click', config.blockPresetUiRefreshOnToggle ? (event) => handlePromptToggleWithoutRender.call(pm, event) : pm.handleToggle);
    });
  }

  async function renderPromptManagerListItemsWithPmgGroups() {
    if (!this.serviceSettings?.prompts) return;
    patchPromptManagerInstanceToggle(this);

    promptManagerNativePatchState && (promptManagerNativePatchState.lastInstance = this);

    const promptManagerList = this.listElement;
    if (!promptManagerList) return;
    currentListEl = promptManagerList;

    suppressOwnListMutations(220);
    promptManagerList.dataset.pmgNativeRendered = '1';
    promptManagerList.innerHTML = '';

    const { prefix } = this.configuration;
    promptManagerList.insertAdjacentHTML('beforeend', buildPromptManagerListHeaderHtml(prefix));
    const fragment = document.createDocumentFragment();

    const prefixRules = buildPrefixParseRules();
    let currentGroup1 = null;
    let currentGroup2 = null;
    let currentGroupId = null;
    const group1OccCount = {};
    const group2OccCount = {};

    const appendPromptHtml = (prompt, parsed) => {
      const html = buildPromptItemHtml(this, prompt, parsed);
      if (!html) return null;
      const template = document.createElement('template');
      template.innerHTML = html.trim();
      const li = template.content.firstElementChild;
      if (li instanceof HTMLElement) {
        fragment.appendChild(li);
        if (config.favoritesEnabled) ensureItemFavoriteButton(li);
      }
      return li;
    };

    this.getPromptsForCharacter(this.activeCharacter).forEach(prompt => {
      if (!prompt) return;
      const originalName = String(prompt.name ?? '');
      const parsed = parsePromptName(originalName, config.secondLevelEnabled, prefixRules);

      if (!parsed.hasPrefix) {
        currentGroup1 = null;
        currentGroup2 = null;
        currentGroupId = null;
        const li = appendPromptHtml(prompt, parsed);
        if (li) {
          li.dataset.pmgHasPrefix = '0';
          li.classList.add('pmg-item-standalone');
        }
        return;
      }

      const g1 = parsed.group1;
      const g2 = parsed.group2;

      if (g1 && g1 !== currentGroup1) {
        const occ = group1OccCount[g1] || 0;
        group1OccCount[g1] = occ + 1;
        currentGroupId = buildGroup1Id(g1, occ);
        const header1Title = occ > 0 ? `${g1} (${occ + 1})` : g1;
        fragment.appendChild(createGroupHeaderLi({ level: 1, group1: g1, groupId: currentGroupId, displayTitle: header1Title }));
        currentGroup1 = g1;
        currentGroup2 = null;
      }

      let group2Id = null;
      if (config.secondLevelEnabled && g1 && g2) {
        const g2CounterKey = `${String(currentGroupId)}|||${String(g2)}`;
        if (!(g2CounterKey in group2OccCount)) group2OccCount[g2CounterKey] = 0;
        if (g2 !== currentGroup2) group2OccCount[g2CounterKey] += 1;
        const effectiveG2Occ = Math.max(0, (group2OccCount[g2CounterKey] || 1) - 1);
        group2Id = buildGroup2Id(currentGroupId, g2, effectiveG2Occ);

        if (g2 !== currentGroup2) {
          const header2Title = effectiveG2Occ > 0 ? `${g2} (${effectiveG2Occ + 1})` : g2;
          fragment.appendChild(createGroupHeaderLi({ level: 2, group1: g1, group2: g2, groupId: currentGroupId, group2Id, displayTitle: header2Title }));
          currentGroup2 = g2;
        }
      } else {
        currentGroup2 = null;
      }

      const li = appendPromptHtml(prompt, parsed);
      if (li) {
        li.dataset.pmgHasPrefix = '1';
        li.dataset.pmgGroup1 = g1;
        li.dataset.pmgGroupId = currentGroupId;
        li.classList.add('pmg-in-group1');
        if (group2Id && g2) {
          li.dataset.pmgGroup2 = g2;
          li.dataset.pmgGroup2Id = group2Id;
          li.classList.add('pmg-in-group2');
        }
      }
    });

    promptManagerList.appendChild(fragment);

    bindPromptManagerListEvents(this, promptManagerList);
    applyNativeDragState(promptManagerList);
    applyCollapseVisibility();
  }

  function activateRenderFreeze() {
    // 兼容旧调用点：native patch 下开关由 handlePromptToggleWithoutRender 处理，不再需要冻结 render。
    if (!promptManagerNativePatchState?.installed) {
      void installPromptManagerNativePatch();
    }
  }

  function requestPromptManagerNativeRender(afterTryGenerate = false) {
    const inst = promptManagerNativePatchState?.lastInstance;
    if (!inst || typeof inst.render !== 'function') return false;
    setTimeout(() => {
      try {
        inst.render(afterTryGenerate);
      } catch (e) {
        warn('PromptManager native render request failed:', e);
        debounceApply('native-render-fallback', 0);
      }
    }, 0);
    return true;
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

      // 性能优化已固定默认开启，不再允许通过设置页关闭。
      config.blockPresetUiRefreshOnToggle = true;

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

      config.nativePresetFavorites = ensureArrayUnique(config.nativePresetFavorites).map(String).filter(Boolean);

      log('Config loaded:', config);

      // localStorage 兜底：快捷收藏栏 UI 状态、浮动按钮/面板位置 & 嵌入模式顺序
      restoreQuickFavoritesUiStateFromLocalStorageIfNeeded();
      restoreQuickFavoritesPosFromLocalStorageIfNeeded();
      restoreQuickFavoritesEmbeddedIndexFromLocalStorageIfNeeded();
      restoreNoRefreshUiStateFromLocalStorageIfNeeded();

      // 尝试补一次迁移（如果已能拿到预设名）
      try { await refreshActivePresetName(false); } catch { /* ignore */ }
    } catch (e) {
      warn('Config load failed, using defaults:', e);
      config = createDefaultConfig();
      config.blockPresetUiRefreshOnToggle = true;

      // localStorage 兜底：即使整体配置加载失败，也尽量恢复快捷收藏栏 UI 状态 / 拖拽位置
      restoreQuickFavoritesUiStateFromLocalStorageIfNeeded();
      restoreQuickFavoritesPosFromLocalStorageIfNeeded();
      restoreQuickFavoritesEmbeddedIndexFromLocalStorageIfNeeded();
      restoreNoRefreshUiStateFromLocalStorageIfNeeded();
    }
  }

  async function saveConfig() {
    const ST_API = getSTApi();

    // 无论 variables.set 是否可用，都写一份 localStorage 兜底（主要解决“快捷收藏栏 UI 状态 / 拖拽位置不记忆”）
    persistQuickFavoritesUiStateToLocalStorage();
    persistQuickFavoritesPosToLocalStorage();
    persistQuickFavoritesEmbeddedIndexToLocalStorage();
    persistNoRefreshUiStateToLocalStorage();

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

  function refreshPromptManagerToolbarShortcutState() {
    const bar = promptManagerToolbarEl || document.getElementById('pmg-prompt-manager-toolbar');
    if (!(bar instanceof HTMLElement)) return;

    const btnGrouping = bar.querySelector('#pmg_toolbar_toggle_grouping');
    if (btnGrouping instanceof HTMLElement) {
      const enabled = !!config.groupingEnabled;
      btnGrouping.classList.toggle('pmg-toolbar-shortcut-active', enabled);
      btnGrouping.title = enabled ? '分组已启用（点击禁用分组）' : '分组已禁用（点击启用分组）';
      btnGrouping.setAttribute('aria-pressed', String(enabled));
    }

    const btnNativeDrag = bar.querySelector('#pmg_toolbar_toggle_native_drag');
    if (btnNativeDrag instanceof HTMLElement) {
      const disabled = !!config.disableNativeDragWhenGrouped;
      btnNativeDrag.classList.toggle('pmg-toolbar-shortcut-active', disabled);
      btnNativeDrag.innerHTML = disabled
        ? '<span class="pmg-toolbar-icon-stack"><i class="fa-solid fa-arrows-up-down"></i><i class="fa-solid fa-slash pmg-toolbar-shortcut-slash"></i></span>'
        : '<i class="fa-solid fa-arrows-up-down"></i>';
      btnNativeDrag.title = disabled
        ? '已禁用拖拽排序（点击允许拖拽）'
        : '允许拖拽排序（点击禁用拖拽，防止误触）';
      btnNativeDrag.setAttribute('aria-pressed', String(disabled));
    }
  }

  async function handlePromptManagerToolbarShortcutToggle(key) {
    if (key === 'grouping') {
      config.groupingEnabled = !config.groupingEnabled;
    } else if (key === 'nativeDrag') {
      config.disableNativeDragWhenGrouped = !config.disableNativeDragWhenGrouped;
    } else {
      return;
    }

    // “预设条目开关时阻止预设面板刷新”已作为默认行为，不再暴露给用户关闭。
    config.blockPresetUiRefreshOnToggle = true;
    await installPromptManagerNativePatch();
    applyNativeDragState(currentListEl);
    refreshPromptManagerToolbarShortcutState();
    await saveConfig();
    if (!requestPromptManagerNativeRender(false)) {
      debounceApply(`toolbar-${key}-toggle`, 0);
    }
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

      const btnNativeDrag = document.createElement('div');
      btnNativeDrag.id = 'pmg_toolbar_toggle_native_drag';
      btnNativeDrag.className = 'menu_button pmg-toolbar-shortcut-btn';
      btnNativeDrag.innerHTML = '<i class="fa-solid fa-arrows-up-down"></i>';
      btnNativeDrag.tabIndex = 0;
      btnNativeDrag.setAttribute('role', 'button');
      btnNativeDrag.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void handlePromptManagerToolbarShortcutToggle('nativeDrag');
      });
      btnNativeDrag.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          void handlePromptManagerToolbarShortcutToggle('nativeDrag');
        }
      });

      const btnGrouping = document.createElement('div');
      btnGrouping.id = 'pmg_toolbar_toggle_grouping';
      btnGrouping.className = 'menu_button pmg-toolbar-shortcut-btn';
      btnGrouping.innerHTML = '<i class="fa-solid fa-layer-group"></i>';
      btnGrouping.tabIndex = 0;
      btnGrouping.setAttribute('role', 'button');
      btnGrouping.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void handlePromptManagerToolbarShortcutToggle('grouping');
      });
      btnGrouping.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          void handlePromptManagerToolbarShortcutToggle('grouping');
        }
      });

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

      bar.appendChild(btnNativeDrag);
      bar.appendChild(btnGrouping);
      bar.appendChild(btnSettings);
      bar.appendChild(btnPrefix);
      promptManagerToolbarEl = bar;
    } else {
      promptManagerToolbarEl = bar;
    }
    refreshPromptManagerToolbarShortcutState();

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
      persistNoRefreshUiStateToLocalStorage();
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
      applyCurrentCollapseVisibility();
      persistNoRefreshUiStateToLocalStorage();
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
      persistNoRefreshUiStateToLocalStorage();
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

  function shouldDisableNativeDrag() {
    return !!config.disableNativeDragWhenGrouped;
  }

  function getPromptItemSelector(listEl) {
    const draggableClass = getNativeDraggableItemClass(listEl);
    return `.${draggableClass}`;
  }

  function getNativeDraggableItemClass(listEl) {
    const id = String(listEl?.id || 'completion_prompt_manager_list');
    if (id.endsWith('prompt_manager_list')) {
      return id.replace(/prompt_manager_list$/, 'prompt_manager_prompt_draggable');
    }
    return 'completion_prompt_manager_prompt_draggable';
  }

  function getNativePromptItemClass(listEl) {
    const id = String(listEl?.id || 'completion_prompt_manager_list');
    if (id.endsWith('prompt_manager_list')) {
      return id.replace(/prompt_manager_list$/, 'prompt_manager_prompt');
    }
    return 'completion_prompt_manager_prompt';
  }

  function setNativeDraggableItemClass(listEl, enabled) {
    if (!(listEl instanceof HTMLElement)) return;
    const draggableClass = getNativeDraggableItemClass(listEl);
    const promptClass = getNativePromptItemClass(listEl);
    for (const li of Array.from(listEl.querySelectorAll(`li.${promptClass}`))) {
      if (!(li instanceof HTMLElement)) continue;
      li.classList.toggle(draggableClass, !!enabled);
    }
  }

  function getSortableInstance($, listEl) {
    try {
      return $(listEl).data('ui-sortable') || $(listEl).data('sortable') || null;
    } catch {
      return null;
    }
  }

  function setSortableOptionsSafely($, listEl, options) {
    try {
      if (!getSortableInstance($, listEl)) return false;
      for (const [key, value] of Object.entries(options || {})) {
        try { $(listEl).sortable('option', key, value); } catch { /* ignore one option */ }
      }
      return true;
    } catch {
      return false;
    }
  }

  function installSortableDragPerformanceGuard($, listEl) {
    if (!(listEl instanceof HTMLElement)) return false;
    try {
      if (!getSortableInstance($, listEl)) return false;
    } catch {
      return false;
    }

    let originalStart = null;
    let originalStop = null;
    try { originalStart = $(listEl).sortable('option', 'start'); } catch { originalStart = null; }
    try { originalStop = $(listEl).sortable('option', 'stop'); } catch { originalStop = null; }

    // 避免反复包装 start/stop；若 sortable 被原生或其他插件重建，当前 option 会变回非 PMG 包装函数，届时会重新补挂。
    if (originalStart?.__pmgSortableDragPerformanceGuard && originalStop?.__pmgSortableDragPerformanceGuard) return true;

    originalStart = originalStart?.__pmgOriginalSortableCallback || originalStart;
    originalStop = originalStop?.__pmgOriginalSortableCallback || originalStop;

    const guardedStart = function pmgSortableDragPerformanceStart(event, ui) {
      beginPromptListDrag('native-sortable-start', { sortableStarted: true });
      if (typeof originalStart === 'function') {
        return originalStart.call(this, event, ui);
      }
    };
    guardedStart.__pmgSortableDragPerformanceGuard = true;
    guardedStart.__pmgOriginalSortableCallback = originalStart;

    const guardedStop = function pmgSortableDragPerformanceStop(event, ui) {
      try {
        if (typeof originalStop === 'function') {
          return originalStop.call(this, event, ui);
        }
      } finally {
        endPromptListDrag('native-sortable-stop');
      }
    };
    guardedStop.__pmgSortableDragPerformanceGuard = true;
    guardedStop.__pmgOriginalSortableCallback = originalStop;

    listEl.__pmgSortableDragPerformanceGuardInstalled = true;
    listEl.__pmgSortableOriginalStart = originalStart;
    listEl.__pmgSortableOriginalStop = originalStop;

    setSortableOptionsSafely($, listEl, {
      start: guardedStart,
      stop: guardedStop,
    });

    return true;
  }

  function installNativeDragEventGuard(listEl) {
    if (!(listEl instanceof HTMLElement)) return;
    if (listEl.__pmgNativeDragEventGuardInstalled) return;

    const isPromptDragStartCandidate = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      if (target.closest('.pmg-group-header')) return false;
      const promptClass = getNativePromptItemClass(listEl);
      const li = target.closest(`li.${promptClass}`);
      if (!li || !listEl.contains(li)) return false;

      // 操作按钮区域继续允许正常点击；这些元素本身不是排序入口。
      if (target.closest('.prompt_manager_prompt_controls')) return false;
      if (target.closest('.prompt-manager-toggle-action')) return false;
      if (target.closest('.prompt-manager-edit-action')) return false;
      if (target.closest('.prompt-manager-detach-action')) return false;
      if (target.closest('[data-pmg-role="item-fav"]')) return false;

      return true;
    };

    const onPromptDragStartCandidate = (event) => {
      if (!isPromptDragStartCandidate(event)) return;

      if (!shouldDisableNativeDrag()) {
        // sortable 真正 start 前会先产生 helper/placeholder 等早期 DOM 变化；提前进入保护态可消除拖拽起步卡顿。
        // markPending=false：普通点击不会在松手后触发额外重分组，只有后续 mutation 或 sortable start 才会刷新。
        beginPromptListDrag('prompt-pointer-down', { markPending: false });
        return;
      }

      // jQuery UI sortable 在列表元素上监听 mousedown/touchstart。
      // 捕获阶段阻断这些“拖拽起始事件”，可以避免 sortable 已初始化或后续被重启时仍然响应。
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    };

    listEl.addEventListener('pointerdown', onPromptDragStartCandidate, true);
    listEl.addEventListener('mousedown', onPromptDragStartCandidate, true);
    listEl.addEventListener('touchstart', onPromptDragStartCandidate, true);

    if (!document.__pmgPromptDragEndGuardInstalled) {
      document.addEventListener('pointerup', () => endPromptListDrag('prompt-pointer-up'), true);
      document.addEventListener('pointercancel', () => endPromptListDrag('prompt-pointer-cancel'), true);
      document.addEventListener('mouseup', () => endPromptListDrag('prompt-mouse-up'), true);
      document.addEventListener('touchend', () => endPromptListDrag('prompt-touch-end'), true);
      document.addEventListener('touchcancel', () => endPromptListDrag('prompt-touch-cancel'), true);
      window.addEventListener('blur', () => endPromptListDrag('prompt-window-blur'), true);
      document.__pmgPromptDragEndGuardInstalled = true;
    }

    listEl.__pmgNativeDragEventGuardInstalled = true;
    listEl.__pmgNativeDragEventGuard = onPromptDragStartCandidate;
  }

  function disableNativeSortable(listEl) {
    if (!(listEl instanceof HTMLElement)) return;
    installNativeDragEventGuard(listEl);

    // 始终加 fallback class：即使 jQuery sortable 已存在，也用 CSS 禁用 handle 的 pointer events。
    listEl.classList.add('pmg-no-native-drag');
    setNativeDraggableItemClass(listEl, false);

    listEl.dataset.pmgNativeDragDisabled = '1';
    delete listEl.dataset.pmgNativeDragEnabled;

    const $ = getJQuery();
    if ($ && typeof $(listEl).sortable === 'function') {
      try {
        if (getSortableInstance($, listEl)) {
          // 多重保险：
          // - disabled: true 阻止 sortable 捕获鼠标；
          // - items 指向不存在的选择器，避免 refresh 后仍找到可排序项；
          // - cancel: '*' 让所有子元素都不是可拖拽起点。
          setSortableOptionsSafely($, listEl, {
            disabled: true,
            items: '.pmg-native-drag-disabled-never',
            cancel: '*',
          });
          try { $(listEl).sortable('disable'); } catch { /* ignore */ }
          try { $(listEl).sortable('refresh'); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }

  function enableNativeSortable(listEl) {
    if (!(listEl instanceof HTMLElement)) return;
    listEl.classList.remove('pmg-no-native-drag');
    setNativeDraggableItemClass(listEl, true);

    delete listEl.dataset.pmgNativeDragDisabled;

    const $ = getJQuery();
    if ($ && typeof $(listEl).sortable === 'function') {
      try {
        if (getSortableInstance($, listEl)) {
          if (listEl.dataset.pmgNativeDragEnabled === '1') {
            installSortableDragPerformanceGuard($, listEl);
            return;
          }

          setSortableOptionsSafely($, listEl, {
            disabled: false,
            items: getPromptItemSelector(listEl),
            cancel: 'input, textarea, button, select, option, a, .prompt_manager_prompt_controls, .prompt-manager-toggle-action, .prompt-manager-edit-action, .prompt-manager-detach-action, [data-pmg-role="item-fav"]',
          });
          installSortableDragPerformanceGuard($, listEl);
          try { $(listEl).sortable('enable'); } catch { /* ignore */ }
          try { $(listEl).sortable('refresh'); } catch { /* ignore */ }
          listEl.dataset.pmgNativeDragEnabled = '1';
        }
      } catch { /* ignore */ }
    }
  }

  function applyNativeDragState(listEl = currentListEl) {
    if (!(listEl instanceof HTMLElement)) return;
    installNativeDragEventGuard(listEl);
    if (shouldDisableNativeDrag()) {
      disableNativeSortable(listEl);
    } else {
      enableNativeSortable(listEl);
    }
  }

  function applyCurrentCollapseVisibility() {
    applyCollapseVisibility();
  }

  function applyGrouping() {
    if (!currentListEl) return;
    const listEl = currentListEl;

    suppressOwnListMutations(220);

    removeInjectedGroupHeaders(listEl);
    cleanupPromptItemMarks(listEl);

    applyNativeDragState(listEl);

    const items = Array.from(listEl.children).filter(isPromptItemLi);

    if (config.favoritesEnabled) {
      for (const li of items) ensureItemFavoriteButton(li);
    } else {
      for (const li of items) removeItemFavoriteButton(li);
    }

    if (!config.groupingEnabled) {
      for (const li of items) restorePromptDisplayName(li);
      suppressOwnListMutations(120);
      applyCollapseVisibility();
      return;
    }

    let currentGroup1 = null;
    let currentGroup2 = null;

    const group1OccCount = {};
    const group2OccCount = {};
    let currentGroupId = null;
    const fragment = document.createDocumentFragment();

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
        fragment.appendChild(li);
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
        fragment.appendChild(header1);
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
          fragment.appendChild(header2);
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

      fragment.appendChild(li);
    }

    listEl.appendChild(fragment);
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
        persistNoRefreshUiStateToLocalStorage();
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
        persistNoRefreshUiStateToLocalStorage();
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
        persistNoRefreshUiStateToLocalStorage();
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
            persistNoRefreshUiStateToLocalStorage();
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
            persistNoRefreshUiStateToLocalStorage();
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
        persistNoRefreshUiStateToLocalStorage();
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
        persistNoRefreshUiStateToLocalStorage();
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
        persistNoRefreshUiStateToLocalStorage();
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
      persistNoRefreshUiStateToLocalStorage();
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
      persistQuickFavoritesPosToLocalStorage();
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
  const LS_KEY_FLOATING_UI_STATE = '__pmg_quick_favorites_ui_state_v1';
  // UI-only / shortcut states. Persisting these through ST_API.variables.set can
  // trigger SillyTavern settings update hooks and refresh Prompt Manager.
  const LS_KEY_NO_REFRESH_UI_STATE = '__pmg_no_refresh_ui_state_v1';

  function getNoRefreshUiStateSnapshot() {
    return {
      collapsed: config?.collapsed ?? { group1: [], group2: [] },
      collapsedByPreset: config?.collapsedByPreset ?? {},
      favorites: config?.favorites ?? { group1: [], group2: [], items: [] },
      favoritesByPreset: config?.favoritesByPreset ?? {},
      favoritesExpanded: config?.favoritesExpanded ?? { group1: [], group2: [] },
      favoritesExpandedByPreset: config?.favoritesExpandedByPreset ?? {},
      favoritesPanelExpanded: !!config?.favoritesPanelExpanded,
      nativePanelCollapsed: config?.nativePanelCollapsed ?? {},
      nativePresetFavorites: Array.isArray(config?.nativePresetFavorites) ? config.nativePresetFavorites : [],
    };
  }

  function persistNoRefreshUiStateToLocalStorage() {
    safeWriteLocalStorageJson(LS_KEY_NO_REFRESH_UI_STATE, getNoRefreshUiStateSnapshot());
  }

  function restoreNoRefreshUiStateFromLocalStorageIfNeeded() {
    try {
      if (!config || typeof config !== 'object') return;
      const v = safeReadLocalStorageJson(LS_KEY_NO_REFRESH_UI_STATE);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;

      if (v.collapsed && typeof v.collapsed === 'object' && !Array.isArray(v.collapsed)) {
        config.collapsed = ensureCollapsedShape(v.collapsed);
        config.collapsed.group1 = ensureArrayUnique(config.collapsed.group1);
        config.collapsed.group2 = ensureArrayUnique(config.collapsed.group2);
      }
      if (v.collapsedByPreset && typeof v.collapsedByPreset === 'object' && !Array.isArray(v.collapsedByPreset)) {
        config.collapsedByPreset = {};
        for (const [pn, st] of Object.entries(v.collapsedByPreset)) {
          const shaped = ensureCollapsedShape(st);
          shaped.group1 = ensureArrayUnique(shaped.group1);
          shaped.group2 = ensureArrayUnique(shaped.group2);
          config.collapsedByPreset[pn] = shaped;
        }
      }

      if (v.favorites && typeof v.favorites === 'object' && !Array.isArray(v.favorites)) {
        config.favorites = ensureFavoritesStoreShape(v.favorites);
        config.favorites.group1 = ensureArrayUnique(config.favorites.group1);
        config.favorites.group2 = ensureArrayUnique(config.favorites.group2);
        config.favorites.items = ensureArrayUnique(config.favorites.items);
      }
      if (v.favoritesByPreset && typeof v.favoritesByPreset === 'object' && !Array.isArray(v.favoritesByPreset)) {
        config.favoritesByPreset = {};
        for (const [pn, st] of Object.entries(v.favoritesByPreset)) {
          const shaped = ensureFavoritesStoreShape(st);
          shaped.group1 = ensureArrayUnique(shaped.group1);
          shaped.group2 = ensureArrayUnique(shaped.group2);
          shaped.items = ensureArrayUnique(shaped.items);
          config.favoritesByPreset[pn] = shaped;
        }
      }

      if (v.favoritesExpanded && typeof v.favoritesExpanded === 'object' && !Array.isArray(v.favoritesExpanded)) {
        config.favoritesExpanded = ensureFavoritesExpandedShape(v.favoritesExpanded);
        config.favoritesExpanded.group1 = ensureArrayUnique(config.favoritesExpanded.group1);
        config.favoritesExpanded.group2 = ensureArrayUnique(config.favoritesExpanded.group2);
      }
      if (v.favoritesExpandedByPreset && typeof v.favoritesExpandedByPreset === 'object' && !Array.isArray(v.favoritesExpandedByPreset)) {
        config.favoritesExpandedByPreset = {};
        for (const [pn, st] of Object.entries(v.favoritesExpandedByPreset)) {
          const shaped = ensureFavoritesExpandedShape(st);
          shaped.group1 = ensureArrayUnique(shaped.group1);
          shaped.group2 = ensureArrayUnique(shaped.group2);
          config.favoritesExpandedByPreset[pn] = shaped;
        }
      }

      if (typeof v.favoritesPanelExpanded === 'boolean') {
        config.favoritesPanelExpanded = v.favoritesPanelExpanded;
      }
      if (v.nativePanelCollapsed && typeof v.nativePanelCollapsed === 'object' && !Array.isArray(v.nativePanelCollapsed)) {
        config.nativePanelCollapsed = {};
        for (const [k, val] of Object.entries(v.nativePanelCollapsed)) {
          config.nativePanelCollapsed[String(k)] = !!val;
        }
      }
      if (Array.isArray(v.nativePresetFavorites)) {
        config.nativePresetFavorites = ensureArrayUnique(v.nativePresetFavorites).map(String).filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

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

  function persistQuickFavoritesUiStateToLocalStorage() {
    safeWriteLocalStorageJson(LS_KEY_FLOATING_UI_STATE, {
      floatingPanelExpanded: !!config?.floatingPanelExpanded,
      floatingPanelActiveTab: getFloatingPanelActiveTab(),
    });
  }

  function restoreQuickFavoritesUiStateFromLocalStorageIfNeeded() {
    try {
      if (!config || typeof config !== 'object') return;
      const v = safeReadLocalStorageJson(LS_KEY_FLOATING_UI_STATE);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;

      if (typeof v.floatingPanelExpanded === 'boolean') {
        config.floatingPanelExpanded = v.floatingPanelExpanded;
      }
      if (v.floatingPanelActiveTab === 'favorites' || v.floatingPanelActiveTab === 'presets') {
        config.floatingPanelActiveTab = v.floatingPanelActiveTab;
      }
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

    // 位置属于用户刚完成的拖拽结果，必须同步写入 localStorage 兜底。
    // 如果只依赖后续的 variables.set / 防抖保存，用户拖完立刻刷新时会偶发丢失。
    persistQuickFavoritesEmbeddedIndexToLocalStorage();
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
      persistQuickFavoritesEmbeddedIndexToLocalStorage();
    }, 250);
  }

  function flushQuickFavEmbeddedIndexSave() {
    if (quickFavEmbeddedSaveTimer) {
      clearTimeout(quickFavEmbeddedSaveTimer);
      quickFavEmbeddedSaveTimer = null;
    }

    persistQuickFavoritesEmbeddedIndexToLocalStorage();
  }

  let quickFavEmbeddedBeforeUnloadGuardInstalled = false;
  function ensureQuickFavEmbeddedBeforeUnloadGuard() {
    if (quickFavEmbeddedBeforeUnloadGuardInstalled) return;
    quickFavEmbeddedBeforeUnloadGuardInstalled = true;

    window.addEventListener('pagehide', flushQuickFavEmbeddedIndexSave, true);
    window.addEventListener('beforeunload', flushQuickFavEmbeddedIndexSave, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushQuickFavEmbeddedIndexSave();
    }, true);
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
    ensureQuickFavEmbeddedBeforeUnloadGuard();
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

    const tabs = document.createElement('div');
    tabs.className = 'pmg-floating-tabs';

    const makeTab = (tab, text, iconClass) => {
      const btn = document.createElement('span');
      btn.className = 'pmg-floating-tab interactable';
      btn.dataset.pmgFloatingTab = tab;
      btn.tabIndex = 0;
      btn.setAttribute('role', 'button');
      btn.innerHTML = `<i class="${iconClass}"></i><span>${text}</span>`;
      const activate = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        setFloatingPanelActiveTab(tab);
        refreshFloatingPanelTabs();
        renderFloatingFavoritesPanel();
        persistQuickFavoritesUiStateToLocalStorage();
      };
      btn.addEventListener('click', activate);
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') void activate(e);
      });
      return btn;
    };

    tabs.appendChild(makeTab('favorites', '快捷收藏栏', 'fa-solid fa-star'));
    tabs.appendChild(makeTab('presets', '收藏预设', 'fa-solid fa-layer-group'));
    header.appendChild(tabs);

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
        persistQuickFavoritesPosToLocalStorage();
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
      persistQuickFavoritesUiStateToLocalStorage();
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
        // 不拦截关闭/设置/页签按钮的点击
        const t = e.target;
        return t instanceof HTMLElement && (
          !!t.closest('.pmg-floating-close') ||
          !!t.closest('.pmg-floating-settings') ||
          !!t.closest('.pmg-floating-tab')
        );
      },
      onDragEnd: async (pos) => {
        config.floatingPanelPos = { ...pos, ...toRelativeFloatingPos(panel, pos) };
        persistQuickFavoritesPosToLocalStorage();
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

    refreshFloatingPanelTabs();

    const body = floatingPanelEl.querySelector('.pmg-floating-body');
    if (!body) return;

    const tab = getFloatingPanelActiveTab();
    if (tab === 'presets') {
      body.innerHTML = '';
      renderNativePresetFavoritesQuickSection(body, { showEmpty: true });
      return;
    }

    renderFavoritesContent(body);
  }

  function getFloatingPanelActiveTab() {
    const v = String(config?.floatingPanelActiveTab || 'favorites');
    return v === 'presets' ? 'presets' : 'favorites';
  }

  function setFloatingPanelActiveTab(tab) {
    config.floatingPanelActiveTab = tab === 'presets' ? 'presets' : 'favorites';
  }

  function refreshFloatingPanelTabs() {
    if (!floatingPanelEl) return;
    const active = getFloatingPanelActiveTab();
    for (const btn of Array.from(floatingPanelEl.querySelectorAll('.pmg-floating-tab'))) {
      if (!(btn instanceof HTMLElement)) continue;
      const on = btn.dataset.pmgFloatingTab === active;
      btn.classList.toggle('pmg-floating-tab-active', on);
      btn.setAttribute('aria-pressed', String(on));
      if (btn.dataset.pmgFloatingTab === 'favorites') {
        const pn = activePresetName ? `当前预设：${activePresetName}` : '收藏的提示词条目/分组';
        btn.title = pn;
      } else {
        btn.title = '已收藏的原生 OpenAI 预设';
      }
    }
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
  // Native OpenAI panel roll collapse
  //
  // 折叠 SillyTavern 原生预设界面（聊天补全设置面板）内若干常用区域。
  // 实现方式：不移动原生 DOM 节点，只在第一个目标区域前插入一个总折叠头，并统一控制多个原生 root 的可见性。
  // ---------------------------------------------------------------------------

  /** @typedef {{ id: string, title: string, anchor: () => HTMLElement|null, resolveRoot: (anchorEl: HTMLElement) => HTMLElement|null }} NativeCollapseRegion */

  const NATIVE_ROLL_REGION_ID = 'nativePresetRoll';

  /** @type {NativeCollapseRegion[]} */
  const NATIVE_PANEL_REGIONS = [
    {
      id: 'chatBehavior',
      title: '聊天行为与功能',
      anchor: () => document.getElementById('character_names_display'),
      resolveRoot: (anchorEl) => {
        // 锚点位于 Character Names Behavior inline-drawer 内；其外层 <div class=""> 是整块的容器。
        const drawer = anchorEl?.closest('.inline-drawer');
        if (!(drawer instanceof HTMLElement)) return null;
        const parent = drawer.parentElement;
        if (!(parent instanceof HTMLElement)) return null;
        return parent;
      },
    },
    {
      id: 'quickPrompts',
      title: '快速提示词编辑',
      anchor: () => document.getElementById('main_prompt_quick_edit_textarea'),
      resolveRoot: (anchorEl) => {
        const drawer = anchorEl?.closest('.inline-drawer');
        return drawer instanceof HTMLElement ? drawer : null;
      },
    },
    {
      id: 'utilityPrompts',
      title: '实用提示词',
      anchor: () => document.getElementById('impersonation_prompt_textarea'),
      resolveRoot: (anchorEl) => {
        const drawer = anchorEl?.closest('.inline-drawer');
        return drawer instanceof HTMLElement ? drawer : null;
      },
    },
    {
      id: 'seed',
      title: 'Seed（随机种子）',
      anchor: () => document.getElementById('seed_openai'),
      resolveRoot: (anchorEl) => {
        const block = anchorEl?.closest('.range-block');
        return block instanceof HTMLElement ? block : null;
      },
    },
    {
      id: 'logitBias',
      title: 'Logit Bias（词符偏置）',
      anchor: () => document.getElementById('logit_bias_openai'),
      resolveRoot: (anchorEl) => {
        // logit_bias_openai 本身是 range-block 的内部 title div，需要往上找到 range-block 容器
        const block = anchorEl?.closest('.range-block');
        return block instanceof HTMLElement ? block : null;
      },
    },
  ];

  const NATIVE_COLLAPSE_HEADER_CLASS = 'pmg-native-collapse-header';
  const NATIVE_COLLAPSE_ROOT_ATTR = 'data-pmg-native-collapse-root';
  const NATIVE_COLLAPSE_HEADER_ATTR = 'data-pmg-native-collapse-header';
  const NATIVE_COLLAPSE_ANIMATION_MS = 140;

  let nativePanelCollapseScanTimer = null;
  let nativePanelCollapseRetryTimer = null;
  let nativePanelCollapseRetryUntil = 0;

  function ensureNativePanelCollapsedShape() {
    if (!config.nativePanelCollapsed || typeof config.nativePanelCollapsed !== 'object' || Array.isArray(config.nativePanelCollapsed)) {
      config.nativePanelCollapsed = {};
    }
  }

  function isNativeRollCollapsed() {
    ensureNativePanelCollapsedShape();
    return !!config.nativePanelCollapsed[NATIVE_ROLL_REGION_ID];
  }

  function setNativeRollCollapsed(collapsed) {
    ensureNativePanelCollapsedShape();
    config.nativePanelCollapsed[NATIVE_ROLL_REGION_ID] = !!collapsed;
  }

  function collectNativeCollapseRoots() {
    const roots = [];

    for (const region of NATIVE_PANEL_REGIONS) {
      const anchorEl = typeof region.anchor === 'function' ? region.anchor() : null;
      if (!(anchorEl instanceof HTMLElement)) continue;
      const rootEl = region.resolveRoot ? region.resolveRoot(anchorEl) : null;
      if (!(rootEl instanceof HTMLElement)) continue;
      if (!document.body.contains(rootEl)) continue;
      if (roots.includes(rootEl)) continue;
      roots.push(rootEl);
    }

    // 如果某个 root 已经包含另一个 root，只保留外层，避免重复动画/重复 display 控制。
    const deduped = roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));

    // 按 DOM 顺序排序，确保总折叠头插入在最靠前的目标区域前。
    deduped.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      return 0;
    });

    return deduped;
  }

  function getNativeRootOriginalDisplay(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return '';
    return typeof rootEl.dataset.pmgOriginalDisplay === 'string' ? rootEl.dataset.pmgOriginalDisplay : '';
  }

  function restoreNativeRootDisplay(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return;
    if (rootEl.__pmgNativeCollapseAnimation) {
      try { rootEl.__pmgNativeCollapseAnimation.cancel(); } catch { /* ignore */ }
      rootEl.__pmgNativeCollapseAnimation = null;
    }
    // 只有 PMG 曾经记录过 display 时才恢复；否则不要动原生 display。
    // 这样可以避免把 SillyTavern 根据 data-source / 当前模型源隐藏的块误显示出来。
    if (!('pmgOriginalDisplay' in rootEl.dataset)) return;
    const orig = rootEl.dataset.pmgOriginalDisplay || '';
    if (orig) rootEl.style.display = orig;
    else rootEl.style.removeProperty('display');
  }

  function hideNativeRootImmediately(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return;
    if (!('pmgOriginalDisplay' in rootEl.dataset)) {
      rootEl.dataset.pmgOriginalDisplay = rootEl.style.display || '';
    }
    rootEl.style.setProperty('display', 'none', 'important');
    rootEl.style.removeProperty('max-height');
    rootEl.style.removeProperty('overflow');
    rootEl.style.removeProperty('opacity');
    rootEl.style.removeProperty('transition');
    rootEl.style.removeProperty('transform');
    rootEl.style.removeProperty('transform-origin');
    rootEl.style.removeProperty('will-change');
    rootEl.style.removeProperty('clip-path');
    if (rootEl.__pmgNativeCollapseAnimation) {
      rootEl.__pmgNativeCollapseAnimation = null;
    }
  }

  function showNativeRootImmediately(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return;
    restoreNativeRootDisplay(rootEl);
    rootEl.style.removeProperty('max-height');
    rootEl.style.removeProperty('overflow');
    rootEl.style.removeProperty('opacity');
    rootEl.style.removeProperty('transition');
    rootEl.style.removeProperty('transform');
    rootEl.style.removeProperty('transform-origin');
    rootEl.style.removeProperty('will-change');
    rootEl.style.removeProperty('clip-path');
    if (rootEl.__pmgNativeCollapseAnimation) {
      rootEl.__pmgNativeCollapseAnimation = null;
    }
  }

  function animateNativeRootVisibility(rootEl, collapsed) {
    if (!(rootEl instanceof HTMLElement)) return;

    if (rootEl.__pmgNativeCollapseAnimation) {
      try { rootEl.__pmgNativeCollapseAnimation.cancel(); } catch { /* ignore */ }
      rootEl.__pmgNativeCollapseAnimation = null;
    }

    // 重要：不要用 scaleY 来“收起”。transform 不改变布局占位，会导致内容视觉消失但页面留下一大片空白。
    // 收起时直接 display:none，保证不占位；展开时再做一个不影响布局的轻量淡入动画。
    if (collapsed) {
      hideNativeRootImmediately(rootEl);
      return;
    }

    const prefersReducedMotion = (() => {
      try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { return false; }
    })();

    // 展开时做轻量 opacity/translateY 动画：不测量 scrollHeight，也不会留下折叠空白。
    if (!rootEl.animate || prefersReducedMotion) {
      showNativeRootImmediately(rootEl);
      return;
    }

    const token = String(Date.now()) + Math.random().toString(36).slice(2);
    rootEl.dataset.pmgNativeCollapseAnimationToken = token;

    const timing = {
      duration: NATIVE_COLLAPSE_ANIMATION_MS,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'both',
    };

    restoreNativeRootDisplay(rootEl);
    rootEl.style.removeProperty('max-height');
    rootEl.style.removeProperty('clip-path');
    rootEl.style.removeProperty('transition');
    rootEl.style.removeProperty('transform-origin');
    rootEl.style.willChange = 'transform, opacity';

    // 如果原生逻辑仍然要求隐藏（例如 data-source 不匹配），不要强行动画显示。
    if (getComputedStyle(rootEl).display === 'none') {
      delete rootEl.dataset.pmgNativeCollapseAnimationToken;
      return;
    }

    const anim = rootEl.animate([
      { transform: 'translateY(-4px)', opacity: 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ], timing);
    rootEl.__pmgNativeCollapseAnimation = anim;
    anim.onfinish = () => {
      if (rootEl.dataset.pmgNativeCollapseAnimationToken !== token) return;
      rootEl.style.removeProperty('transform');
      rootEl.style.removeProperty('opacity');
      rootEl.style.removeProperty('will-change');
      rootEl.style.removeProperty('overflow');
      rootEl.__pmgNativeCollapseAnimation = null;
      delete rootEl.dataset.pmgNativeCollapseAnimationToken;
    };
    anim.oncancel = () => {
      if (rootEl.dataset.pmgNativeCollapseAnimationToken === token) delete rootEl.dataset.pmgNativeCollapseAnimationToken;
      rootEl.style.removeProperty('will-change');
      rootEl.__pmgNativeCollapseAnimation = null;
    };
  }

  function applyNativeRollVisualState(headerEl, rootEls, collapsed, options = {}) {
    if (!(headerEl instanceof HTMLElement)) return;
    const roots = Array.isArray(rootEls) ? rootEls.filter((x) => x instanceof HTMLElement) : [];
    const arrow = headerEl.querySelector('.pmg-native-collapse-icon');
    if (arrow) {
      arrow.classList.toggle('fa-chevron-right', collapsed);
      arrow.classList.toggle('fa-chevron-down', !collapsed);
    }
    headerEl.classList.toggle('pmg-native-collapsed', !!collapsed);
    headerEl.setAttribute('aria-expanded', String(!collapsed));

    const animated = !!options.animated;
    for (const rootEl of roots) {
      rootEl.setAttribute(NATIVE_COLLAPSE_ROOT_ATTR, NATIVE_ROLL_REGION_ID);
      if (animated) animateNativeRootVisibility(rootEl, collapsed);
      else if (collapsed) hideNativeRootImmediately(rootEl);
      else showNativeRootImmediately(rootEl);
    }
  }

  function createNativeCollapseHeader(rootEls) {
    const header = document.createElement('div');
    header.className = NATIVE_COLLAPSE_HEADER_CLASS;
    header.setAttribute(NATIVE_COLLAPSE_HEADER_ATTR, NATIVE_ROLL_REGION_ID);
    header.tabIndex = 0;
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(!isNativeRollCollapsed()));

    const arrow = document.createElement('span');
    arrow.className = 'pmg-native-collapse-icon fa-solid fa-chevron-down';

    const title = document.createElement('span');
    title.className = 'pmg-native-collapse-title';
    title.textContent = '其它设置';

    const hint = document.createElement('small');
    hint.className = 'pmg-native-collapse-hint';
    hint.textContent = '思维链 / 发送文件 / Seed ...';

    header.appendChild(arrow);
    header.appendChild(title);
    header.appendChild(hint);

    const onToggle = async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const roots = collectNativeCollapseRoots();
      const next = !isNativeRollCollapsed();
      setNativeRollCollapsed(next);
      applyNativeRollVisualState(header, roots.length ? roots : rootEls, next, { animated: true });
      persistNoRefreshUiStateToLocalStorage();
    };

    header.addEventListener('click', onToggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onToggle(e);
    });

    return header;
  }

  function removeStaleNativeCollapseHeadersExceptRoll() {
    const headers = document.querySelectorAll(`.${NATIVE_COLLAPSE_HEADER_CLASS}`);
    for (const h of Array.from(headers)) {
      if (!(h instanceof HTMLElement)) continue;
      if (h.getAttribute(NATIVE_COLLAPSE_HEADER_ATTR) !== NATIVE_ROLL_REGION_ID) h.remove();
    }
  }

  function attachNativeCollapseRoll() {
    if (!config.nativePanelCollapseEnabled) return false;

    removeStaleNativeCollapseHeadersExceptRoll();

    const roots = collectNativeCollapseRoots();
    if (roots.length === 0) return false;

    const rootSet = new Set(roots);

    // 清理已消失或不再属于统一卷轴的旧 root 标记，同时恢复其显示。
    for (const r of Array.from(document.querySelectorAll(`[${NATIVE_COLLAPSE_ROOT_ATTR}]`))) {
      if (!(r instanceof HTMLElement)) continue;
      if (rootSet.has(r)) continue;
      const orig = r.dataset.pmgOriginalDisplay;
      if (typeof orig === 'string') {
        if (orig) r.style.display = orig;
        else r.style.removeProperty('display');
        delete r.dataset.pmgOriginalDisplay;
      } else {
        r.style.removeProperty('display');
      }
      r.removeAttribute(NATIVE_COLLAPSE_ROOT_ATTR);
    }

    let header = document.querySelector(`.${NATIVE_COLLAPSE_HEADER_CLASS}[${NATIVE_COLLAPSE_HEADER_ATTR}="${NATIVE_ROLL_REGION_ID}"]`);
    if (!(header instanceof HTMLElement)) {
      header = createNativeCollapseHeader(roots);
    }

    const firstRoot = roots[0];
    if (firstRoot.parentElement && header.nextElementSibling !== firstRoot) {
      firstRoot.parentElement.insertBefore(header, firstRoot);
    }

    for (const rootEl of roots) {
      rootEl.setAttribute(NATIVE_COLLAPSE_ROOT_ATTR, NATIVE_ROLL_REGION_ID);
    }

    applyNativeRollVisualState(header, roots, isNativeRollCollapsed(), { animated: false });
    return true;
  }

  function scanAndAttachNativeCollapse() {
    if (!config.nativePanelCollapseEnabled) {
      teardownNativePanelCollapse();
      return false;
    }
    try {
      return attachNativeCollapseRoll();
    } catch (e) {
      warn('attachNativeCollapseRoll failed:', e);
      return false;
    }
  }

  function debounceScanNativePanelCollapse(delayMs = 80) {
    if (nativePanelCollapseScanTimer) clearTimeout(nativePanelCollapseScanTimer);
    nativePanelCollapseScanTimer = setTimeout(() => {
      nativePanelCollapseScanTimer = null;
      scanAndAttachNativeCollapse();
    }, delayMs);
  }

  function scheduleNativePanelCollapseRetry(durationMs = 8000, intervalMs = 300) {
    if (!config.nativePanelCollapseEnabled) return;

    nativePanelCollapseRetryUntil = Math.max(nativePanelCollapseRetryUntil, Date.now() + durationMs);
    if (nativePanelCollapseRetryTimer) return;

    const tick = () => {
      nativePanelCollapseRetryTimer = null;
      if (!config.nativePanelCollapseEnabled) return;

      const attached = scanAndAttachNativeCollapse();
      const headerExists = !!document.querySelector(`.${NATIVE_COLLAPSE_HEADER_CLASS}[${NATIVE_COLLAPSE_HEADER_ATTR}="${NATIVE_ROLL_REGION_ID}"]`);

      // 右侧设置面板 / 预设设置 DOM 常常是异步分批渲染的：
      // 初次扫描可能找不到全部 anchor，或 header 刚插入又被原生 render 覆盖。
      // 因此在页面刷新、预设切换、body 大量变化后短时间重试，直到 header 稳定存在或超时。
      if ((!attached || !headerExists) && Date.now() < nativePanelCollapseRetryUntil) {
        nativePanelCollapseRetryTimer = setTimeout(tick, intervalMs);
      }
    };

    nativePanelCollapseRetryTimer = setTimeout(tick, 0);
  }

  function teardownNativePanelCollapse() {
    if (nativePanelCollapseRetryTimer) {
      clearTimeout(nativePanelCollapseRetryTimer);
      nativePanelCollapseRetryTimer = null;
    }
    nativePanelCollapseRetryUntil = 0;
    // 移除已注入的统一卷轴 header；恢复每个 root 的 display。
    const headers = document.querySelectorAll(`.${NATIVE_COLLAPSE_HEADER_CLASS}`);
    for (const h of Array.from(headers)) {
      if (h instanceof HTMLElement) h.remove();
    }
    const roots = document.querySelectorAll(`[${NATIVE_COLLAPSE_ROOT_ATTR}]`);
    for (const r of Array.from(roots)) {
      if (!(r instanceof HTMLElement)) continue;
      const orig = r.dataset.pmgOriginalDisplay;
      if (typeof orig === 'string') {
        if (orig) r.style.display = orig;
        else r.style.removeProperty('display');
        delete r.dataset.pmgOriginalDisplay;
      } else {
        r.style.removeProperty('display');
      }
      r.style.removeProperty('max-height');
      r.style.removeProperty('overflow');
      r.style.removeProperty('opacity');
      r.style.removeProperty('transition');
      delete r.dataset.pmgNativeCollapseAnimationToken;
      r.removeAttribute(NATIVE_COLLAPSE_ROOT_ATTR);
    }
  }


  // ---------------------------------------------------------------------------
  // Native OpenAI preset select enhancement
  //
  // 增强酒馆原生预设选择下拉栏：
  // - 收藏预设置顶（不修改 option.text，避免破坏原生按 text 读取预设名的逻辑）
  // - 在独立管理弹窗中对任意预设执行改名 / 导出 / 删除 / 另存为，不需要先切换到该预设
  // ---------------------------------------------------------------------------

  const NATIVE_PRESET_SELECT_ID = 'settings_preset_openai';
  const NATIVE_PRESET_TOOLBAR_ID = 'pmg-native-preset-toolbar';
  const NATIVE_PRESET_MODAL_ID = 'pmg-native-preset-manager-modal';
  const NATIVE_PRESET_FAVORITES_GROUP_LABEL = '⭐ 收藏预设';
  const NATIVE_PRESET_OTHERS_GROUP_LABEL = '全部预设';

  /** @type {MutationObserver|null} */
  let nativePresetSelectObserver = null;
  /** @type {HTMLElement|null} */
  let nativePresetManagerModalEl = null;
  let nativePresetDepsPromise = null;
  let nativePresetReorderTimer = null;
  let nativePresetManagerSearchQuery = '';

  const NATIVE_PRESET_SENSITIVE_FIELDS = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
  ];

  function findNativePresetSelect() {
    return document.getElementById(NATIVE_PRESET_SELECT_ID);
  }

  async function getNativePresetDeps() {
    if (nativePresetDepsPromise) return nativePresetDepsPromise;
    nativePresetDepsPromise = (async () => {
      const [presetManagerMod, openaiMod, scriptMod, utilsMod, templatesMod, popupMod] = await Promise.all([
        import('/scripts/preset-manager.js'),
        import('/scripts/openai.js'),
        import('/script.js'),
        import('/scripts/utils.js'),
        import('/scripts/templates.js'),
        import('/scripts/popup.js'),
      ]);
      return {
        getPresetManager: presetManagerMod.getPresetManager,
        openaiMod,
        getRequestHeaders: scriptMod.getRequestHeaders,
        saveSettingsDebounced: scriptMod.saveSettingsDebounced,
        eventSource: scriptMod.eventSource,
        event_types: scriptMod.event_types,
        download: utilsMod.download,
        getSanitizedFilename: utilsMod.getSanitizedFilename,
        renderTemplateAsync: templatesMod.renderTemplateAsync,
        Popup: popupMod.Popup,
        POPUP_TYPE: popupMod.POPUP_TYPE,
        POPUP_RESULT: popupMod.POPUP_RESULT,
      };
    })();
    return nativePresetDepsPromise;
  }

  function getNativePresetFavoriteSet() {
    config.nativePresetFavorites = Array.isArray(config.nativePresetFavorites)
      ? ensureArrayUnique(config.nativePresetFavorites).map(String).filter(Boolean)
      : [];
    return new Set(config.nativePresetFavorites);
  }

  function isNativePresetFavorite(name) {
    return getNativePresetFavoriteSet().has(String(name || ''));
  }

  async function toggleNativePresetFavorite(name, options = {}) {
    const key = String(name || '').trim();
    if (!key) return;
    const set = getNativePresetFavoriteSet();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    config.nativePresetFavorites = Array.from(set);
    persistNoRefreshUiStateToLocalStorage();

    // 关键：收藏/取消收藏预设时不要立即重排 #settings_preset_openai。
    // 重排 select 会重建 option/optgroup，容易触发 SillyTavern 原生 OpenAI 设置面板联动刷新。
    // 默认只更新收藏状态和插件自身 UI，行为与快捷收藏栏一致：点星标不切预设、不刷新请求页。
    if (options?.refreshSelect) {
      scheduleNativePresetSelectEnhance(0);
    }
  }

  async function switchNativePresetByName(name) {
    const key = String(name || '').trim();
    if (!key) return false;

    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) {
      window.toastr?.warning?.('未找到原生 OpenAI 预设下拉栏');
      return false;
    }

    const option = Array.from(select.querySelectorAll('option'))
      .find((opt) => getNativePresetOptionName(opt) === key);
    if (!(option instanceof HTMLOptionElement)) {
      window.toastr?.warning?.(`预设不存在或尚未加载：${key}`);
      return false;
    }

    const before = getNativePresetCurrentName();
    if (before === key) {
      refreshNativePresetToolbarState();
      renderAllFavoritesPanels();
      return true;
    }

    option.selected = true;
    select.value = option.value;

    const jq = getJQuery();
    if (typeof jq === 'function') {
      try {
        jq(select).trigger('change');
      } catch {
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    activePresetName = key;
    refreshNativePresetToolbarState();
    scheduleNativePresetSelectEnhance(80);

    // 原生 change 会异步刷新 Prompt Manager；这里延迟同步收藏栏标题和提示词收藏范围。
    setTimeout(() => {
      void refreshActivePresetName(true).finally(() => {
        renderAllFavoritesPanels();
        debounceApply('native-preset-quick-switch', 0);
      });
    }, 180);

    window.toastr?.success?.(`已切换预设：${key}`);
    return true;
  }

  function renderNativePresetFavoritesQuickSection(body, options = {}) {
    if (!(body instanceof HTMLElement)) return false;
    const showEmpty = !!options.showEmpty;

    const appendEmpty = (text) => {
      if (!showEmpty) return false;
      const empty = document.createElement('div');
      empty.className = 'pmg-fav-empty';
      empty.textContent = text;
      body.appendChild(empty);
      return true;
    };

    const favNamesRaw = ensureArrayUnique(
      Array.isArray(config.nativePresetFavorites) ? config.nativePresetFavorites : []
    ).map(String).map((x) => x.trim()).filter(Boolean);
    if (favNamesRaw.length === 0) return appendEmpty('暂无收藏预设（可在原生预设下拉栏旁点击 ⭐ 收藏）');

    const presetOptions = getNativePresetOptions();
    if (presetOptions.length > 0) {
      cleanupNativePresetFavoritesByOptions(presetOptions);
    }

    const optionNameSet = new Set(presetOptions.map((x) => x.name));
    const favNames = presetOptions.length > 0
      ? favNamesRaw.filter((name) => optionNameSet.has(name))
      : favNamesRaw;
    if (favNames.length === 0) return appendEmpty('收藏的预设不存在或尚未加载');

    const currentName = getNativePresetCurrentName();

    const section = document.createElement('div');
    section.className = 'pmg-fav-section pmg-native-preset-quick-section';

    for (const presetName of favNames) {
      const row = document.createElement('div');
      row.className = 'pmg-fav-row pmg-native-preset-quick-row';
      row.classList.toggle('pmg-native-preset-quick-current', presetName === currentName);
      row.title = presetName === currentName ? `当前预设：${presetName}` : `切换到预设：${presetName}`;

      const icon = document.createElement('span');
      icon.className = presetName === currentName
        ? 'pmg-native-preset-quick-icon fa-solid fa-circle-check'
        : 'pmg-native-preset-quick-icon fa-solid fa-wand-magic-sparkles';

      const rowTitle = document.createElement('div');
      rowTitle.className = 'pmg-fav-title pmg-native-preset-quick-title';
      rowTitle.textContent = presetName;

      const btnSwitch = document.createElement('span');
      btnSwitch.className = presetName === currentName
        ? 'pmg-native-preset-quick-switch fa-solid fa-check interactable'
        : 'pmg-native-preset-quick-switch fa-solid fa-right-to-bracket interactable';
      btnSwitch.title = presetName === currentName ? '当前正在使用' : '切换到此预设';
      btnSwitch.tabIndex = 0;
      btnSwitch.setAttribute('role', 'button');

      const btnUnfav = document.createElement('span');
      btnUnfav.className = 'pmg-fav-unfav fa-solid fa-star fa-xs interactable pmg-fav-on';
      btnUnfav.title = '取消收藏此预设';
      btnUnfav.tabIndex = 0;
      btnUnfav.setAttribute('role', 'button');

      const doSwitch = async (e) => {
        if (e?.preventDefault) e.preventDefault();
        if (e?.stopPropagation) e.stopPropagation();
        await switchNativePresetByName(presetName);
      };

      row.addEventListener('click', (e) => {
        const t = e.target;
        if (t instanceof HTMLElement && t.closest('.pmg-fav-unfav')) return;
        void doSwitch(e);
      });
      btnSwitch.addEventListener('click', doSwitch);
      btnSwitch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') void doSwitch(e);
      });

      btnUnfav.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleNativePresetFavorite(presetName);
        renderAllFavoritesPanels();
      });
      btnUnfav.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') btnUnfav.click();
      });

      row.appendChild(icon);
      row.appendChild(rowTitle);
      row.appendChild(btnSwitch);
      row.appendChild(btnUnfav);
      section.appendChild(row);
    }

    body.appendChild(section);
    return true;
  }

  function getNativePresetOptionName(option) {
    return String(option?.textContent || '').trim();
  }

  function getNativePresetCurrentName() {
    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return '';
    return getNativePresetOptionName(select.selectedOptions?.[0]);
  }

  function getNativePresetOptions(select = findNativePresetSelect()) {
    if (!(select instanceof HTMLSelectElement)) return [];
    return Array.from(select.querySelectorAll('option'))
      .filter((opt) => opt instanceof HTMLOptionElement)
      .map((opt) => ({
        option: opt,
        name: getNativePresetOptionName(opt),
        value: String(opt.value ?? ''),
        disabled: !!opt.disabled,
        isGui: String(opt.value ?? '') === 'gui',
      }))
      .filter((x) => x.name);
  }

  function cleanupNativePresetFavoritesByOptions(options) {
    const validNames = new Set((options || []).map((x) => x.name));
    const prev = Array.isArray(config.nativePresetFavorites) ? config.nativePresetFavorites : [];
    const next = ensureArrayUnique(prev.map(String).filter((x) => x && validNames.has(x)));
    const changed = next.length !== prev.length || next.some((x, i) => x !== prev[i]);
    config.nativePresetFavorites = next;
    if (changed) persistNoRefreshUiStateToLocalStorage();
  }

  function applyNativePresetSelectOrder() {
    if (!config.nativePresetEnhancedEnabled) return;
    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.dataset.pmgNativePresetReordering === '1') return;

    const options = getNativePresetOptions(select);
    if (options.length === 0) return;
    cleanupNativePresetFavoritesByOptions(options);

    const selectedValue = select.value;
    const favSet = getNativePresetFavoriteSet();
    const favOptions = [];
    const otherOptions = [];

    for (const info of options) {
      info.option.classList.toggle('pmg-native-preset-favorite-option', favSet.has(info.name));
      info.option.title = favSet.has(info.name) ? `⭐ ${info.name}` : info.name;
      if (favSet.has(info.name)) favOptions.push(info.option);
      else otherOptions.push(info.option);
    }

    try {
      select.dataset.pmgNativePresetReordering = '1';
      select.innerHTML = '';

      if (favOptions.length > 0) {
        const favGroup = document.createElement('optgroup');
        favGroup.label = NATIVE_PRESET_FAVORITES_GROUP_LABEL;
        for (const opt of favOptions) favGroup.appendChild(opt);
        select.appendChild(favGroup);

        const otherGroup = document.createElement('optgroup');
        otherGroup.label = NATIVE_PRESET_OTHERS_GROUP_LABEL;
        for (const opt of otherOptions) otherGroup.appendChild(opt);
        select.appendChild(otherGroup);
      } else {
        for (const opt of otherOptions) select.appendChild(opt);
      }

      select.value = selectedValue;
      refreshNativePresetToolbarState();
    } finally {
      delete select.dataset.pmgNativePresetReordering;
    }
  }

  function teardownNativePresetSelectEnhancer() {
    nativePresetSelectObserver?.disconnect();
    nativePresetSelectObserver = null;
    document.getElementById(NATIVE_PRESET_TOOLBAR_ID)?.remove();

    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return;

    const selectedValue = select.value;
    const options = getNativePresetOptions(select)
      .map((x) => x.option)
      .sort((a, b) => {
        const av = String(a.value ?? '');
        const bv = String(b.value ?? '');
        if (av === 'gui') return -1;
        if (bv === 'gui') return 1;
        const an = Number(av);
        const bn = Number(bv);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return getNativePresetOptionName(a).localeCompare(getNativePresetOptionName(b));
      });

    try {
      select.dataset.pmgNativePresetReordering = '1';
      select.innerHTML = '';
      for (const opt of options) {
        opt.classList.remove('pmg-native-preset-favorite-option');
        opt.title = getNativePresetOptionName(opt);
        select.appendChild(opt);
      }
      select.value = selectedValue;
      delete select.dataset.pmgNativePresetEnhancerAttached;
    } finally {
      delete select.dataset.pmgNativePresetReordering;
    }
  }

  function refreshNativePresetToolbarState() {
    const toolbar = document.getElementById(NATIVE_PRESET_TOOLBAR_ID);
    if (!(toolbar instanceof HTMLElement)) return;
    const currentName = getNativePresetCurrentName();
    const star = toolbar.querySelector('[data-pmg-native-preset-action="toggle-current-favorite"]');
    if (star instanceof HTMLElement) {
      const fav = isNativePresetFavorite(currentName);
      star.classList.toggle('pmg-native-preset-current-fav-on', fav);
      star.classList.toggle('pmg-native-preset-current-fav-off', !fav);
      star.title = fav ? `取消置顶收藏：${currentName}` : `置顶收藏当前预设：${currentName}`;
      star.setAttribute('aria-pressed', String(fav));
    }
  }

  function ensureNativePresetToolbar() {
    if (!config.nativePresetEnhancedEnabled) {
      document.getElementById(NATIVE_PRESET_TOOLBAR_ID)?.remove();
      return;
    }

    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return;
    const host = select.closest('.flex-container') || select.parentElement;
    if (!(host instanceof HTMLElement)) return;

    let toolbar = document.getElementById(NATIVE_PRESET_TOOLBAR_ID);
    if (!(toolbar instanceof HTMLElement)) {
      toolbar = document.createElement('div');
      toolbar.id = NATIVE_PRESET_TOOLBAR_ID;
      toolbar.className = 'pmg-native-preset-toolbar flex-container flexNoGap';

      const star = document.createElement('div');
      star.className = 'menu_button menu_button_icon pmg-native-preset-current-fav-off';
      star.setAttribute('data-pmg-native-preset-action', 'toggle-current-favorite');
      star.setAttribute('role', 'button');
      star.tabIndex = 0;
      star.innerHTML = '<i class="fa-fw fa-solid fa-star"></i>';
      const toggleCurrent = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const name = getNativePresetCurrentName();
        if (!name) return;
        await toggleNativePresetFavorite(name);
        refreshNativePresetToolbarState();
        renderNativePresetManagerIfOpen();
        renderAllFavoritesPanels();
      };
      star.addEventListener('click', toggleCurrent);
      star.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') void toggleCurrent(e);
      });

      const manager = document.createElement('div');
      manager.className = 'menu_button menu_button_icon';
      manager.title = '管理预设（改名 / 导出 / 删除 / 另存为）';
      manager.setAttribute('data-pmg-native-preset-action', 'open-manager');
      manager.setAttribute('role', 'button');
      manager.tabIndex = 0;
      manager.innerHTML = '<i class="fa-fw fa-solid fa-list-check"></i>';
      const open = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openNativePresetManager();
      };
      manager.addEventListener('click', open);
      manager.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      });

      toolbar.appendChild(star);
      toolbar.appendChild(manager);
    }

    if (toolbar.parentElement !== host) {
      host.appendChild(toolbar);
    }

    refreshNativePresetToolbarState();
  }

  function scheduleNativePresetSelectEnhance(delayMs = 80) {
    if (nativePresetReorderTimer) clearTimeout(nativePresetReorderTimer);
    nativePresetReorderTimer = setTimeout(() => {
      nativePresetReorderTimer = null;
      try {
        ensureNativePresetToolbar();
        applyNativePresetSelectOrder();
      } catch (e) {
        warn('Native preset select enhance failed:', e);
      }
    }, delayMs);
  }

  function attachNativePresetSelectEnhancer() {
    if (!config.nativePresetEnhancedEnabled) {
      teardownNativePresetSelectEnhancer();
      return false;
    }
    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return false;

    let shouldInitialEnhance = false;

    if (select.dataset.pmgNativePresetEnhancerAttached !== '1') {
      select.addEventListener('change', () => {
        refreshNativePresetToolbarState();
        scheduleNativePresetSelectEnhance(80);
        if (config.nativePanelCollapseEnabled) {
          debounceScanNativePanelCollapse(120);
          scheduleNativePanelCollapseRetry(5000, 300);
        }
      });
      select.dataset.pmgNativePresetEnhancerAttached = '1';
      shouldInitialEnhance = true;
    }

    if (!nativePresetSelectObserver || nativePresetSelectObserver.__pmgTarget !== select) {
      nativePresetSelectObserver?.disconnect();
      nativePresetSelectObserver = new MutationObserver(() => {
        if (select.dataset.pmgNativePresetReordering === '1') return;
        scheduleNativePresetSelectEnhance(80);
      });
      nativePresetSelectObserver.__pmgTarget = select;
      nativePresetSelectObserver.observe(select, { childList: true, subtree: true, characterData: true });
      shouldInitialEnhance = true;
    }

    if (shouldInitialEnhance) {
      scheduleNativePresetSelectEnhance(0);
    }
    return true;
  }

  function getOpenAiPresetIndex(openaiMod, name) {
    const map = openaiMod?.openai_setting_names;
    if (!map || typeof map !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
  }

  async function getOpenAiPresetDataByName(name) {
    const { openaiMod } = await getNativePresetDeps();
    const idx = getOpenAiPresetIndex(openaiMod, name);
    if (idx === undefined || idx === null) throw new Error(`预设不存在：${name}`);
    const preset = openaiMod.openai_settings?.[idx];
    if (!preset || typeof preset !== 'object') throw new Error(`预设数据不可用：${name}`);
    return safeJsonClone(preset);
  }

  async function saveOpenAiPresetData(name, preset) {
    const deps = await getNativePresetDeps();
    const response = await fetch('/api/presets/save', {
      method: 'POST',
      headers: deps.getRequestHeaders(),
      body: JSON.stringify({ apiId: 'openai', name, preset }),
    });
    if (!response.ok) throw new Error('保存预设失败');
    const data = await response.json().catch(() => ({}));
    return String(data?.name || name);
  }

  async function deleteOpenAiPresetFromServer(name) {
    const deps = await getNativePresetDeps();
    const response = await fetch('/api/presets/delete', {
      method: 'POST',
      headers: deps.getRequestHeaders(),
      body: JSON.stringify({ apiId: 'openai', name }),
    });
    return response.ok;
  }

  function upsertNativePresetOption(name, index, selected = false) {
    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return;
    let option = Array.from(select.querySelectorAll('option')).find((opt) => getNativePresetOptionName(opt) === name);
    if (!(option instanceof HTMLOptionElement)) {
      option = document.createElement('option');
      select.appendChild(option);
    }
    option.value = String(index);
    option.text = String(name);
    option.selected = !!selected;
  }

  function removeNativePresetOptionByName(name) {
    const select = findNativePresetSelect();
    if (!(select instanceof HTMLSelectElement)) return;
    for (const opt of Array.from(select.querySelectorAll('option'))) {
      if (getNativePresetOptionName(opt) === name) opt.remove();
    }
  }

  async function nativePresetRename(oldName, requestedNewName) {
    const deps = await getNativePresetDeps();
    let newName = String(requestedNewName || '').trim();
    if (typeof deps.getSanitizedFilename === 'function') {
      newName = await deps.getSanitizedFilename(newName);
    }
    newName = String(newName || '').trim();
    if (!newName || oldName === newName) return;
    if (getOpenAiPresetIndex(deps.openaiMod, newName) !== undefined) throw new Error('同名预设已存在');

    const preset = await getOpenAiPresetDataByName(oldName);
    await deps.eventSource?.emit?.(deps.event_types?.PRESET_RENAMED_BEFORE, { apiId: 'openai', oldName, newName });
    const savedName = await saveOpenAiPresetData(newName, preset);
    const oldIdx = getOpenAiPresetIndex(deps.openaiMod, oldName);
    if (oldIdx === undefined || oldIdx === null) throw new Error('旧预设索引丢失');

    deps.openaiMod.openai_settings[oldIdx] = preset;
    delete deps.openaiMod.openai_setting_names[oldName];
    deps.openaiMod.openai_setting_names[savedName] = oldIdx;

    const select = findNativePresetSelect();
    const oldOption = Array.from(select?.querySelectorAll?.('option') || []).find((opt) => getNativePresetOptionName(opt) === oldName);
    if (oldOption instanceof HTMLOptionElement) oldOption.text = savedName;

    if (deps.openaiMod.oai_settings?.preset_settings_openai === oldName) {
      deps.openaiMod.oai_settings.preset_settings_openai = savedName;
      if (oldOption instanceof HTMLOptionElement) oldOption.selected = true;
      deps.saveSettingsDebounced?.();
    }

    await deleteOpenAiPresetFromServer(oldName);
    config.nativePresetFavorites = (config.nativePresetFavorites || []).map((x) => x === oldName ? savedName : x);
    await saveConfig();
    await deps.eventSource?.emit?.(deps.event_types?.PRESET_RENAMED, { apiId: 'openai', oldName, newName: savedName });
    window.toastr?.success?.('预设已改名');
    scheduleNativePresetSelectEnhance(0);
  }

  async function nativePresetSaveAs(sourceName, requestedName) {
    const deps = await getNativePresetDeps();
    let newName = String(requestedName || '').trim();
    if (typeof deps.getSanitizedFilename === 'function') {
      newName = await deps.getSanitizedFilename(newName);
    }
    newName = String(newName || '').trim();
    if (!newName) return;

    const preset = await getOpenAiPresetDataByName(sourceName);
    const existingIdx = getOpenAiPresetIndex(deps.openaiMod, newName);
    if (existingIdx !== undefined && !confirm(`预设“${newName}”已存在。是否覆盖？`)) return;

    const savedName = await saveOpenAiPresetData(newName, preset);
    let idx = getOpenAiPresetIndex(deps.openaiMod, savedName);
    if (idx !== undefined) {
      deps.openaiMod.openai_settings[idx] = preset;
    } else if (existingIdx !== undefined) {
      idx = existingIdx;
      deps.openaiMod.openai_settings[idx] = preset;
      deps.openaiMod.openai_setting_names[savedName] = idx;
    } else {
      deps.openaiMod.openai_settings.push(preset);
      idx = deps.openaiMod.openai_settings.length - 1;
      deps.openaiMod.openai_setting_names[savedName] = idx;
    }
    upsertNativePresetOption(savedName, idx, false);
    window.toastr?.success?.('预设已另存为');
    scheduleNativePresetSelectEnhance(0);
  }

  async function nativePresetExport(name) {
    const deps = await getNativePresetDeps();
    const preset = await getOpenAiPresetDataByName(name);
    const Popup = deps.Popup || window.Popup;
    const POPUP_TYPE = deps.POPUP_TYPE || window.POPUP_TYPE;
    const POPUP_RESULT = deps.POPUP_RESULT || window.POPUP_RESULT || { AFFIRMATIVE: 1, CANCELLED: 0 };

    const sensitive = NATIVE_PRESET_SENSITIVE_FIELDS.filter((field) => preset[field]);
    if (sensitive.length > 0 && Popup?.show?.confirm) {
      const textHeader = '此预设包含代理或自定义端点设置';
      const textMessage = [
        '<div>是否在导出前移除这些字段？</div>',
        '<br>',
        sensitive.map((field) => `<b>${escapeHtmlLocal(field)}</b>`).join('<br>'),
      ].join('');
      const cancelButton = { text: '取消导出', result: POPUP_RESULT.CANCELLED, appendAtEnd: true };
      const popupOptions = { customButtons: [cancelButton], okButton: '移除后导出', cancelButton: '保留并导出' };
      const popupResult = await Popup.show.confirm(textHeader, textMessage, popupOptions);

      if (popupResult === POPUP_RESULT.CANCELLED) {
        return;
      }

      if (popupResult === POPUP_RESULT.AFFIRMATIVE || popupResult === true) {
        for (const field of NATIVE_PRESET_SENSITIVE_FIELDS) delete preset[field];
      }
    } else if (sensitive.length > 0 && confirm(`预设包含代理或自定义端点字段：\n${sensitive.join('\n')}\n\n是否在导出前移除这些敏感字段？`)) {
      for (const field of NATIVE_PRESET_SENSITIVE_FIELDS) delete preset[field];
    }

    // 复用酒馆原生导出窗口模板（public/scripts/openai.js 的 onExportPresetClick 同款 exportPreset 模板）
    let removeConnectionData = false;
    if (typeof deps.renderTemplateAsync === 'function' && Popup && POPUP_TYPE) {
      const jq = getJQuery();
      if (typeof jq === 'function') {
        const exportConnectionTemplate = jq(await deps.renderTemplateAsync('exportPreset'));
        await new Popup(exportConnectionTemplate, POPUP_TYPE.TEXT).show();
        removeConnectionData = exportConnectionTemplate.find('input[name="export_connection_data"]:checked').val() === 'false';
      }
    } else {
      removeConnectionData = confirm('是否移除连接相关设置后导出？\n（选择“确定”=更适合分享；“取消”=完整导出）');
    }

    if (removeConnectionData) {
      const settingsToUpdate = deps.openaiMod?.settingsToUpdate || {};
      for (const [, tuple] of Object.entries(settingsToUpdate)) {
        const settingName = tuple?.[1];
        const isConnection = !!tuple?.[3];
        if (settingName && isConnection) delete preset[settingName];
      }
    }

    await deps.eventSource?.emit?.(deps.event_types?.OAI_PRESET_EXPORT_READY, preset);
    const json = JSON.stringify(preset, null, 4);
    const filename = `${String(name || 'preset')}.json`;
    if (typeof deps.download === 'function') {
      deps.download(json, filename, 'application/json');
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  }

  async function nativePresetDelete(name) {
    const deps = await getNativePresetDeps();
    if (!confirm(`确认删除预设“${name}”？\n此操作不可逆。`)) return;
    const selectedName = getNativePresetCurrentName();
    const ok = await deleteOpenAiPresetFromServer(name);
    if (!ok) throw new Error('服务器删除失败');

    delete deps.openaiMod.openai_setting_names[name];
    removeNativePresetOptionByName(name);
    config.nativePresetFavorites = (config.nativePresetFavorites || []).filter((x) => x !== name);
    await saveConfig();

    if (selectedName === name) {
      const select = findNativePresetSelect();
      const next = select?.querySelector?.('option');
      if (select instanceof HTMLSelectElement && next instanceof HTMLOptionElement) {
        next.selected = true;
        deps.openaiMod.oai_settings.preset_settings_openai = getNativePresetOptionName(next);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    await deps.eventSource?.emit?.(deps.event_types?.PRESET_DELETED, { apiId: 'openai', name });
    deps.saveSettingsDebounced?.();
    window.toastr?.success?.('预设已删除');
    scheduleNativePresetSelectEnhance(0);
  }

  function renderNativePresetManagerIfOpen() {
    const modal = nativePresetManagerModalEl || document.getElementById(NATIVE_PRESET_MODAL_ID);
    if (!(modal instanceof HTMLElement) || modal.classList.contains('pmg-hidden')) return;
    const body = getModalBody(modal);
    if (body) renderNativePresetManagerUI(body);
  }

  function ensureNativePresetManagerHeaderHint() {
    const modal = nativePresetManagerModalEl || document.getElementById(NATIVE_PRESET_MODAL_ID);
    if (!(modal instanceof HTMLElement)) return;
    const header = modal.querySelector('.pmg-modal-header');
    const close = modal.querySelector('.pmg-modal-close');
    if (!(header instanceof HTMLElement)) return;

    let hint = header.querySelector('.pmg-native-preset-manager-title-hint');
    if (!(hint instanceof HTMLElement)) {
      hint = document.createElement('small');
      hint.className = 'pmg-native-preset-manager-title-hint';
      if (close instanceof HTMLElement) header.insertBefore(hint, close);
      else header.appendChild(hint);
    }
    hint.textContent = '⭐ 收藏会在选择栏置顶';
  }

  function openNativePresetManager() {
    nativePresetManagerModalEl = ensureModalBase(NATIVE_PRESET_MODAL_ID);
    const body = getModalBody(nativePresetManagerModalEl);
    if (body) renderNativePresetManagerUI(body);
    showModal(nativePresetManagerModalEl, '预设管理');
    ensureNativePresetManagerHeaderHint();
  }

  function normalizeNativePresetSearchText(value) {
    return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  function isNativePresetFuzzyMatch(text, query) {
    const haystack = normalizeNativePresetSearchText(text);
    const needle = normalizeNativePresetSearchText(query);
    if (!needle) return true;
    if (!haystack) return false;

    const terms = needle.split(' ').filter(Boolean);
    return terms.every((term) => {
      if (haystack.includes(term)) return true;
      let j = 0;
      for (let i = 0; i < haystack.length && j < term.length; i++) {
        if (haystack[i] === term[j]) j++;
      }
      return j === term.length;
    });
  }

  function applyNativePresetManagerSearchFilter(listEl, query) {
    if (!(listEl instanceof HTMLElement)) return;
    const rows = Array.from(listEl.querySelectorAll('.pmg-native-preset-row'));
    let visibleCount = 0;
    for (const row of rows) {
      if (!(row instanceof HTMLElement)) continue;
      const name = row.dataset.pmgPresetName || '';
      const visible = isNativePresetFuzzyMatch(name, query);
      row.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    }

    let empty = listEl.querySelector('.pmg-native-preset-search-empty');
    if (visibleCount === 0 && rows.length > 0) {
      if (!(empty instanceof HTMLElement)) {
        empty = document.createElement('div');
        empty.className = 'pmg-fav-empty pmg-native-preset-search-empty';
        listEl.appendChild(empty);
      }
      empty.textContent = '没有匹配的预设';
      empty.style.display = '';
    } else if (empty instanceof HTMLElement) {
      empty.style.display = 'none';
    }
  }

  function renderNativePresetManagerUI(container) {
    const options = getNativePresetOptions();
    const currentName = getNativePresetCurrentName();
    const existingSearch = container.querySelector('[data-pmg-native-preset-search]');
    if (existingSearch instanceof HTMLInputElement) {
      nativePresetManagerSearchQuery = existingSearch.value;
    }
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'pmg-native-preset-manager';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'pmg-native-preset-manager-search-wrap';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'text_pole pmg-native-preset-manager-search';
    searchInput.placeholder = '搜索预设（支持模糊搜索）';
    searchInput.value = nativePresetManagerSearchQuery || '';
    searchInput.setAttribute('data-pmg-native-preset-search', '1');
    searchWrap.appendChild(searchInput);
    wrap.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'pmg-native-preset-manager-list';

    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmg-fav-empty';
      empty.textContent = '未找到 OpenAI 预设列表';
      list.appendChild(empty);
    }

    for (const info of options) {
      const row = document.createElement('div');
      row.className = 'pmg-native-preset-row';
      row.dataset.pmgPresetName = info.name;
      if (info.name === currentName) row.classList.add('pmg-native-preset-row-current');

      const star = document.createElement('span');
      star.className = 'pmg-native-preset-row-star fa-solid fa-star interactable';
      star.title = isNativePresetFavorite(info.name) ? '取消置顶收藏' : '置顶收藏';
      star.classList.toggle('pmg-fav-on', isNativePresetFavorite(info.name));
      star.classList.toggle('pmg-fav-off', !isNativePresetFavorite(info.name));
      star.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleNativePresetFavorite(info.name);
        nativePresetManagerSearchQuery = searchInput.value;
        renderNativePresetManagerUI(container);
      });

      const title = document.createElement('div');
      title.className = 'pmg-native-preset-row-title';
      title.textContent = info.name;
      title.title = info.name;
      if (info.name === currentName) {
        const badge = document.createElement('small');
        badge.className = 'pmg-native-preset-current-badge';
        badge.textContent = '当前';
        title.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'pmg-native-preset-row-actions';

      const addBtn = (label, titleText, cls, fn) => {
        const btn = document.createElement('div');
        btn.className = `menu_button ${cls || ''}`.trim();
        btn.textContent = label;
        btn.title = titleText;
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            await fn();
            renderNativePresetManagerIfOpen();
          } catch (err) {
            warn('Native preset action failed:', err);
            window.toastr?.error?.(String(err?.message || err));
          }
        });
        actions.appendChild(btn);
      };

      addBtn('改名', '不切换预设，直接改名此预设', '', async () => {
        const newName = prompt('输入新的预设名：', info.name);
        if (!newName) return;
        await nativePresetRename(info.name, newName);
      });
      addBtn('导出', '导出此预设', '', async () => nativePresetExport(info.name));
      addBtn('另存为', '以此预设为源另存为新预设', '', async () => {
        const newName = prompt('另存为预设名：', `${info.name} - copy`);
        if (!newName) return;
        await nativePresetSaveAs(info.name, newName);
      });
      addBtn('删除', '删除此预设', 'caution', async () => nativePresetDelete(info.name));

      row.appendChild(star);
      row.appendChild(title);
      row.appendChild(actions);
      list.appendChild(row);
    }

    wrap.appendChild(list);
    container.appendChild(wrap);

    searchInput.addEventListener('input', () => {
      nativePresetManagerSearchQuery = searchInput.value;
      applyNativePresetManagerSearchFilter(list, nativePresetManagerSearchQuery);
    });
    applyNativePresetManagerSearchFilter(list, nativePresetManagerSearchQuery);
  }


  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  function renderSettingsUI(container) {
    container.innerHTML = `
<div class="pmg-settings">
  <div class="pmg-settings-intro">
    <small>
      如有建议或者bug, 欢迎反馈! 反馈discord帖子链接→ <a href="https://discord.com/channels/1134557553011998840/1476440866091438091" target="_blank" rel="noopener noreferrer">预设折叠插件</a>
      <br>在GitHub提issue也行！链接→ <a href="https://github.com/qianzhuowo/ST-Prompt-Manager-Grouping" target="_blank" rel="noopener noreferrer">GitHub插件链接</a>
    </small>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title-row">
      <div class="pmg-settings-section-title">📁 分组</div>
      <label class="pmg-main-toggle-button">
        <input type="checkbox" id="pmg_grouping_enabled">
        <span>启用分组</span>
      </label>
    </div>

    <div class="pmg-settings-subsection">
      <div class="pmg-settings-subsection-title">更多分组选项</div>
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

    <div class="pmg-settings-subsection">
      <div class="pmg-settings-subsection-title">前缀解析规则</div>
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

    <div class="pmg-settings-subsection pmg-settings-hint">
      <div class="pmg-settings-subsection-title">命名示例 / 帮助</div>
      <small>
        1）<code>【常用】阡濯自制</code> → 一级组：<code>常用</code><br>
        2）<code>文生图-测试1</code> → 一级组：<code>文生图</code><br>
        3）<code>文生图-【常用】测试2</code> → 组：<code>文生图 / 常用</code><br>
        4）<code>【文生图】常用-测试3</code> → 组：<code>文生图 / 常用</code><br>
        5）<code>常用=测试4</code> → 一级组：<code>常用</code>（需启用自定义分隔符）<br>
        6）<code>「常用」测试5</code> → 一级组：<code>常用</code>（需启用自定义包裹前缀）<br>
      </small>
    </div>

  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title-row">
      <div class="pmg-settings-section-title">↕️ 拖拽排序</div>
    </div>

    <div class="pmg-settings-subsection">
      <div class="pmg-settings-row">
        <label class="checkbox_label">
          <input type="checkbox" id="pmg_disable_native_drag">
          <span>防止误触功能 - 禁用拖拽预设条目</span>
        </label>
      </div>
    </div>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title-row">
      <div class="pmg-settings-section-title">🗂️ 原生预设界面区域折叠</div>
      <label class="pmg-main-toggle-button">
        <input type="checkbox" id="pmg_native_panel_collapse_enabled">
        <span>启用区域折叠</span>
      </label>
    </div>

    <div class="pmg-settings-subsection pmg-settings-hint">
      <small>
        启用后，会在聊天补全设置面板内插入一个折叠头，可以折叠酒馆以下区域：<br>
        • 聊天行为与功能（角色名称 / 继续后缀 / 联网搜索 / 函数调用 / 推理强度 等）<br>
        • 快速提示词编辑<br>
        • 实用提示词<br>
        • Seed（随机种子）<br>
        • Logit Bias（词符偏置）<br>
        点击这个折叠头时，上述区域会像卷轴一样整体展开或收起，状态会自动记忆。
      </small>
    </div>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title-row">
      <div class="pmg-settings-section-title">⭐ 原生预设下拉栏增强</div>
      <label class="pmg-main-toggle-button">
        <input type="checkbox" id="pmg_native_preset_enhanced_enabled">
        <span>启用增强</span>
      </label>
    </div>

    <div class="pmg-settings-subsection pmg-settings-hint">
      <small>
        启用后：<br>
        • 可以把常用预设置顶收藏/快速切换；<br>
        • 可以打开“预设管理”弹窗，对任意预设执行改名 / 导出 / 删除 / 另存为，无需先切换到该预设。<br>
      </small>
    </div>
  </div>

  <div class="pmg-settings-section">
    <div class="pmg-settings-section-title-row">
      <div class="pmg-settings-section-title">⭐ 收藏 / 快捷栏</div>
      <label class="pmg-main-toggle-button">
        <input type="checkbox" id="pmg_favorites_enabled">
        <span>启用收藏（提示词条目右侧显示\u2B50）</span>
      </label>
    </div>

    <div class="pmg-settings-subsection">
      <div class="pmg-settings-subsection-title">更多收藏选项</div>
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
    const elDisableNativeDrag = $('#pmg_disable_native_drag');
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
    const elFavExpandDefault = $('#pmg_favorites_expand_default');
    const btnApply = $('#pmg_btn_apply');
    const btnClear = $('#pmg_btn_clear_fav');
    const elNativePanelCollapse = $('#pmg_native_panel_collapse_enabled');
    const elNativePresetEnhanced = $('#pmg_native_preset_enhanced_enabled');

    const syncToUI = () => {
      if (elGrouping) elGrouping.checked = !!config.groupingEnabled;
      if (elSecond) elSecond.checked = !!config.secondLevelEnabled;
      if (elHide) elHide.checked = !!config.hidePrefixes;
      if (elDisableNativeDrag) elDisableNativeDrag.checked = !!config.disableNativeDragWhenGrouped;
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
      if (elFavExpandDefault) elFavExpandDefault.checked = !!config.favoritesExpandGroupsByDefault;
      if (elNativePanelCollapse) elNativePanelCollapse.checked = !!config.nativePanelCollapseEnabled;
      if (elNativePresetEnhanced) elNativePresetEnhanced.checked = !!config.nativePresetEnhancedEnabled;

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
      config.disableNativeDragWhenGrouped = !!elDisableNativeDrag?.checked;
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
      config.blockPresetUiRefreshOnToggle = true;
      config.favoritesExpandGroupsByDefault = !!elFavExpandDefault?.checked;

      await installPromptManagerNativePatch();
      applyNativeDragState(currentListEl);

      updateFloatingPanelVisibility();
      syncToUI();
      refreshPromptManagerToolbarShortcutState();
      await saveConfig();
      if (!requestPromptManagerNativeRender(false)) {
        debounceApply('settings-changed', 0);
      }
    };

    elGrouping?.addEventListener('change', onChange);
    elSecond?.addEventListener('change', onChange);
    elHide?.addEventListener('change', onChange);
    elDisableNativeDrag?.addEventListener('change', onChange);
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
    elFavExpandDefault?.addEventListener('change', onChange);

    btnApply?.addEventListener('click', () => debounceApply('manual-apply', 0));

    // ----- 原生预设界面区域折叠 -----
    elNativePanelCollapse?.addEventListener('change', async () => {
      config.nativePanelCollapseEnabled = !!elNativePanelCollapse.checked;
      if (config.nativePanelCollapseEnabled) {
        scanAndAttachNativeCollapse();
        scheduleNativePanelCollapseRetry(6000, 250);
      } else {
        teardownNativePanelCollapse();
      }
      syncToUI();
      await saveConfig();
    });

    elNativePresetEnhanced?.addEventListener('change', async () => {
      config.nativePresetEnhancedEnabled = !!elNativePresetEnhanced.checked;
      if (config.nativePresetEnhancedEnabled) {
        attachNativePresetSelectEnhancer();
        scheduleNativePresetSelectEnhance(0);
      } else {
        teardownNativePresetSelectEnhancer();
      }
      await saveConfig();
    });

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
      persistNoRefreshUiStateToLocalStorage();
      debounceApply('clear-fav', 0);
    });

    syncToUI();
    return () => { };
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
      if (isOwnListMutationSuppressed()) {
        return;
      }

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
      if (shouldApply) {
        if (promptListDragActive) {
          markApplyPendingAfterPromptDrag('list-mutation');
          return;
        }
        debounceApply('list-mutation', 60);
      }
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
    if (typeof renderPatchState !== 'undefined' && renderPatchState?.installed) {
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

      // 原生预设界面区域折叠：每次 body mutation 时去扫一遍，确保抽屉 / range-block 重新挂载后仍然被折叠头包裹
      if (config.nativePanelCollapseEnabled) {
        debounceScanNativePanelCollapse(120);
        scheduleNativePanelCollapseRetry(2500, 350);
      }
      attachNativePresetSelectEnhancer();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    const list = findPromptManagerList();
    if (list) attachToList(list);
    attachNativePresetSelectEnhancer();
    if (config.nativePanelCollapseEnabled) {
      scheduleNativePanelCollapseRetry(8000, 300);
    }
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

      const forceRegroup = forceRegroupAfterPromptDrag;
      forceRegroupAfterPromptDrag = false;

      if (!config.groupingEnabled) {
        delete currentListEl.dataset.pmgNativeRendered;
        applyGrouping();
      } else if (currentListEl.dataset.pmgNativeRendered === '1') {
        if (forceRegroup) {
          applyGrouping();
        } else {
          applyNativeDragState(currentListEl);
          applyCollapseVisibility();
        }
      } else {
        applyGrouping();
      }

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

    try { await installPromptManagerNativePatch(); } catch { /* ignore */ }

    try { await unregisterSettingsPanelEntry(); } catch { /* ignore */ }

    updateFloatingPanelVisibility();
    startBodyObserver();
    debounceApply('init', 0);

    // 原生预设界面区域折叠：初始扫描一次（实际生效依赖目标 DOM 已渲染，否则由 body observer 兜底）
    debounceScanNativePanelCollapse(0);
    scheduleNativePanelCollapseRetry(12000, 300);

    // 原生 OpenAI 预设下拉栏增强：收藏置顶 + 不切换管理操作
    attachNativePresetSelectEnhancer();

    log('Initialized');
  }

  init();
})();
