(() => {
  "use strict";

  /* =========================================================
     项目雷达 Project Scan · 前端应用逻辑
     数据：GET /api/projects + EventSource /api/events
     离线：?mock=1 时读取 ./mock-projects.json
     ========================================================= */

  const ACCENTS = ["lime", "sky", "amber", "violet", "rose", "teal"];
  const ACCENT_COLORS = {
    lime: "#a9c46a",
    sky: "#7fa6c9",
    amber: "#c9a468",
    violet: "#9b8fc7",
    rose: "#c98f9b",
    teal: "#7fb5ac",
  };
  const KIND_LABELS = {
    node: "Node 项目",
    static: "静态页面",
    godot: "Godot 项目",
    python: "Python 项目",
    xcode: "Xcode 项目",
    gradle: "Gradle 项目",
    assets: "素材目录",
    docs: "文档目录",
    unknown: "目录",
  };
  const SOURCE_LABELS = {
    files: "文件修改",
    git: "Git 提交",
    dir: "目录本身",
  };
  const ARROW_ICON =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHILDREN_ICON =
    '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="1.5" y="1.75" width="9" height="2.5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="6.75" width="9" height="2.5" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>';
  const FOLDER_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6L7.5 4.6h5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const CHEVRON_ICON =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK_ICON =
    '<svg class="filter-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2 6.5 2.5 2.5L10 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const EYE_OPEN_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6"/></svg>';
  const EYE_CLOSED_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 10.2c2.2 2.3 5.1 3.5 8.5 3.5s6.3-1.2 8.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5.3 13.2 4 16M9.6 14.5l-.6 3M14.4 14.5l.6 3M18.7 13.2 20 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const MOCK = new URLSearchParams(window.location.search).get("mock") === "1";
  const IS_HTTP = /^https?:$/.test(window.location.protocol);

  /* ?mock=1 时的示例 DSH 渠道（保存只做本地演示，不发请求） */
  const MOCK_LLM_CHANNELS = {
    selection: null,
    effective: {
      source: "default",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      channelName: "OpenCode Go",
      api: "openai-completions",
      keyConfigured: true,
      keyMasked: "oc_s…9kTZ",
      baseUrlHost: "opencode.ai",
    },
    channels: [
      {
        id: "opencode-go",
        name: "OpenCode Go",
        api: "openai-completions",
        keyConfigured: true,
        keyMasked: "oc_s…9kTZ",
        keySource: "dsh-credentials",
        models: [
          { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash ×0.125" },
          { id: "kimi-k2", name: "Kimi K2" },
        ],
        defaultModel: "deepseek-v4.1-flash",
        reason: null,
      },
      {
        id: "opencode-zen",
        name: "OpenCode Zen",
        api: "openai-completions",
        keyConfigured: false,
        keyMasked: "",
        keySource: "",
        models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
        defaultModel: "claude-sonnet-4",
        reason: "DSH 中未找到可用 API key",
      },
    ],
    dsh: { home: "~/.dsh", found: true },
  };

  /* 设置弹层 tab */
  const SETTINGS_TABS = ["monitor", "llm", "hidden", "update"];
  const UPDATE_TOAST_KEY = "project-scan.update-toast";

  /* ?mock=1 时的更新演示状态（不发请求） */
  const MOCK_UPDATE_STATUS = {
    enabled: true,
    checking: false,
    lastCheckedAt: null,
    lastResult: {
      status: "up-to-date",
      message: "演示模式：已是最新版本",
      changedFiles: [],
      needRestart: false,
      needRefresh: false,
      onlyStyle: false,
    },
  };

  const state = {
    projects: [],
    meta: null,
    query: "",
    sort: "updated",
    tag: "all",
    phase: "loading",
    error: "",
    scanning: false,
    sse: null,
    sseState: "idle",
    heroRevealed: false,
    entranceDone: false,
    mockRuns: new Map(),
    pollTimer: null,
    scanFallback: null,
    lastFocus1: null,
    lastFocus2: null,
    workspaces: [],
    workspacesLimit: 8,
    workspaceFilter: "all",
    wsModalOpen: false,
    wsMenuOpen: false,
    wsConfirmId: null,
    wsConfirmTimer: null,
    wsError: "",
    fsPickerOpen: false,
    fsPath: "",
    fsRealPath: "",
    fsParent: null,
    fsHome: "",
    fsIsRoot: false,
    fsEntries: [],
    fsLoading: false,
    fsError: "",
    mockFs: null,
    lastFocusWs: null,
    lastFocusFs: null,
    statusFilter: "available",
    settingsOpen: false,
    settingsQuery: "",
    settingsError: "",
    hiddenSaving: new Map(),
    lastFocusSettings: null,
    monitorEnabled: false,
    monitorIntervalMs: 1000,
    monitor: null,
    monitorTimer: null,
    monitorInFlight: false,
    monitorError: "",
    monitorSaving: false,
    mockMonitorTimer: null,
    mockMonitorTick: 0,
    mockSettings: null,
    settingsLoaded: false,
    llmChannels: [],
    llmSelection: null,
    llmEffective: null,
    llmLoaded: false,
    llmLoading: false,
    llmLoadFailed: false,
    llmError: "",
    llmSaving: false,
    llmEnabled: true,
    llmEnabledSaving: false,
    llmEnabledError: "",
    settingsTab: "monitor",
    autoUpdate: true,
    updateStatus: null,
    updateStatusLoaded: false,
    updateLoading: false,
    updateSaving: false,
    updateChecking: false,
    updateCheckMessage: "",
    updateError: "",
    updatePollTimer: null,
    mockUpdateStatus: null,
    mockUnsupported: false,
    runningOpen: false,
    runningData: null,
    runningLoaded: false,
    runningTimer: null,
    runningBusy: new Set(),
    runningError: "",
    runningIncludeScanner: false,
    stopAllConfirm: false,
    stopAllTimer: null,
    lastFocusRunning: null,
    runningRefreshTimer: null,
  };

  const els = {};

  /* ---------- 客户端错误日志（便于自检） ---------- */

  function logClientError(message) {
    const el = document.getElementById("js-error-log");
    if (el) el.textContent += "JSERR: " + message + "\n";
  }

  window.addEventListener("error", (event) => {
    logClientError((event && event.message) || "unknown error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event ? event.reason : null;
    logClientError(reason && reason.message ? reason.message : String(reason));
  });

  /* ---------- 工具函数 ---------- */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function attrEsc(value) {
    return String(value == null ? "" : value).replace(/["\\]/g, "\\$&");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function formatClock(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--";
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  function formatAbsolute(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.getMonth() + 1 + "月" + date.getDate() + "日 " + formatClock(date);
  }

  function formatRelative(value, nowValue) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const diff = now.getTime() - date.getTime();
    if (diff < MINUTE) return "刚刚";
    if (diff < HOUR) return Math.floor(diff / MINUTE) + " 分钟前";
    if (diff < DAY) return Math.floor(diff / HOUR) + " 小时前";
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (sameDay(date, yesterday)) return "昨天 " + formatClock(date);
    if (date.getFullYear() === now.getFullYear()) {
      return date.getMonth() + 1 + "月" + date.getDate() + "日 " + formatClock(date);
    }
    return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function formatCount(value) {
    if (!Number.isFinite(value)) return "未知";
    return value.toLocaleString("zh-CN");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "未知";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let size = bytes;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const digits = index === 0 || size >= 100 ? 0 : 1;
    return size.toFixed(digits) + " " + units[index];
  }

  function formatClockSeconds(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
  }

  function percentText(value) {
    if (!Number.isFinite(value)) return "—";
    return (Math.round(value * 10) / 10).toString() + "%";
  }

  function metricBytes(value) {
    return Number.isFinite(value) ? formatBytes(value) : "—";
  }

  function rateText(value) {
    return Number.isFinite(value) ? formatBytes(value) + "/s" : "—";
  }

  function compactBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value === 0) return "0";
    const units = ["B", "K", "M", "G"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const digits = size >= 10 || index === 0 ? 0 : 1;
    return size.toFixed(digits) + units[index];
  }

  function rateCompactText(value) {
    return Number.isFinite(value) ? compactBytes(value) + "/s" : "—";
  }

  function monitorSupported() {
    return (state.monitor && state.monitor.supported) || {};
  }

  function monitorMetricFor(projectId) {
    const snapshot = state.monitor;
    if (!snapshot || !Array.isArray(snapshot.projects)) return null;
    for (let i = 0; i < snapshot.projects.length; i += 1) {
      if (snapshot.projects[i].projectId === projectId) return snapshot.projects[i];
    }
    return null;
  }

  function hasRunningProjects() {
    return state.projects.some((project) => {
      if (isRunning(project.run)) return true;
      return (project.children || []).some((child) => isRunning(child.run));
    });
  }

  function cardMonitorHTML(project, running) {
    if (!state.monitorEnabled || !running) return "";
    return (
      '<p class="card-monitor" data-monitor-for="' +
      esc(project.id) +
      '"><span class="status-dot" aria-hidden="true"></span>' +
      '<span data-metric="cpu">CPU 等待采样</span>' +
      '<span class="card-monitor-sep" aria-hidden="true">·</span>' +
      '<span data-metric="mem">内存 —</span>' +
      '<span class="card-monitor-sep" aria-hidden="true">·</span>' +
      '<span data-metric="net">↓ — ↑ —</span></p>'
    );
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || KIND_LABELS.unknown;
  }

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || "文件修改";
  }

  function basenameOf(pathValue) {
    const parts = String(pathValue || "").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function normalizeWorkspace(raw) {
    const workspace = raw && typeof raw === "object" ? raw : {};
    const id = typeof workspace.id === "string" && workspace.id ? workspace.id : "main";
    const pathValue = typeof workspace.path === "string" ? workspace.path : "";
    return {
      id: id,
      name:
        typeof workspace.name === "string" && workspace.name
          ? workspace.name
          : basenameOf(pathValue) || "工作区",
      path: pathValue,
      isDefault: workspace.isDefault === true || id === "main",
      addedAt: workspace.addedAt || null,
      projectCount: Number.isFinite(workspace.projectCount) ? workspace.projectCount : null,
      error: workspace.error || null,
    };
  }

  function normalizeWorkspaces(meta) {
    const list =
      meta && Array.isArray(meta.workspaces) ? meta.workspaces.map(normalizeWorkspace) : [];
    if (!list.length) {
      const root = meta && meta.root ? meta.root : "";
      list.push({
        id: "main",
        name: basenameOf(root) || "默认工作区",
        path: root,
        isDefault: true,
        addedAt: null,
        projectCount: null,
        error: null,
      });
    }
    return list;
  }

  function normalizeProject(raw) {
    const project = raw && typeof raw === "object" ? raw : {};
    const tags = Array.isArray(project.tags)
      ? project.tags.filter((tag) => typeof tag === "string" && tag.length > 0)
      : [];
    const children = Array.isArray(project.children)
      ? project.children.map((child) => normalizeProject(child))
      : [];
    const normalized = Object.assign({}, project, {
      id: typeof project.id === "string" ? project.id : String(project.dir || ""),
      dir: typeof project.dir === "string" ? project.dir : "",
      name:
        typeof project.name === "string" && project.name
          ? project.name
          : project.dir || project.id || "未命名项目",
      alias:
        typeof project.alias === "string" && project.alias.trim() ? project.alias.trim() : null,
      originalName:
        typeof project.originalName === "string" && project.originalName
          ? project.originalName
          : null,
      path: typeof project.path === "string" ? project.path : "",
      updatedAt: project.updatedAt || null,
      createdAt: project.createdAt || null,
      summary: typeof project.summary === "string" ? project.summary : "",
      readmeTitle: project.readmeTitle || null,
      readmePath: project.readmePath || null,
      tags: tags,
      kind: typeof project.kind === "string" ? project.kind : "unknown",
      fileCount: Number.isFinite(project.fileCount) ? project.fileCount : null,
      sizeBytes: Number.isFinite(project.sizeBytes) ? project.sizeBytes : null,
      git: project.git && typeof project.git === "object" ? project.git : { isRepo: false },
      accent: ACCENTS.indexOf(project.accent) >= 0 ? project.accent : "lime",
      run: project.run && typeof project.run === "object" ? project.run : null,
      runInfo: project.runInfo && typeof project.runInfo === "object" ? project.runInfo : null,
      updatedSource: project.updatedSource || "files",
      isScanner: project.isScanner === true || project.id === "project-scan",
      parentId: typeof project.parentId === "string" && project.parentId ? project.parentId : null,
      relPath: typeof project.relPath === "string" ? project.relPath : "",
      depth: Number.isFinite(project.depth) ? project.depth : 0,
      workspaceId: typeof project.workspaceId === "string" ? project.workspaceId : "",
      workspaceName: typeof project.workspaceName === "string" ? project.workspaceName : "",
      workspacePath: typeof project.workspacePath === "string" ? project.workspacePath : "",
      summarySource: project.summarySource || (project.readmePath ? "readme" : "fallback"),
      docAlias: project.docAlias && typeof project.docAlias === "object" ? project.docAlias : null,
      llm: project.llm && typeof project.llm === "object" ? project.llm : null,
      children: children,
      hidden: project.hidden === true,
      diskUsageBytes: Number.isFinite(project.diskUsageBytes) ? project.diskUsageBytes : null,
      diskUsageAt: project.diskUsageAt || null,
      diskUsageError: project.diskUsageError || null,
      firstSeenAt: project.firstSeenAt || null,
      lastChangedAt: project.lastChangedAt || null,
    });
    if (!normalized.parentId) {
      normalized.children = children.map((child) =>
        Object.assign(child, {
          parentId: child.parentId || normalized.id,
          depth: child.depth || 1,
          hidden: normalized.hidden,
        })
      );
    }
    return normalized;
  }

  function runInfoOf(project) {
    if (project.runInfo) {
      const runnable = project.runInfo.runnable !== false;
      return {
        runnable: runnable,
        kind: project.runInfo.kind || "none",
        command: project.runInfo.command || null,
        runHint: project.runInfo.runHint || project.runInfo.command || null,
        reason: project.runInfo.reason || (runnable ? null : "没有找到可识别的运行入口"),
      };
    }
    const runnable = project.runnable === true;
    return {
      runnable: runnable,
      kind: project.runKind || "none",
      command: null,
      runHint: project.runHint || null,
      reason: runnable ? null : project.runHint || "没有找到可识别的运行入口",
    };
  }

  function isRunning(run) {
    return Boolean(run && (run.status === "starting" || run.status === "running"));
  }

  function isExternalRun(run) {
    return Boolean(run && run.external === true);
  }

  function isExternalEntry(entry) {
    return Boolean(entry && (entry.external === true || entry.isExternalProject === true));
  }

  function openRunAddress(url, name) {
    const target = url ? String(url) : "";
    if (!target) {
      toast("还没有捕获到访问地址", { error: true });
      return null;
    }
    const placeholder = window.open("about:blank", "_blank");
    if (!placeholder) {
      window.open(target, "_blank", "noopener");
      toast("浏览器拦截了新窗口，已尝试重新打开访问地址");
      return null;
    }
    try {
      placeholder.document.title = "正在打开" + (name ? " " + name : "") + "…";
      placeholder.document.body.style.background = "#131209";
    } catch (error) {
      /* 跨窗口访问被拒绝时忽略 */
    }
    try {
      placeholder.location.replace(target);
    } catch (error) {
      window.open(target, "_blank", "noopener");
    }
    return placeholder;
  }

  function openProjectRun(id) {
    const project = getProject(id);
    if (!project) return;
    if (!project.run || !project.run.url) {
      toast("还没有捕获到访问地址", { error: true });
      return;
    }
    openRunAddress(project.run.url, project.name);
  }

  function getProject(id) {
    if (!id) return null;
    for (let i = 0; i < state.projects.length; i += 1) {
      const project = state.projects[i];
      if (project.id === id) return project;
      const children = project.children || [];
      for (let j = 0; j < children.length; j += 1) {
        if (children[j].id === id) return children[j];
      }
    }
    return null;
  }

  function topProjectOf(id) {
    const project = getProject(id);
    if (!project) return null;
    if (!project.parentId) return project;
    return getProject(project.parentId);
  }

  function workspaceById(id) {
    for (let i = 0; i < state.workspaces.length; i += 1) {
      if (state.workspaces[i].id === id) return state.workspaces[i];
    }
    return null;
  }

  function countProjectsInWorkspace(id) {
    return state.projects.filter((project) => project.workspaceId === id).length;
  }

  function workspaceProjectCount(workspace) {
    return Number.isFinite(workspace.projectCount)
      ? workspace.projectCount
      : countProjectsInWorkspace(workspace.id);
  }

  function hasMultipleWorkspaces() {
    return state.workspaces.length > 1;
  }

  function hiddenProjectCount() {
    return state.projects.filter((project) => project.hidden === true).length;
  }

  function statusCounts() {
    let list = state.projects;
    if (state.workspaceFilter !== "all") {
      list = list.filter((project) => project.workspaceId === state.workspaceFilter);
    }
    const hidden = list.filter((project) => project.hidden === true).length;
    return { available: list.length - hidden, hidden: hidden, all: list.length };
  }

  function renderStatusSeg() {
    if (!els.statusSeg) return;
    const counts = statusCounts();
    els.statusSeg.querySelectorAll("[data-status]").forEach((button) => {
      const key = button.getAttribute("data-status");
      button.setAttribute("aria-pressed", key === state.statusFilter ? "true" : "false");
      const countEl = button.querySelector(".status-seg-count");
      if (countEl) countEl.textContent = formatCount(counts[key] || 0);
    });
  }

  function setStatusFilter(next) {
    if (next !== "available" && next !== "hidden" && next !== "all") return;
    state.statusFilter = next;
    renderStatusSeg();
    renderList();
  }

  function applyWorkspaceFields(project, parent) {
    if (!project) return project;
    if (!project.workspaceId) {
      project.workspaceId = parent && parent.workspaceId ? parent.workspaceId : "main";
    }
    const workspace = workspaceById(project.workspaceId);
    if (!project.workspaceName) {
      project.workspaceName = workspace
        ? workspace.name
        : parent && parent.workspaceName
          ? parent.workspaceName
          : "";
    }
    if (!project.workspacePath) {
      project.workspacePath = workspace
        ? workspace.path
        : parent && parent.workspacePath
          ? parent.workspacePath
          : "";
    }
    (project.children || []).forEach((child) => applyWorkspaceFields(child, project));
    return project;
  }

  function defaultWorkspacePath() {
    const defaultWorkspace = state.workspaces.filter((workspace) => workspace.isDefault)[0];
    if (defaultWorkspace && defaultWorkspace.path) return defaultWorkspace.path;
    if (state.meta && state.meta.root) return state.meta.root;
    return state.fsHome || "";
  }

  function countSubprojects() {
    return state.projects.reduce((total, project) => total + (project.children || []).length, 0);
  }

  function accentColor(accent) {
    return ACCENT_COLORS[accent] || ACCENT_COLORS.lime;
  }

  function setSSEState(next) {
    state.sseState = next;
    renderScanStatus();
  }

  /* ---------- Toast ---------- */

  function toast(message, options) {
    const opts = options || {};
    if (!els.toasts) return;
    const el = document.createElement("div");
    el.className = "toast" + (opts.error ? " is-error" : "");
    el.setAttribute("role", opts.error ? "alert" : "status");
    el.innerHTML =
      '<span class="toast-dot" aria-hidden="true"></span><span>' + esc(message) + "</span>";
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) {
      els.toasts.removeChild(els.toasts.firstElementChild);
    }
    window.requestAnimationFrame(() => {
      el.classList.add("is-visible");
    });
    window.setTimeout(() => {
      el.classList.remove("is-visible");
      window.setTimeout(() => el.remove(), 500);
    }, opts.duration || 4600);
  }

  /* ---------- 数据加载 ---------- */

  async function fetchProjects() {
    if (!MOCK && !IS_HTTP) {
      throw new Error("直接打开本地文件时无法连接扫描服务");
    }
    const url = MOCK ? "./mock-projects.json" : "/api/projects";
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("请求返回 " + response.status);
    }
    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("返回的数据格式不正确");
    }
    return data;
  }

  function describeLoadError(error) {
    let base;
    if (MOCK) {
      base =
        "无法读取本地夹具数据。请确认 mock-projects.json 与 index.html 在同一目录，并通过静态服务器访问。";
    } else if (!IS_HTTP) {
      base =
        "你正在直接打开本地文件。请启动扫描服务后访问 http://127.0.0.1:8790，或在地址后加 ?mock=1 使用离线数据。";
    } else {
      base = "无法连接扫描服务。请确认 node server/index.js 正在运行，然后重试。";
    }
    const detail = error && error.message ? error.message : "未知错误";
    return base + "（" + detail + "）";
  }

  async function loadProjects(options) {
    const opts = options || {};
    const silent = opts.silent === true;
    if (!silent) {
      state.phase = "loading";
      renderAll();
    }
    try {
      const data = await fetchProjects();
      state.projects = (Array.isArray(data.projects) ? data.projects : []).map(normalizeProject);
      state.meta = data.meta || state.meta;
      if (data.mockFs && typeof data.mockFs === "object") state.mockFs = data.mockFs;
      if (data.settings && typeof data.settings === "object") state.mockSettings = data.settings;
      state.workspaces = normalizeWorkspaces(state.meta);
      if (!state.fsHome) {
        state.fsHome =
          (state.mockFs && state.mockFs.home) ||
          (state.workspaces[0] && state.workspaces[0].path) ||
          "";
      }
      state.projects.forEach((project) => applyWorkspaceFields(project, null));
      state.phase = "ready";
      state.error = "";
      renderAll();
      ensureSettingsLoaded();
      applyDebugHash();
      if (!MOCK) connectSSE();
    } catch (error) {
      if (silent) {
        toast("刷新项目列表失败，稍后会自动重试", { error: true });
        return;
      }
      state.phase = "error";
      state.error = describeLoadError(error);
      renderAll();
    }
  }

  async function refreshProject(id) {
    if (MOCK) return;
    try {
      const response = await fetch("/api/projects/" + encodeURIComponent(id), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.project) return;
      const project = normalizeProject(data.project);
      const index = state.projects.findIndex((item) => item.id === id);
      if (index >= 0) {
        state.projects[index] = project;
        replaceCard(id);
      } else if (project.parentId) {
        const parent = getProject(project.parentId);
        if (parent && Array.isArray(parent.children)) {
          const childIndex = parent.children.findIndex((item) => item.id === id);
          if (childIndex >= 0) parent.children[childIndex] = project;
          replaceChildCard(parent.id, id);
        }
      }
      const panel = panelForProject(id);
      if (panel) renderDrawerPanel(panel, getProject(id));
    } catch (error) {
      /* 静默失败，下一次轮询或 SSE 会补上 */
    }
  }

  /* ---------- SSE ---------- */

  function parseEvent(event) {
    try {
      return JSON.parse(event.data);
    } catch (error) {
      return null;
    }
  }

  function connectSSE() {
    if (MOCK || !IS_HTTP || typeof window.EventSource !== "function") return;
    if (state.sse) return;
    let source;
    try {
      source = new window.EventSource("/api/events");
    } catch (error) {
      setSSEState("offline");
      return;
    }
    state.sse = source;
    setSSEState("reconnecting");

    source.addEventListener("hello", (event) => {
      const payload = parseEvent(event);
      if (payload && payload.meta) {
        state.meta = payload.meta;
        renderHeroMeta();
        renderScanStatus();
      }
      setSSEState("open");
    });

    source.addEventListener("scan:start", () => {
      state.scanning = true;
      renderScanStatus();
    });

    source.addEventListener("scan:done", async (event) => {
      const payload = parseEvent(event);
      state.scanning = false;
      if (state.scanFallback) {
        window.clearTimeout(state.scanFallback);
        state.scanFallback = null;
      }
      if (payload && payload.meta) state.meta = payload.meta;
      renderHeroMeta();
      renderScanStatus();
      const diff = payload && payload.diff ? payload.diff : null;
      const changed = diff
        ? (Number(diff.added) || 0) + (Number(diff.updated) || 0) + (Number(diff.removed) || 0)
        : 0;
      toast(changed > 0 ? "扫描完成 · 更新 " + changed + " 个项目" : "扫描完成 · 没有变化");
      await loadProjects({ silent: true });
    });

    source.addEventListener("llm:start", () => {
      if (state.meta) {
        state.meta.llm = Object.assign({}, state.meta.llm || {}, {
          enabled: true,
          running: true,
        });
      }
      renderHeroMeta();
    });

    source.addEventListener("llm:done", async (event) => {
      const payload = parseEvent(event);
      if (payload && payload.meta) {
        state.meta = payload.meta;
      } else if (state.meta) {
        state.meta.llm = Object.assign({}, state.meta.llm || {}, { running: false });
      }
      renderHeroMeta();
      const enriched = payload && Number.isFinite(payload.enriched) ? payload.enriched : 0;
      toast(enriched > 0 ? "AI 摘要完成 · 更新 " + enriched + " 个项目" : "AI 摘要完成 · 没有需要更新的摘要");
      await loadProjects({ silent: true });
    });

    source.addEventListener("update", (event) => {
      const payload = parseEvent(event);
      if (payload) applyUpdateStatus(payload);
    });

    source.addEventListener("projects", (event) => {
      const payload = parseEvent(event);
      if (payload && Array.isArray(payload.projects)) {
        state.projects = payload.projects.map(normalizeProject);
        renderAll();
      }
    });

    source.addEventListener("run", (event) => {
      const payload = parseEvent(event);
      if (payload && payload.projectId) applyRun(payload);
    });

    source.onopen = () => setSSEState("open");
    source.onerror = () => {
      setSSEState(source.readyState === 2 ? "offline" : "reconnecting");
    };
  }

  /* ---------- 概览区 ---------- */

  function newestProject() {
    if (!state.projects.length) return null;
    return state.projects.reduce((latest, project) => {
      const current = new Date(project.updatedAt || 0).getTime();
      const previous = new Date(latest.updatedAt || 0).getTime();
      return current > previous ? project : latest;
    }, state.projects[0]);
  }

  function renderHero() {
    let tokens;
    if (state.phase === "loading") {
      tokens = ["正在读取", "工作区…"];
    } else if (state.phase === "error") {
      tokens = ["工作区索引", "暂时不可用。"];
    } else if (state.projects.length === 0) {
      tokens = ["工作区里", "还没有", "项目。"];
    } else {
      const newest = newestProject();
      const relative = newest ? formatRelative(newest.updatedAt) : "未知时间";
      tokens = [
        "工作区里",
        String(state.projects.length),
        "个项目，",
        "最近一次更新在",
        relative + "。",
      ];
    }
    const html = tokens
      .map((token, index) => {
        const isRelative = state.phase === "ready" && state.projects.length > 0 && index === tokens.length - 1;
        const attr = isRelative ? " data-hero-rel" : "";
        return '<span class="word" style="--i:' + index + '"' + attr + ">" + esc(token) + "</span>";
      })
      .join(" ");
    els.heroTitle.innerHTML = html;
    if (state.heroRevealed) els.heroTitle.classList.add("is-lit");
  }

  function updateHeroRelative() {
    const el = els.heroTitle.querySelector("[data-hero-rel]");
    if (!el || state.phase !== "ready" || !state.projects.length) return;
    const newest = newestProject();
    if (!newest) return;
    el.textContent = formatRelative(newest.updatedAt) + "。";
  }

  function renderHeroMeta() {
    const meta = state.meta;
    if (!meta) {
      els.heroMeta.textContent =
        state.phase === "error"
          ? "无法读取扫描状态，请检查扫描服务后重试。"
          : "正在读取工作区…";
      return;
    }
    const scheduler = meta.scheduler || {};
    const scanned = meta.scannedAt ? formatClock(meta.scannedAt) : "--:--";
    const duration = Number.isFinite(meta.scanDurationMs)
      ? (meta.scanDurationMs / 1000).toFixed(1) + " 秒"
      : "未知";
    const windowLabel =
      scheduler.enabled === false
        ? "自动扫描已关闭"
        : pad2(scheduler.windowStartHour == null ? 9 : scheduler.windowStartHour) +
          ":00 到 " +
          pad2(scheduler.windowEndHour == null ? 20 : scheduler.windowEndHour) +
          ":00 每 " +
          (scheduler.intervalMinutes == null ? 20 : scheduler.intervalMinutes) +
          " 分钟";
    const llm = meta.llm || {};
    let aiHtml = "";
    if (llm.enabled) {
      const llmLabel = llm.running
        ? '<span class="hero-ai" data-state="running"><span class="hero-ai-dot" aria-hidden="true"></span>AI 摘要生成中</span>'
        : '<span class="hero-ai">AI 摘要 · <span class="mono">' + esc(llm.model || "模型") + "</span></span>";
      aiHtml = '<span class="sep" aria-hidden="true">·</span>' + llmLabel;
    }
    els.heroMeta.innerHTML =
      "<span>上次扫描 <span class=\"mono\">" +
      esc(scanned) +
      "</span></span>" +
      '<span class="sep" aria-hidden="true">·</span>' +
      "<span>耗时 <span class=\"mono\">" +
      esc(duration) +
      "</span></span>" +
      '<span class="sep" aria-hidden="true">·</span>' +
      "<span>" +
      esc(windowLabel) +
      "</span>" +
      aiHtml;
  }

  function renderStats() {
    const ready = state.phase === "ready";
    const count = ready ? state.projects.length : null;
    const subprojects = ready
      ? Number.isFinite(state.meta && state.meta.subprojectCount)
        ? state.meta.subprojectCount
        : countSubprojects()
      : null;
    const runnable = ready
      ? state.projects.filter((project) => runInfoOf(project).runnable).length
      : null;
    const values = { count: count, subprojects: subprojects, runnable: runnable };
    els.heroStats.querySelectorAll("[data-stat]").forEach((el) => {
      const key = el.getAttribute("data-stat");
      el.textContent = ready ? formatCount(values[key]) : "--";
    });
  }

  function setupHeroReveal() {
    const reveal = () => {
      if (state.heroRevealed) return;
      state.heroRevealed = true;
      els.heroTitle.classList.add("is-lit");
    };
    if (!("IntersectionObserver" in window)) {
      reveal();
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        for (let i = 0; i < entries.length; i += 1) {
          if (entries[i].isIntersecting) {
            reveal();
            observer.disconnect();
            return;
          }
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(els.heroTitle);
    window.setTimeout(reveal, 800);
  }

  /* ---------- 工具栏：标签 ---------- */

  function renderTagFilters() {
    const counts = new Map();
    state.projects.forEach((project) => {
      (project.tags || []).forEach((tag) => {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });
    const allTags = Array.from(counts.keys()).sort((a, b) => {
      const diff = counts.get(b) - counts.get(a);
      return diff !== 0 ? diff : a.localeCompare(b, "zh-Hans-CN");
    });
    // 标签筛选只展示最高频的一批，避免 LLM 生成的长尾标签把工具栏撑成十几行
    const MAX_TAG_FILTERS = 10;
    let tags = allTags.slice(0, MAX_TAG_FILTERS);
    if (state.tag !== "all" && allTags.indexOf(state.tag) >= 0 && tags.indexOf(state.tag) < 0) {
      tags = tags.concat([state.tag]);
    }
    if (state.tag !== "all" && tags.indexOf(state.tag) < 0) state.tag = "all";
    const items = [{ tag: "all", label: "全部", count: state.projects.length }].concat(
      tags.map((tag) => ({ tag: tag, label: tag, count: counts.get(tag) }))
    );
    els.tagFilters.innerHTML = items
      .map((item) => {
        const pressed = item.tag === state.tag ? "true" : "false";
        return (
          '<button class="tag-btn" type="button" data-tag="' +
          esc(item.tag) +
          '" aria-pressed="' +
          pressed +
          '">' +
          esc(item.label) +
          '<span class="tag-count" aria-hidden="true">' +
          item.count +
          "</span></button>"
        );
      })
      .join("");
    const tagRow = els.tagFilters.closest(".tag-row");
    if (tagRow) tagRow.hidden = tags.length === 0;
  }

  function updateTagPressed() {
    els.tagFilters.querySelectorAll("[data-tag]").forEach((button) => {
      button.setAttribute("aria-pressed", button.getAttribute("data-tag") === state.tag ? "true" : "false");
    });
  }

  /* ---------- 卡片列表 ---------- */

  function visibleProjects() {
    const query = state.query.trim().toLowerCase();
    let list = state.projects.slice();
    if (state.workspaceFilter !== "all") {
      list = list.filter((project) => project.workspaceId === state.workspaceFilter);
    }
    if (state.statusFilter === "available") {
      list = list.filter((project) => project.hidden !== true);
    } else if (state.statusFilter === "hidden") {
      list = list.filter((project) => project.hidden === true);
    }
    if (state.tag !== "all") {
      list = list.filter((project) => (project.tags || []).indexOf(state.tag) >= 0);
    }
    if (query) {
      list = list.filter((project) => {
        const haystack = [
          project.name,
          project.alias,
          project.originalName,
          project.dir,
          project.summary,
          project.readmeTitle,
          (project.tags || []).join(" "),
          (project.children || [])
            .map((child) =>
              [
                child.name,
                child.alias,
                child.originalName,
                child.summary,
                (child.tags || []).join(" "),
              ].join(" ")
            )
            .join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.indexOf(query) >= 0;
      });
    }
    if (state.sort === "name") {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN"));
    } else {
      list.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    }
    return list;
  }

  function cardStateText(project, info, running) {
    if (running) return "运行中";
    if (info.runnable) return "未运行";
    const runnableChildren = (project.children || []).filter((child) => runInfoOf(child).runnable).length;
    if (runnableChildren > 0) return "子项目可运行";
    return kindLabel(project.kind);
  }

  function cardStateTitle(project, info, running) {
    if (running && isExternalRun(project.run)) {
      return "正在运行 · 外部启动（由外部终端启动，本服务不能停止）";
    }
    if (running) return "正在运行";
    if (info.runnable) {
      return "当前未运行 · 可运行：" + (info.runHint || info.command || "已检测到运行入口");
    }
    const runnableChildren = (project.children || []).filter((child) => runInfoOf(child).runnable).length;
    if (runnableChildren > 0) {
      return "项目本身没有运行入口，可打开详情从 " + runnableChildren + " 个可运行子项目里选择";
    }
    return info.reason || "没有找到可识别的运行入口";
  }

  function cardHTML(project, index, animate, options) {
    const opts = options || {};
    const compact = opts.compact === true;
    const hidden = project.hidden === true;
    const info = runInfoOf(project);
    const run = project.run;
    const running = isRunning(run);
    const children = project.children || [];
    const runnableChildren = children.filter((child) => runInfoOf(child).runnable).length;
    const accent = ACCENTS.indexOf(project.accent) >= 0 ? project.accent : "lime";
    const relative = formatRelative(project.updatedAt);
    const absolute = formatAbsolute(project.updatedAt);
    const summary = project.summary || "这个项目还没有可读的用途概要。";
    const tags = (project.tags || [])
      .map((tag) => '<li class="tag">' + esc(tag) + "</li>")
      .join("");
    const reason = info.reason || "没有找到可识别的运行入口";
    const source = project.summarySource || (project.readmePath ? "readme" : "fallback");
    const sourceText = source === "llm" ? "AI 摘要" : source === "fallback" ? "兜底摘要" : "";
    let runControl;
    if (running && project.isScanner) {
      runControl =
        '<span class="run-tooltip" title="扫描器服务由外部 start.sh 启动，不能在这里单独停止；如需停止，请在顶部「运行中」弹层勾选「包含当前扫描器」后全部停止"><span class="btn btn-run is-scanner" role="status"><span class="status-dot" aria-hidden="true"></span>扫描器运行中</span></span>';
    } else if (running && isExternalRun(run)) {
      runControl =
        '<button class="btn btn-run is-external" type="button" data-action="open" data-id="' +
        esc(project.id) +
        '" title="外部启动 · 点击在新标签打开访问地址" aria-label="打开 ' +
        esc(project.name) +
        ' 的访问地址"><span class="status-dot" aria-hidden="true"></span>打开' +
        ARROW_ICON +
        "</button>";
    } else if (running) {
      runControl =
        '<button class="btn btn-run is-stop" type="button" data-action="stop" data-id="' +
        esc(project.id) +
        '"><span class="status-dot" aria-hidden="true"></span>运行中 · 停止</button>';
    } else if (info.runnable) {
      runControl =
        '<button class="btn btn-run" type="button" data-action="run" data-id="' +
        esc(project.id) +
        '" title="启动：' +
        esc(info.runHint || info.command || "运行入口") +
        '">运行 ' +
        ARROW_ICON +
        "</button>";
    } else if (runnableChildren > 0) {
      runControl =
        '<button class="btn btn-children" type="button" data-action="open-children" data-id="' +
        esc(project.id) +
        '" title="打开详情，从子项目中选择要运行的项目">子项目 ' +
        runnableChildren +
        " " +
        ARROW_ICON +
        "</button>";
    } else {
      runControl =
        '<span class="run-tooltip" title="' +
        esc(reason) +
        '"><button class="btn btn-run" type="button" disabled aria-label="无法运行：' +
        esc(reason) +
        '">无法运行</button></span>';
    }
    const childrenBadge = children.length
      ? '<span class="card-children" title="包含 ' +
        children.length +
        ' 个子项目">' +
        CHILDREN_ICON +
        children.length +
        " 个子项目</span>"
      : "";
    const hiddenBadge =
      hidden && !compact ? '<span class="card-hidden-badge">已隐藏</span>' : "";
    const sourceBadge = sourceText
      ? '<span class="sep" aria-hidden="true">·</span><span class="source-badge">' + sourceText + "</span>"
      : "";
    const showWorkspace = !compact && hasMultipleWorkspaces() && project.workspaceName;
    const workspaceBadge = showWorkspace
      ? '<span class="sep" aria-hidden="true">·</span><span class="card-workspace" title="' +
        esc(project.workspacePath || project.workspaceName) +
        '">' +
        esc(project.workspaceName) +
        "</span>"
      : "";
    const external = isExternalRun(run);
    const muted = compact && !running && !info.runnable && runnableChildren === 0;
    const mutedReason = muted ? '<p class="card-muted-reason">原因：' + esc(reason) + "</p>" : "";
    const diskText = Number.isFinite(project.diskUsageBytes)
      ? formatBytes(project.diskUsageBytes)
      : "—";
    const diskBadge =
      !compact || Number.isFinite(project.diskUsageBytes)
        ? '<span class="sep" aria-hidden="true">·</span><span class="card-disk" title="文件夹磁盘占用（含依赖与素材）' +
          (project.diskUsageAt ? " · 计算于 " + formatAbsolute(project.diskUsageAt) : "") +
          '">' +
          esc(diskText) +
          "</span>"
        : "";
    const timeHtml =
      relative === absolute
        ? '<span class="card-rel">' + esc(absolute) + "</span>" + sourceBadge + workspaceBadge + diskBadge
        : '<span class="card-rel" data-rel-time="' +
          esc(project.updatedAt || "") +
          '">' +
          esc(relative) +
          '</span><span class="sep" aria-hidden="true">·</span><span class="card-abs">' +
          esc(absolute) +
          "</span>" +
          sourceBadge +
          workspaceBadge +
          diskBadge;
    return (
      '<article class="card' +
      (running ? " is-running" : "") +
      (compact ? " card--compact" : "") +
      (muted ? " card--muted" : "") +
      (hidden ? " is-hidden" : "") +
      (animate ? "" : " card--static") +
      '" data-id="' +
      esc(project.id) +
      '" data-accent="' +
      accent +
      '"' +
      (compact ? "" : ' style="--i:' + Math.min(index, 10) + '"') +
      ">" +
      '<div class="card-top">' +
      '<span class="card-top-left"><span class="card-index">' +
      pad2(index + 1) +
      "</span>" +
      childrenBadge +
      hiddenBadge +
      "</span>" +
      '<span class="card-state" title="' +
      esc(cardStateTitle(project, info, running)) +
      '">' +
      '<span class="status-dot' +
      (running ? " is-live" : "") +
      '" aria-hidden="true"></span>' +
      "<span>" +
      esc(cardStateText(project, info, running)) +
      "</span>" +
      (external ? '<span class="card-external-tag">外部启动</span>' : "") +
      "</span>" +
      "</div>" +
      '<h3 class="card-title">' +
      esc(project.name) +
      "</h3>" +
      '<p class="card-time">' +
      timeHtml +
      "</p>" +
      cardMonitorHTML(project, running) +
      '<p class="card-summary">' +
      esc(summary) +
      "</p>" +
      mutedReason +
      '<div class="card-bottom">' +
      '<ul class="card-tags">' +
      tags +
      "</ul>" +
      '<div class="card-run">' +
      runControl +
      "</div>" +
      "</div>" +
      '<button class="card-open" type="button" data-open="' +
      esc(project.id) +
      '" aria-label="查看「' +
      esc(project.name) +
      '」的详情"></button>' +
      "</article>"
    );
  }

  function renderEmptyState() {
    const hasQuery = state.query.trim() !== "";
    const hasTag = state.tag !== "all";
    const hasWorkspace = state.workspaceFilter !== "all";
    const status = state.statusFilter;
    const workspace = hasWorkspace ? workspaceById(state.workspaceFilter) : null;
    const hiddenCount = hiddenProjectCount();
    if (status === "hidden" && !hasQuery && !hasTag && !hasWorkspace) {
      els.emptyTitle.textContent = "还没有隐藏的项目";
      els.emptyDesc.textContent =
        "在设置里勾选项目即可隐藏；隐藏的项目不会出现在默认的「可用」视图里，随时可以恢复。";
      els.emptyAction.textContent = "打开设置";
      els.emptyAction.dataset.mode = "settings";
      return;
    }
    if (
      status === "available" &&
      !hasQuery &&
      !hasTag &&
      !hasWorkspace &&
      state.projects.length > 0 &&
      hiddenCount > 0 &&
      visibleAvailableCount() === 0
    ) {
      els.emptyTitle.textContent = "可用视图里没有项目";
      els.emptyDesc.textContent =
        "所有项目都被隐藏了，可以切换到「已隐藏」或「全部」查看，也可以到设置里恢复。";
      els.emptyAction.textContent = "查看已隐藏";
      els.emptyAction.dataset.mode = "status-hidden";
      return;
    }
    if (hasQuery || hasTag || hasWorkspace || status !== "available") {
      const workspaceOnly = hasWorkspace && !hasQuery && !hasTag && status === "available";
      if (workspaceOnly) {
        els.emptyTitle.textContent = "这个工作区里还没有项目";
        els.emptyDesc.textContent =
          "工作区「" +
          (workspace ? workspace.name : state.workspaceFilter) +
          "」还没有扫描到项目。等下一次自动扫描，或者点「手动扫描」重新收录。";
      } else {
        const condition = hasQuery
          ? "「" + state.query.trim() + "」"
          : hasWorkspace
            ? "工作区「" + (workspace ? workspace.name : state.workspaceFilter) + "」"
            : "标签「" + state.tag + "」";
        els.emptyTitle.textContent = "没有匹配的项目";
        els.emptyDesc.textContent =
          "没有找到与" +
          condition +
          "匹配的项目。换个关键词，或者清空筛选看看全部 " +
          state.projects.length +
          " 个项目。";
      }
      els.emptyAction.textContent = "清空筛选";
      els.emptyAction.dataset.mode = "clear";
    } else {
      els.emptyTitle.textContent = "工作区里还没有项目";
      els.emptyDesc.textContent =
        "扫描工作区后，做过的项目会按最近更新时间出现在这里。点「手动扫描」立即收录，或者等待下一次自动扫描。";
      els.emptyAction.textContent = "手动扫描";
      els.emptyAction.dataset.mode = "scan";
    }
  }

  function visibleAvailableCount() {
    let list = state.projects.filter((project) => project.hidden !== true);
    if (state.workspaceFilter !== "all") {
      list = list.filter((project) => project.workspaceId === state.workspaceFilter);
    }
    return list.length;
  }

  function renderResultCount(list) {
    let text;
    if (state.phase === "loading") {
      text = "正在读取工作区…";
    } else if (state.phase === "error") {
      text = "读取失败";
    } else {
      const total = state.projects.length;
      const shown = list.length;
      const sortLabel = state.sort === "name" ? "按名称排序" : "按最近更新排序";
      const filterParts = [];
      if (state.workspaceFilter !== "all") {
        const workspace = workspaceById(state.workspaceFilter);
        if (workspace) filterParts.push("工作区 " + workspace.name);
      }
      if (state.tag !== "all") filterParts.push("标签 " + state.tag);
      if (state.statusFilter === "hidden") filterParts.push("已隐藏");
      else if (state.statusFilter === "all") filterParts.push("含已隐藏");
      else if (hiddenProjectCount() > 0) filterParts.push("不含已隐藏");
      if (!filterParts.length) {
        text = "共 " + total + " 个项目 · " + sortLabel;
      } else {
        text =
          "显示 " +
          shown +
          " / " +
          total +
          " 个项目 · " +
          filterParts.join(" · ");
      }
    }
    els.resultCount.textContent = text;
  }

  function renderList() {
    renderStatusSeg();
    const list = visibleProjects();
    const showGrid = state.phase === "ready" && list.length > 0;
    // 入场动画只在首次加载时播放；切换标签页（visibilitychange 静默刷新）、SSE 更新、
    // 搜索/排序/筛选重绘都不再重放，避免出现「从上到下重新加载」的错觉。
    const animate = !state.entranceDone;
    if (showGrid) {
      els.cardGrid.innerHTML = list
        .map((project, index) => cardHTML(project, index, animate))
        .join("");
      state.entranceDone = true;
      els.cardGrid.hidden = false;
      if (window.location.hash === "#demo-hover") {
        const first = els.cardGrid.querySelector(".card");
        if (first) first.classList.add("is-demo-hover");
      }
    } else {
      els.cardGrid.hidden = true;
      els.cardGrid.innerHTML = "";
    }
    els.skeletonGrid.hidden = state.phase !== "loading";
    els.errorState.hidden = state.phase !== "error";
    els.emptyState.hidden = !(state.phase === "ready" && list.length === 0);
    els.stateRegion.setAttribute("aria-busy", state.phase === "loading" ? "true" : "false");
    if (state.phase === "error") els.errorDesc.textContent = state.error;
    if (state.phase === "ready" && list.length === 0) renderEmptyState();
    renderResultCount(list);
    if (state.monitorEnabled) updateMonitorDom();
    syncOpenDrawer();
  }

  function renderAll() {
    renderHero();
    renderHeroMeta();
    renderStats();
    renderTagFilters();
    renderWorkspaceFilter();
    renderWorkspaceButton();
    renderList();
    renderRunningCount();
    if (state.settingsOpen) renderSettingsModal();
    renderScanStatus();
    els.footerSource.textContent = MOCK
      ? "数据来自本地夹具 mock-projects.json"
      : "数据保存在 project-scan/data";
  }

  /* ---------- 多工作区：筛选 / 管理弹层 / 目录选择器 ---------- */

  function updateScrollLock() {
    const locked =
      Boolean(activeDrawerPanel()) ||
      state.wsModalOpen ||
      state.fsPickerOpen ||
      state.settingsOpen ||
      state.runningOpen;
    document.documentElement.classList.toggle("is-locked", locked);
  }

  function trapFocusWithin(root) {
    return function (event) {
      if (event.key !== "Tab") return;
      const focusables = Array.prototype.filter.call(
        root.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
        (el) => !el.closest("[hidden]") && el.getClientRects().length > 0
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
  }

  function renderWorkspaceButton() {
    if (!els.workspaceCount) return;
    const total = state.workspaces.length;
    els.workspaceCount.hidden = total <= 1;
    els.workspaceCount.textContent = String(total);
    els.workspacesButton.setAttribute(
      "aria-label",
      total > 1 ? "管理工作区，当前 " + total + " 个" : "管理工作区"
    );
  }

  function renderWorkspaceFilter() {
    if (!els.wsFilter) return;
    const show = hasMultipleWorkspaces() && state.phase === "ready";
    if (!show) {
      state.workspaceFilter = "all";
      els.wsFilter.hidden = true;
      els.wsFilter.removeAttribute("data-open");
      closeWorkspaceMenu(false);
      return;
    }
    const ids = state.workspaces.map((workspace) => workspace.id);
    if (state.workspaceFilter !== "all" && ids.indexOf(state.workspaceFilter) < 0) {
      state.workspaceFilter = "all";
    }
    els.wsFilter.hidden = false;
    els.wsFilter.setAttribute("data-open", state.wsMenuOpen ? "true" : "false");
    const current =
      state.workspaceFilter === "all" ? null : workspaceById(state.workspaceFilter);
    els.wsFilterLabel.textContent = current ? current.name : "全部工作区";
    els.wsFilterButton.setAttribute("aria-expanded", state.wsMenuOpen ? "true" : "false");
    const items = [{ id: "all", name: "全部工作区", count: state.projects.length }].concat(
      state.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        count: workspaceProjectCount(workspace),
      }))
    );
    els.wsFilterMenu.innerHTML = items
      .map((item) => {
        const selected = item.id === state.workspaceFilter;
        return (
          '<button class="filter-item" type="button" role="option" data-ws="' +
          esc(item.id) +
          '" aria-selected="' +
          (selected ? "true" : "false") +
          '">' +
          '<span class="filter-item-name">' +
          esc(item.name) +
          "</span>" +
          '<span class="filter-item-count">' +
          formatCount(item.count) +
          "</span>" +
          (selected ? CHECK_ICON : "") +
          "</button>"
        );
      })
      .join("");
  }

  function openWorkspaceMenu() {
    if (!hasMultipleWorkspaces()) return;
    state.wsMenuOpen = true;
    els.wsFilterMenu.hidden = false;
    els.wsFilter.setAttribute("data-open", "true");
    els.wsFilterButton.setAttribute("aria-expanded", "true");
    const selected =
      els.wsFilterMenu.querySelector('[aria-selected="true"]') ||
      els.wsFilterMenu.querySelector(".filter-item");
    if (selected) selected.focus({ preventScroll: true });
  }

  function closeWorkspaceMenu(restoreFocus) {
    if (!state.wsMenuOpen) return;
    state.wsMenuOpen = false;
    els.wsFilterMenu.hidden = true;
    if (els.wsFilter) els.wsFilter.setAttribute("data-open", "false");
    els.wsFilterButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) els.wsFilterButton.focus({ preventScroll: true });
  }

  function selectWorkspaceFilter(id) {
    state.workspaceFilter = id || "all";
    closeWorkspaceMenu(true);
    renderWorkspaceFilter();
    renderList();
  }

  function showWsError(message) {
    state.wsError = message || "";
    if (!els.wsError) return;
    els.wsError.hidden = !state.wsError;
    els.wsError.textContent = state.wsError;
  }

  function clearWsError() {
    showWsError("");
  }

  function renderWorkspaceModal() {
    if (!els.wsList) return;
    const list = state.workspaces;
    els.wsListCount.textContent = list.length + " 个";
    els.wsList.innerHTML = list
      .map((workspace) => {
        const count = workspaceProjectCount(workspace);
        const confirming = state.wsConfirmId === workspace.id;
        const removeButton = workspace.isDefault
          ? ""
          : '<button class="btn btn-quiet ws-remove' +
            (confirming ? " is-confirming" : "") +
            '" type="button" data-remove-ws="' +
            esc(workspace.id) +
            '" aria-label="' +
            (confirming ? "确认移除工作区 " : "移除工作区 ") +
            esc(workspace.name) +
            '">' +
            (confirming ? "确认移除" : "移除") +
            "</button>";
        return (
          '<li class="ws-row' +
          (workspace.error ? " has-error" : "") +
          '"><div class="ws-row-main">' +
          '<p class="ws-row-name">' +
          esc(workspace.name) +
          (workspace.isDefault ? '<span class="ws-badge">默认</span>' : "") +
          "</p>" +
          '<p class="ws-row-path">' +
          esc(workspace.path || "路径未知") +
          "</p>" +
          (workspace.error
            ? '<p class="ws-row-error">' + esc(workspace.error) + "</p>"
            : "") +
          '</div><div class="ws-row-side"><span class="ws-row-count">' +
          formatCount(count) +
          " 个项目</span>" +
          removeButton +
          "</div></li>"
        );
      })
      .join("");
    if (els.wsLimitHint) {
      els.wsLimitHint.textContent =
        "最多同时扫描 " + state.workspacesLimit + " 个工作区，默认工作区始终保留。";
    }
  }

  async function refreshWorkspaces() {
    if (!MOCK) {
      try {
        const response = await fetch("/api/workspaces", {
          headers: { accept: "application/json" },
        });
        if (response.ok) {
          const data = await response.json();
          if (data && Array.isArray(data.workspaces)) {
            state.workspaces = data.workspaces.map(normalizeWorkspace);
            if (Number.isFinite(data.limit)) state.workspacesLimit = data.limit;
            if (typeof data.home === "string" && data.home) state.fsHome = data.home;
            state.projects.forEach((project) => applyWorkspaceFields(project, null));
          }
        }
      } catch (error) {
        /* 使用 meta.workspaces 作为退路 */
      }
    }
    renderWorkspaceModal();
    renderWorkspaceFilter();
    renderWorkspaceButton();
    renderList();
  }

  function openWorkspaceModal() {
    if (state.wsModalOpen) return;
    state.wsModalOpen = true;
    state.wsConfirmId = null;
    state.lastFocusWs = document.activeElement;
    clearWsError();
    renderWorkspaceModal();
    els.wsModal.hidden = false;
    els.wsScrim.hidden = false;
    void els.wsModal.offsetWidth;
    els.wsModal.classList.add("is-open");
    els.wsScrim.classList.add("is-open");
    updateScrollLock();
    els.wsClose.focus({ preventScroll: true });
    refreshWorkspaces();
  }

  function closeWorkspaceModal() {
    if (!state.wsModalOpen) return;
    if (state.fsPickerOpen) closeDirPicker(false);
    state.wsModalOpen = false;
    state.wsConfirmId = null;
    window.clearTimeout(state.wsConfirmTimer);
    els.wsModal.classList.remove("is-open");
    els.wsScrim.classList.remove("is-open");
    window.setTimeout(() => {
      if (!state.wsModalOpen) {
        els.wsModal.hidden = true;
        els.wsScrim.hidden = true;
      }
    }, 300);
    updateScrollLock();
    if (state.lastFocusWs && document.contains(state.lastFocusWs)) {
      state.lastFocusWs.focus({ preventScroll: true });
    }
    state.lastFocusWs = null;
  }

  async function submitWorkspace(pathValue) {
    clearWsError();
    const raw = typeof pathValue === "string" ? pathValue : els.wsPathInput.value;
    const path = String(raw || "").trim();
    if (!path) {
      showWsError("请先输入或选择一个目录路径。");
      els.wsPathInput.focus();
      return;
    }
    if (path.charAt(0) !== "/") {
      showWsError("请填写以 / 开头的绝对路径。");
      els.wsPathInput.focus();
      return;
    }
    const normalizedPath = path.replace(/\/+$/, "");
    const duplicate = state.workspaces.some(
      (workspace) => workspace.path.replace(/\/+$/, "") === normalizedPath
    );
    if (duplicate) {
      showWsError("这个目录已经在扫描列表里了。");
      return;
    }
    if (state.workspaces.length >= state.workspacesLimit) {
      showWsError("最多只能同时扫描 " + state.workspacesLimit + " 个工作区。");
      return;
    }
    if (MOCK) {
      simulateAddWorkspace(path);
      return;
    }
    setButtonBusy(els.wsAddButton, true, "添加中…");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ path: path }),
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        showWsError(errorMessage(data, response.status));
        return;
      }
      els.wsPathInput.value = "";
      toast("已添加工作区 · 正在扫描");
      state.scanning = true;
      renderScanStatus();
      await refreshWorkspaces();
      await loadProjects({ silent: true });
    } catch (error) {
      showWsError("添加失败，扫描服务可能已经退出。");
    } finally {
      setButtonBusy(els.wsAddButton, false);
    }
  }

  async function removeWorkspace(id, button) {
    const workspace = workspaceById(id);
    if (!workspace || workspace.isDefault) return;
    if (state.wsConfirmId !== id) {
      state.wsConfirmId = id;
      renderWorkspaceModal();
      const nextButton = els.wsList.querySelector('[data-remove-ws="' + attrEsc(id) + '"]');
      if (nextButton) nextButton.focus({ preventScroll: true });
      window.clearTimeout(state.wsConfirmTimer);
      state.wsConfirmTimer = window.setTimeout(() => {
        if (state.wsConfirmId === id) {
          state.wsConfirmId = null;
          renderWorkspaceModal();
        }
      }, 4000);
      return;
    }
    state.wsConfirmId = null;
    window.clearTimeout(state.wsConfirmTimer);
    if (MOCK) {
      simulateRemoveWorkspace(id);
      return;
    }
    setButtonBusy(button, true, "移除中…");
    try {
      const response = await fetch("/api/workspaces/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        showWsError(errorMessage(data, response.status));
        return;
      }
      if (state.workspaceFilter === id) state.workspaceFilter = "all";
      toast(
        "已移除工作区" +
          (data && data.removedProjects ? " · 清理 " + data.removedProjects + " 个项目" : "")
      );
      await refreshWorkspaces();
      await loadProjects({ silent: true });
    } catch (error) {
      showWsError("移除失败，扫描服务可能已经退出。");
    } finally {
      setButtonBusy(button, false);
    }
  }

  function simulateAddWorkspace(path) {
    const workspace = {
      id: "ws-mock-" + Date.now().toString(36),
      name: basenameOf(path) || "新工作区",
      path: path,
      isDefault: false,
      addedAt: new Date().toISOString(),
      projectCount: 0,
      error: null,
    };
    state.workspaces = state.workspaces.concat(workspace);
    els.wsPathInput.value = "";
    clearWsError();
    renderWorkspaceModal();
    renderWorkspaceFilter();
    renderWorkspaceButton();
    renderStats();
    renderList();
    toast("演示模式 · 已加入 " + workspace.name + "，不会真的扫描磁盘");
    state.scanning = true;
    renderScanStatus();
    window.setTimeout(() => {
      state.scanning = false;
      renderScanStatus();
      toast("演示模式 · " + workspace.name + " 里没有可索引的项目");
    }, 1100);
  }

  function simulateRemoveWorkspace(id) {
    const workspace = workspaceById(id);
    if (!workspace || workspace.isDefault) return;
    const removedCount = state.projects.filter((project) => project.workspaceId === id).length;
    state.workspaces = state.workspaces.filter((item) => item.id !== id);
    state.projects = state.projects.filter((project) => project.workspaceId !== id);
    if (state.workspaceFilter === id) state.workspaceFilter = "all";
    renderWorkspaceModal();
    renderWorkspaceFilter();
    renderWorkspaceButton();
    renderAll();
    toast("演示模式 · 已移除 " + workspace.name + "（" + removedCount + " 个项目）");
  }

  function fsMockBrowse(pathValue) {
    const mockFs = state.mockFs || {};
    const tree = mockFs.tree || {};
    const home = mockFs.home || state.fsHome || "/Users";
    let target = String(pathValue || home).replace(/\/+$/, "");
    if (!target) target = "/";
    const names = tree[target];
    if (!names) return { error: "这个目录不存在，或没有读取权限。" };
    const entries = names.map((name) => {
      const entryPath = (target === "/" ? "" : target) + "/" + name;
      const isWorkspace = state.workspaces.some(
        (workspace) => workspace.path.replace(/\/+$/, "") === entryPath
      );
      const markers = mockFs.projectMarkers || [];
      return {
        name: name,
        path: entryPath,
        hasProjectMarker: isWorkspace || markers.indexOf(entryPath) >= 0,
      };
    });
    return {
      path: target,
      realPath: target,
      parent: target === "/" ? null : target.slice(0, target.lastIndexOf("/")) || "/",
      isRoot: target === "/",
      home: home,
      entries: entries,
    };
  }

  async function fsFetchDirs(pathValue) {
    const query = pathValue ? "?path=" + encodeURIComponent(pathValue) : "";
    const response = await fetch("/api/fs/dirs" + query, {
      headers: { accept: "application/json" },
    });
    const data = await safeJSON(response);
    if (!response.ok) {
      const message =
        (data && data.error && data.error.message) ||
        (data && data.message) ||
        "无法读取这个目录。";
      return { error: message };
    }
    return data || { error: "目录接口返回了空数据。" };
  }

  function showFsError(message) {
    state.fsError = message || "";
    if (!els.fsError) return;
    els.fsError.hidden = !state.fsError;
    els.fsError.textContent = state.fsError;
  }

  function openDirPicker(initialPath) {
    if (!state.wsModalOpen) return;
    state.fsPickerOpen = true;
    state.lastFocusFs = document.activeElement;
    showFsError("");
    els.fsModal.hidden = false;
    els.fsScrim.hidden = false;
    void els.fsModal.offsetWidth;
    els.fsModal.classList.add("is-open");
    els.fsScrim.classList.add("is-open");
    updateScrollLock();
    els.fsClose.focus({ preventScroll: true });
    const startPath =
      initialPath ||
      els.wsPathInput.value.trim() ||
      state.fsPath ||
      defaultWorkspacePath() ||
      state.fsHome;
    browseDir(startPath);
  }

  async function browseDir(pathValue) {
    state.fsLoading = true;
    renderDirPickerBody();
    let data;
    try {
      data = MOCK ? fsMockBrowse(pathValue) : await fsFetchDirs(pathValue);
    } catch (error) {
      data = { error: "读取目录失败，扫描服务可能已经退出。" };
    }
    state.fsLoading = false;
    if (!data || data.error) {
      if (pathValue) state.fsPath = String(pathValue);
      state.fsEntries = [];
      showFsError((data && data.error) || "无法读取这个目录。");
      renderDirPickerBody();
      return;
    }
    state.fsPath = data.path || pathValue || "";
    state.fsRealPath = data.realPath || state.fsPath;
    state.fsParent = data.parent || null;
    state.fsIsRoot = Boolean(data.isRoot);
    if (typeof data.home === "string" && data.home) state.fsHome = data.home;
    state.fsEntries = Array.isArray(data.entries) ? data.entries : [];
    showFsError("");
    renderDirPickerBody();
  }

  function renderDirPickerBody() {
    els.fsPath.textContent = state.fsPath || "…";
    els.fsUp.disabled = state.fsLoading || !state.fsParent || state.fsIsRoot;
    els.fsChoose.disabled = state.fsLoading || !state.fsPath || Boolean(state.fsError);
    if (state.fsLoading) {
      els.fsList.innerHTML = '<li class="fs-loading-item">正在读取目录…</li>';
      els.fsEmpty.hidden = true;
      return;
    }
    els.fsEmpty.hidden = state.fsEntries.length > 0 || Boolean(state.fsError);
    els.fsList.innerHTML = state.fsEntries
      .map(
        (entry) =>
          '<li class="fs-item"><button class="fs-item-button" type="button" data-fs-path="' +
          esc(entry.path) +
          '"><span class="fs-item-icon">' +
          FOLDER_ICON +
          '</span><span class="fs-item-name">' +
          esc(entry.name) +
          "</span>" +
          (entry.hasProjectMarker ? '<span class="fs-item-tag">项目</span>' : "") +
          '<span class="fs-item-arrow" aria-hidden="true">' +
          CHEVRON_ICON +
          "</span></button></li>"
      )
      .join("");
  }

  function chooseDir() {
    if (!state.fsPath) return;
    els.wsPathInput.value = state.fsPath;
    clearWsError();
    closeDirPicker(true);
  }

  function closeDirPicker(restoreFocus) {
    if (!state.fsPickerOpen) return;
    state.fsPickerOpen = false;
    els.fsModal.classList.remove("is-open");
    els.fsScrim.classList.remove("is-open");
    window.setTimeout(() => {
      if (!state.fsPickerOpen) {
        els.fsModal.hidden = true;
        els.fsScrim.hidden = true;
      }
    }, 300);
    updateScrollLock();
    if (restoreFocus !== false) {
      const target =
        state.lastFocusFs && document.contains(state.lastFocusFs)
          ? state.lastFocusFs
          : els.wsBrowseButton;
      if (target) target.focus({ preventScroll: true });
    }
    state.lastFocusFs = null;
  }

  /* ---------- 设置弹层：隐藏项目 ---------- */

  function renderSettingsModal() {
    if (!els.settingsList) return;
    renderMonitorSetting();
    renderLlmSection();
    renderUpdateSetting();
    els.settingsHiddenCount.textContent = "已隐藏 " + hiddenProjectCount() + " 个项目";
    const query = state.settingsQuery.trim().toLowerCase();
    let list = state.projects.slice().sort((a, b) => {
      const hiddenDiff = (b.hidden === true ? 1 : 0) - (a.hidden === true ? 1 : 0);
      if (hiddenDiff !== 0) return hiddenDiff;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    if (query) {
      list = list.filter((project) => {
        const haystack = [
          project.name,
          project.workspaceName,
          project.path,
          project.dir,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.indexOf(query) >= 0;
      });
    }
    if (!list.length) {
      els.settingsList.innerHTML = "";
      els.settingsEmpty.hidden = false;
      els.settingsEmpty.textContent =
        state.projects.length === 0
          ? "还没有扫描到项目，扫描完成后可以在这里隐藏项目。"
          : "没有匹配的项目，换个关键词试试。";
      return;
    }
    els.settingsEmpty.hidden = true;
    els.settingsList.innerHTML = list
      .map((project) => {
        const pending = state.hiddenSaving.has(project.id);
        const visible = project.hidden !== true;
        return (
          '<li class="settings-row' +
          (pending ? " is-saving" : "") +
          '">' +
          '<div class="settings-label">' +
          '<span class="settings-main">' +
          '<span class="settings-name">' +
          esc(project.name) +
          "</span>" +
          '<span class="settings-meta"><span class="settings-ws">' +
          esc(project.workspaceName || "默认工作区") +
          '</span><span class="settings-path" title="' +
          esc(project.path || "") +
          '">' +
          esc(project.path || "路径未知") +
          "</span></span></span>" +
          '<button class="settings-eye" type="button" role="switch" data-hidden-id="' +
          esc(project.id) +
          '" aria-checked="' +
          (visible ? "true" : "false") +
          '" aria-label="' +
          esc((visible ? "隐藏 " : "显示 ") + project.name) +
          '"' +
          (pending ? " disabled" : "") +
          ">" +
          (visible ? EYE_OPEN_ICON : EYE_CLOSED_ICON) +
          "</button></div></li>"
        );
      })
      .join("");
  }

  function showSettingsError(message) {
    state.settingsError = message || "";
    if (!els.settingsError) return;
    els.settingsError.hidden = !state.settingsError;
    els.settingsError.textContent = state.settingsError;
  }

  function clearSettingsError() {
    showSettingsError("");
  }

  function applyHiddenState(topId, hidden) {
    const project = state.projects.filter((item) => item.id === topId)[0];
    if (!project) return;
    project.hidden = hidden;
    (project.children || []).forEach((child) => {
      child.hidden = hidden;
    });
  }

  function syncSettingsRow(topId) {
    const project = state.projects.filter((item) => item.id === topId)[0];
    if (!project || !els.settingsList) return;
    const button = els.settingsList.querySelector('[data-hidden-id="' + attrEsc(topId) + '"]');
    if (button) {
      const visible = project.hidden !== true;
      const pending = state.hiddenSaving.has(topId);
      const focused = document.activeElement === button;
      button.setAttribute("aria-checked", visible ? "true" : "false");
      button.setAttribute("aria-label", (visible ? "隐藏 " : "显示 ") + project.name);
      button.innerHTML = visible ? EYE_OPEN_ICON : EYE_CLOSED_ICON;
      button.disabled = pending;
      if (pending && focused) button.dataset.restoreFocus = "true";
      if (!pending && button.dataset.restoreFocus === "true") {
        delete button.dataset.restoreFocus;
        if (document.activeElement === document.body || document.activeElement === null) {
          button.focus({ preventScroll: true });
        }
      }
      const row = button.closest(".settings-row");
      if (row) row.classList.toggle("is-saving", pending);
    }
    els.settingsHiddenCount.textContent = "已隐藏 " + hiddenProjectCount() + " 个项目";
  }

  async function toggleProjectHidden(id, hidden) {
    const target = getProject(id);
    if (!target) return;
    const top = target.parentId ? getProject(target.parentId) : target;
    if (!top || state.hiddenSaving.has(top.id)) return;
    const previous = top.hidden === true;
    if (previous === hidden) return;
    clearSettingsError();
    state.hiddenSaving.set(top.id, true);
    applyHiddenState(top.id, hidden);
    syncSettingsRow(top.id);
    renderStatusSeg();
    renderList();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        state.hiddenSaving.delete(top.id);
        syncSettingsRow(top.id);
        renderStatusSeg();
        renderList();
        toast(
          "演示模式 · 不会写入后端（" + (hidden ? "已隐藏 " : "已恢复 ") + top.name + "）"
        );
        return;
      }
      const response = await fetch(
        "/api/projects/" + encodeURIComponent(top.id) + "/hidden",
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ hidden: hidden }),
        }
      );
      const data = await safeJSON(response);
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      state.hiddenSaving.delete(top.id);
      if (data && data.project) {
        const project = normalizeProject(data.project);
        const index = state.projects.findIndex((item) => item.id === project.id);
        if (index >= 0) state.projects[index] = project;
        else applyHiddenState(top.id, hidden);
      } else {
        applyHiddenState(top.id, hidden);
      }
      if (data && Number.isFinite(data.hiddenCount)) {
        state.meta = Object.assign({}, state.meta || {}, { hiddenCount: data.hiddenCount });
      }
      syncSettingsRow(top.id);
      renderStatusSeg();
      renderList();
      toast(hidden ? "已隐藏 · " + top.name : "已恢复 · " + top.name);
    } catch (error) {
      state.hiddenSaving.delete(top.id);
      applyHiddenState(top.id, previous);
      syncSettingsRow(top.id);
      renderStatusSeg();
      renderList();
      const message = (error && error.message) || "操作失败，请稍后重试。";
      showSettingsError("隐藏状态没有保存：" + message);
      toast("隐藏操作失败，已回滚", { error: true });
    }
  }

  function openSettingsModal() {
    if (state.settingsOpen) return;
    state.settingsOpen = true;
    state.lastFocusSettings = document.activeElement;
    state.settingsQuery = "";
    els.settingsSearch.value = "";
    state.updateError = "";
    clearSettingsError();
    renderSettingsModal();
    setSettingsTab("monitor");
    els.settingsModal.hidden = false;
    els.settingsScrim.hidden = false;
    void els.settingsModal.offsetWidth;
    els.settingsModal.classList.add("is-open");
    els.settingsScrim.classList.add("is-open");
    updateScrollLock();
    syncSettingsModalHeight();
    ensureLlmChannelsLoaded();
    const activeTab = settingsTabButton("monitor");
    if (activeTab) activeTab.focus({ preventScroll: true });
  }

  function closeSettingsModal() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    els.settingsModal.classList.remove("is-open");
    els.settingsScrim.classList.remove("is-open");
    window.setTimeout(() => {
      if (!state.settingsOpen) {
        els.settingsModal.hidden = true;
        els.settingsScrim.hidden = true;
      }
    }, 300);
    updateScrollLock();
    if (state.lastFocusSettings && document.contains(state.lastFocusSettings)) {
      state.lastFocusSettings.focus({ preventScroll: true });
    }
    state.lastFocusSettings = null;
  }

  /* ---------- 设置弹层：Tab 分组 ---------- */

  function settingsTabButton(name) {
    return (
      els.settingsTabButtons.filter(
        (button) => button.getAttribute("data-settings-tab") === name
      )[0] || null
    );
  }

  function setSettingsTab(name, options) {
    const opts = options || {};
    if (!els.settingsTabs || SETTINGS_TABS.indexOf(name) < 0) return;
    state.settingsTab = name;
    els.settingsTabButtons.forEach((button) => {
      const active = button.getAttribute("data-settings-tab") === name;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    SETTINGS_TABS.forEach((key) => {
      const panel = document.getElementById("settings-panel-" + key);
      if (panel) panel.hidden = key !== name;
    });
    if (opts.focus) {
      const button = settingsTabButton(name);
      if (button) button.focus({ preventScroll: true });
    }
  }

  function handleSettingsTabClick(event) {
    const button = event.target.closest("[data-settings-tab]");
    if (!button) return;
    setSettingsTab(button.getAttribute("data-settings-tab"), { focus: true });
  }

  function handleSettingsTabsKeydown(event) {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0) return;
    event.preventDefault();
    const index = SETTINGS_TABS.indexOf(state.settingsTab);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SETTINGS_TABS.length - 1;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else {
      next = (index + 1) % SETTINGS_TABS.length;
    }
    setSettingsTab(SETTINGS_TABS[next], { focus: true });
  }

  function measureSettingsModalHeight() {
    if (!els.settingsModal) return 0;
    const modal = els.settingsModal;
    const previousHeight = modal.style.height;
    modal.style.height = "auto";
    SETTINGS_TABS.forEach((key) => {
      const panel = document.getElementById("settings-panel-" + key);
      if (panel) panel.hidden = key !== "hidden";
    });
    const measured = modal.offsetHeight;
    SETTINGS_TABS.forEach((key) => {
      const panel = document.getElementById("settings-panel-" + key);
      if (panel) panel.hidden = key !== state.settingsTab;
    });
    modal.style.height = previousHeight;
    return measured;
  }

  function syncSettingsModalHeight() {
    if (!els.settingsModal || !state.settingsOpen) return;
    const measured = measureSettingsModalHeight();
    if (measured > 0) els.settingsModal.style.height = measured + "px";
  }

  /* ---------- 设置弹层：自动更新 ---------- */

  function hasUpdateToastShown() {
    try {
      return window.sessionStorage.getItem(UPDATE_TOAST_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function markUpdateToastShown() {
    try {
      window.sessionStorage.setItem(UPDATE_TOAST_KEY, "1");
    } catch (error) {
      /* 隐私模式下不可用则忽略 */
    }
  }

  function maybeNotifyUpdateResult(status) {
    const last = status && status.lastResult;
    if (!last || last.status !== "updated") return;
    if (hasUpdateToastShown()) return;
    let message = "已自动更新到最新版本";
    if (last.needRestart) message = "已自动更新到新版本，需重启服务后生效";
    else if (last.needRefresh) message = "页面已更新，刷新后生效";
    else if (last.onlyStyle) message = "样式已更新";
    markUpdateToastShown();
    toast(message);
  }

  function normalizeUpdateStatus(payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    let lastResult = null;
    if (data.lastResult && typeof data.lastResult === "object") {
      const last = data.lastResult;
      lastResult = {
        status: last.status ? String(last.status) : "",
        message: last.message ? String(last.message) : "",
        changedFiles: Array.isArray(last.changedFiles)
          ? last.changedFiles.map(String)
          : [],
        needRestart: last.needRestart === true,
        needRefresh: last.needRefresh === true,
        onlyStyle: last.onlyStyle === true,
      };
    }
    return {
      enabled: data.enabled !== false,
      checking: data.checking === true,
      lastCheckedAt: data.lastCheckedAt ? String(data.lastCheckedAt) : null,
      lastResult: lastResult,
    };
  }

  function scheduleUpdatePoll() {
    if (state.updatePollTimer) return;
    state.updatePollTimer = window.setTimeout(() => {
      state.updatePollTimer = null;
      if (state.updateChecking) loadUpdateStatus({ silent: true });
    }, 1500);
  }

  function applyUpdateStatus(payload) {
    const status = normalizeUpdateStatus(payload);
    state.updateStatus = status;
    state.updateStatusLoaded = true;
    state.updateChecking = status.checking;
    state.updateCheckMessage = "";
    renderUpdateSetting();
    maybeNotifyUpdateResult(status);
    if (status.checking) scheduleUpdatePoll();
  }

  async function loadUpdateStatus(options) {
    const opts = options || {};
    if (MOCK) {
      if (!state.mockUpdateStatus) state.mockUpdateStatus = MOCK_UPDATE_STATUS;
      applyUpdateStatus(state.mockUpdateStatus);
      return;
    }
    if (state.updateLoading) return;
    state.updateLoading = true;
    try {
      const response = await fetch("/api/update/status", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(errorMessage(null, response.status));
      const data = await safeJSON(response);
      applyUpdateStatus(data);
    } catch (error) {
      if (!opts.silent) {
        state.updateError =
          "更新状态读取失败：" + ((error && error.message) || "请稍后重试");
      }
    }
    state.updateLoading = false;
    renderUpdateSetting();
  }

  function renderUpdateSetting() {
    if (!els.updateToggle) return;
    els.updateToggle.setAttribute("aria-checked", state.autoUpdate ? "true" : "false");
    els.updateToggle.disabled = state.updateSaving;
    els.updateToggle.setAttribute("aria-busy", state.updateSaving ? "true" : "false");
    if (els.updateError) {
      els.updateError.hidden = !state.updateError;
      els.updateError.textContent = state.updateError || "";
    }
    const status = state.updateStatus;
    const checking = state.updateChecking || Boolean(status && status.checking);
    if (els.updateCheck) {
      els.updateCheck.disabled = checking;
      els.updateCheck.setAttribute("aria-busy", checking ? "true" : "false");
      els.updateCheck.textContent = checking ? "检查中…" : "立即检查更新";
    }
    if (els.updateStatus) {
      const parts = [];
      if (checking) parts.push("检查中…");
      else if (!state.updateStatusLoaded) parts.push("正在读取更新状态…");
      else if (status) parts.push(status.enabled ? "自动更新已开启" : "自动更新已关闭");
      if (status && status.lastCheckedAt) {
        parts.push("上次检查 " + formatRelative(status.lastCheckedAt));
      }
      if (state.updateCheckMessage) parts.push(state.updateCheckMessage);
      if (status && status.lastResult && status.lastResult.message) {
        parts.push(status.lastResult.message);
      }
      els.updateStatus.textContent = parts.length ? parts.join(" · ") : "暂无更新信息";
    }
    const last = status && status.lastResult;
    if (els.updateRestart) {
      els.updateRestart.hidden = !(last && last.status === "updated" && last.needRestart);
    }
    if (els.updateRefresh) {
      els.updateRefresh.hidden = !(last && last.needRefresh);
    }
  }

  async function toggleAutoUpdate() {
    if (state.updateSaving) return;
    const previous = state.autoUpdate;
    const next = !previous;
    state.updateSaving = true;
    state.autoUpdate = next;
    state.updateError = "";
    renderUpdateSetting();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        state.updateSaving = false;
        state.mockUpdateStatus = Object.assign({}, state.mockUpdateStatus || MOCK_UPDATE_STATUS, {
          enabled: next,
        });
        state.updateStatus = normalizeUpdateStatus(state.mockUpdateStatus);
        renderUpdateSetting();
        toast("演示模式 · 不会写入后端（" + (next ? "已开启" : "已关闭") + "自动更新）");
        return;
      }
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ autoUpdate: next }),
      });
      const data = await safeJSON(response);
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      state.updateSaving = false;
      if (data && data.settings && typeof data.settings.autoUpdate === "boolean") {
        state.autoUpdate = data.settings.autoUpdate;
      }
      if (state.updateStatus) {
        state.updateStatus = Object.assign({}, state.updateStatus, {
          enabled: state.autoUpdate,
        });
      }
      renderUpdateSetting();
      toast(state.autoUpdate ? "已开启自动更新" : "已关闭自动更新");
    } catch (error) {
      state.updateSaving = false;
      state.autoUpdate = previous;
      state.updateError =
        "自动更新开关没有保存：" + ((error && error.message) || "请稍后重试");
      renderUpdateSetting();
      toast("自动更新开关保存失败，已回滚", { error: true });
    }
  }

  async function checkForUpdates() {
    if (state.updateChecking) return;
    state.updateError = "";
    state.updateCheckMessage = "";
    if (MOCK) {
      state.updateChecking = true;
      renderUpdateSetting();
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      state.updateChecking = false;
      state.mockUpdateStatus = {
        enabled: state.autoUpdate,
        checking: false,
        lastCheckedAt: new Date().toISOString(),
        lastResult: {
          status: "up-to-date",
          message: "演示模式：已是最新版本",
          changedFiles: [],
          needRestart: false,
          needRefresh: false,
          onlyStyle: false,
        },
      };
      state.updateStatus = normalizeUpdateStatus(state.mockUpdateStatus);
      state.updateStatusLoaded = true;
      renderUpdateSetting();
      toast("演示模式 · 不会请求后端（已模拟检查完成）");
      return;
    }
    try {
      const response = await fetch("/api/update/check", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (response.status === 202 || response.status === 200 || response.status === 409) {
        state.updateChecking = Boolean(data && data.checking);
        state.updateCheckMessage = data && data.message ? String(data.message) : "";
        renderUpdateSetting();
        if (state.updateChecking) scheduleUpdatePoll();
        return;
      }
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      state.updateChecking = Boolean(data && data.checking);
      state.updateCheckMessage = data && data.message ? String(data.message) : "";
      renderUpdateSetting();
    } catch (error) {
      state.updateChecking = false;
      state.updateCheckMessage = "";
      state.updateError = "检查更新失败：" + ((error && error.message) || "请稍后重试");
      renderUpdateSetting();
      toast("检查更新失败", { error: true });
    }
  }

  /* ---------- 设置弹层：AI 摘要渠道 ---------- */

  function llmChannelById(id) {
    if (!id) return null;
    return state.llmChannels.filter((channel) => channel.id === id)[0] || null;
  }

  function llmChannelModels(channel) {
    return channel && Array.isArray(channel.models) ? channel.models : [];
  }

  function llmChannelSelectable(channel) {
    return Boolean(
      channel && channel.keyConfigured !== false && llmChannelModels(channel).length
    );
  }

  function normalizeLlmSelection(selection) {
    if (!selection || typeof selection !== "object") return null;
    const provider = selection.provider ? String(selection.provider) : "";
    const model = selection.model ? String(selection.model) : "";
    if (!provider || !model) return null;
    return { provider: provider, model: model };
  }

  function normalizeLlmPayload(payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    const channels = (Array.isArray(data.channels) ? data.channels : [])
      .filter((channel) => channel && typeof channel === "object" && channel.id)
      .map((channel) => ({
        id: String(channel.id),
        name: channel.name ? String(channel.name) : String(channel.id),
        api: channel.api ? String(channel.api) : "",
        keyConfigured: channel.keyConfigured !== false,
        keyMasked: channel.keyMasked ? String(channel.keyMasked) : "",
        models: (Array.isArray(channel.models) ? channel.models : [])
          .filter((model) => model && typeof model === "object" && model.id)
          .map((model) => ({
            id: String(model.id),
            name: model.name ? String(model.name) : String(model.id),
          })),
        defaultModel: channel.defaultModel ? String(channel.defaultModel) : "",
        reason: channel.reason ? String(channel.reason) : null,
      }));
    return {
      selection: normalizeLlmSelection(data.selection),
      effective: data.effective && typeof data.effective === "object" ? data.effective : null,
      channels: channels,
    };
  }

  function applyLlmPayload(payload) {
    const normalized = normalizeLlmPayload(payload);
    state.llmChannels = normalized.channels;
    state.llmSelection = normalized.selection;
    state.llmEffective = normalized.effective;
  }

  function llmModelForSelection(channel, selection) {
    const models = llmChannelModels(channel);
    if (!models.length) return "";
    if (
      selection &&
      selection.provider === channel.id &&
      models.some((model) => model.id === selection.model)
    ) {
      return selection.model;
    }
    if (
      channel.defaultModel &&
      models.some((model) => model.id === channel.defaultModel)
    ) {
      return channel.defaultModel;
    }
    return models[0].id;
  }

  function llmStatusText() {
    if (state.llmLoading) return "正在读取本机 DSH 渠道…";
    if (state.llmLoadFailed) return "无法读取 DSH 渠道，摘要暂用文档启发式";
    if (!state.llmChannels.length) return "未发现 DSH 渠道，使用文档启发式摘要";
    const effective = state.llmEffective || {};
    if (state.llmSelection && state.llmSelection.model) {
      const channel = llmChannelById(state.llmSelection.provider);
      const channelName =
        (channel && channel.name) ||
        effective.channelName ||
        state.llmSelection.provider ||
        "DSH";
      return "当前摘要模型：" + state.llmSelection.model + "（" + channelName + "）";
    }
    return (
      "当前摘要模型：" +
      (effective.model || "跟随 DSH 默认") +
      "（" +
      (effective.channelName || effective.provider || "DSH 默认") +
      "）"
    );
  }

  function renderLlmEnabledSetting() {
    if (!els.llmEnabledToggle) return;
    els.llmEnabledToggle.setAttribute("aria-checked", state.llmEnabled !== false ? "true" : "false");
    els.llmEnabledToggle.disabled = state.llmEnabledSaving;
    els.llmEnabledToggle.setAttribute("aria-busy", state.llmEnabledSaving ? "true" : "false");
    if (els.llmEnabledError) {
      els.llmEnabledError.hidden = !state.llmEnabledError;
      els.llmEnabledError.textContent = state.llmEnabledError || "";
    }
  }

  async function toggleLlmEnabled() {
    if (state.llmEnabledSaving) return;
    const previous = state.llmEnabled !== false;
    const next = !previous;
    state.llmEnabledSaving = true;
    state.llmEnabled = next;
    state.llmEnabledError = "";
    renderLlmEnabledSetting();
    renderLlmSection();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        state.llmEnabledSaving = false;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, { llmEnabled: next });
        renderLlmEnabledSetting();
        renderLlmSection();
        toast("演示模式 · 不会写入后端（" + (next ? "已开启" : "已关闭") + "AI 摘要）");
        return;
      }
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ llmEnabled: next }),
      });
      const data = await safeJSON(response);
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      state.llmEnabledSaving = false;
      if (data && data.settings && typeof data.settings.llmEnabled === "boolean") {
        state.llmEnabled = data.settings.llmEnabled;
      }
      if (data && data.llm && state.meta) {
        state.meta.llm = Object.assign({}, state.meta.llm || {}, data.llm);
        renderHeroMeta();
      }
      renderLlmEnabledSetting();
      renderLlmSection();
      toast(
        state.llmEnabled
          ? "已开启 AI 摘要，正在生成摘要…"
          : "已关闭 AI 摘要，已有摘要保留，其余使用 README 说明"
      );
    } catch (error) {
      state.llmEnabledSaving = false;
      state.llmEnabled = previous;
      state.llmEnabledError = "AI 摘要开关没有保存：" + ((error && error.message) || "请稍后重试");
      renderLlmEnabledSetting();
      renderLlmSection();
      toast("AI 摘要开关保存失败，已回滚", { error: true });
    }
  }

  function renderLlmSection() {
    if (!els.llmChannel || !els.llmModel) return;
    const busy = state.llmLoading || state.llmSaving;
    const llmOff = state.llmEnabled === false;
    const locked = busy || state.llmLoadFailed;
    const selectedChannel =
      state.llmSelection && state.llmSelection.provider
        ? llmChannelById(state.llmSelection.provider)
        : null;
    const channelValue = llmChannelSelectable(selectedChannel) ? selectedChannel.id : "";
    els.llmChannel.innerHTML =
      '<option value="">跟随 DSH 默认（推荐）</option>' +
      state.llmChannels
        .map((channel) => {
          let label = channel.name || channel.id;
          if (channel.keyConfigured === false) label += " · 未配置 key";
          else if (!llmChannelModels(channel).length) label += " · 无可用模型";
          return (
            '<option value="' +
            esc(channel.id) +
            '"' +
            (llmChannelSelectable(channel) ? "" : " disabled") +
            ">" +
            esc(label) +
            "</option>"
          );
        })
        .join("");
    els.llmChannel.value = channelValue;
    els.llmChannel.disabled = locked || !state.llmChannels.length || llmOff;
    els.llmChannel.setAttribute("aria-busy", busy ? "true" : "false");

    const activeChannel = channelValue ? llmChannelById(channelValue) : null;
    if (activeChannel) {
      const desiredModel = llmModelForSelection(activeChannel, state.llmSelection);
      els.llmModel.innerHTML = llmChannelModels(activeChannel)
        .map(
          (model) =>
            '<option value="' +
            esc(model.id) +
            '"' +
            (model.id === desiredModel ? " selected" : "") +
            ">" +
            esc(model.name || model.id) +
            "</option>"
        )
        .join("");
      els.llmModel.value = desiredModel;
      els.llmModel.disabled = locked || llmOff;
    } else {
      const effectiveModel =
        state.llmEffective && state.llmEffective.model ? state.llmEffective.model : "";
      els.llmModel.innerHTML =
        '<option value="">' + esc(effectiveModel || "跟随 DSH 默认") + "</option>";
      els.llmModel.value = "";
      els.llmModel.disabled = true;
    }
    els.llmModel.setAttribute("aria-busy", busy ? "true" : "false");

    els.llmStatus.textContent = llmOff
      ? "AI 摘要已关闭 · 没有 AI 摘要的项目使用 README / 文档说明"
      : llmStatusText();
    if (els.llmError) {
      els.llmError.hidden = !state.llmError;
      els.llmError.textContent = state.llmError || "";
    }
    if (els.llmRetry) els.llmRetry.hidden = !state.llmLoadFailed;
  }

  function showLlmError(message) {
    state.llmError = message || "";
    if (!els.llmError) return;
    els.llmError.hidden = !state.llmError;
    els.llmError.textContent = state.llmError;
  }

  async function ensureLlmChannelsLoaded() {
    if (state.llmLoaded || state.llmLoading) return;
    await loadLlmChannels();
  }

  async function loadLlmChannels() {
    if (state.llmLoading) return;
    state.llmLoading = true;
    state.llmLoadFailed = false;
    state.llmError = "";
    renderLlmSection();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        applyLlmPayload(MOCK_LLM_CHANNELS);
      } else {
        const response = await fetch("/api/llm/channels", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        const data = await safeJSON(response);
        if (!response.ok) throw new Error(errorMessage(data, response.status));
        applyLlmPayload(data);
      }
      state.llmLoaded = true;
    } catch (error) {
      state.llmLoadFailed = true;
      state.llmError =
        "无法读取本机 DSH 渠道：" + ((error && error.message) || "请稍后重试");
    }
    state.llmLoading = false;
    renderLlmSection();
  }

  function llmSelectionDescription(selection) {
    if (!selection) return "已切换为跟随 DSH 默认";
    const channel = llmChannelById(selection.provider);
    const model = channel
      ? llmChannelModels(channel).filter((item) => item.id === selection.model)[0]
      : null;
    return (
      "已选择 " +
      ((channel && channel.name) || selection.provider) +
      " · " +
      ((model && model.name) || selection.model)
    );
  }

  function mockLlmEffective(selection) {
    const base = MOCK_LLM_CHANNELS.effective;
    if (!selection) return Object.assign({}, base, { source: "default" });
    const channel = llmChannelById(selection.provider);
    return Object.assign({}, base, {
      source: "custom",
      provider: selection.provider,
      model: selection.model,
      channelName: (channel && channel.name) || selection.provider,
      api: (channel && channel.api) || base.api,
      keyMasked: (channel && channel.keyMasked) || base.keyMasked,
    });
  }

  async function saveLlmSelection(nextSelection) {
    const previous = {
      selection: state.llmSelection,
      effective: state.llmEffective,
    };
    const description = llmSelectionDescription(nextSelection);
    state.llmSelection = nextSelection;
    state.llmSaving = true;
    state.llmError = "";
    renderLlmSection();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        state.llmEffective = mockLlmEffective(nextSelection);
      } else {
        const response = await fetch("/api/llm/selection", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ selection: nextSelection }),
        });
        const data = await safeJSON(response);
        if (!response.ok) throw new Error(errorMessage(data, response.status));
        state.llmSelection = normalizeLlmSelection(data && data.selection);
        if (data && data.effective && typeof data.effective === "object") {
          state.llmEffective = data.effective;
        }
      }
      state.llmSaving = false;
      renderLlmSection();
      toast(
        MOCK ? "演示模式 · 不会写入后端（" + description + "）" : description
      );
    } catch (error) {
      state.llmSaving = false;
      state.llmSelection = previous.selection;
      state.llmEffective = previous.effective;
      showLlmError("摘要渠道没有保存：" + ((error && error.message) || "请稍后重试"));
      renderLlmSection();
      toast("摘要渠道保存失败，已回滚", { error: true });
    }
  }

  async function handleLlmChannelChange() {
    if (state.llmSaving || !els.llmChannel) return;
    const channelId = els.llmChannel.value;
    if (!channelId) {
      await saveLlmSelection(null);
      return;
    }
    const channel = llmChannelById(channelId);
    if (!llmChannelSelectable(channel)) {
      renderLlmSection();
      return;
    }
    await saveLlmSelection({
      provider: channel.id,
      model: llmModelForSelection(channel, null),
    });
  }

  async function handleLlmModelChange() {
    if (state.llmSaving || !els.llmChannel || !els.llmModel) return;
    const channel = llmChannelById(els.llmChannel.value);
    if (!llmChannelSelectable(channel)) {
      renderLlmSection();
      return;
    }
    const model = els.llmModel.value;
    if (!model) return;
    await saveLlmSelection({ provider: channel.id, model: model });
  }

  /* ---------- 运行监控 ---------- */

  function renderMonitorSetting() {
    if (!els.monitorToggle) return;
    els.monitorToggle.setAttribute("aria-checked", state.monitorEnabled ? "true" : "false");
    els.monitorToggle.disabled = state.monitorSaving;
    els.monitorToggle.setAttribute("aria-busy", state.monitorSaving ? "true" : "false");
  }

  function showMonitorError(message) {
    if (!els.monitorError) return;
    els.monitorError.hidden = !message;
    els.monitorError.textContent = message || "";
  }

  async function ensureSettingsLoaded() {
    if (state.settingsLoaded) return;
    state.settingsLoaded = true;
    if (MOCK) {
      const mock = state.mockSettings || {};
      state.monitorEnabled = mock.monitorEnabled === true;
      if (typeof mock.autoUpdate === "boolean") state.autoUpdate = mock.autoUpdate;
      if (typeof mock.llmEnabled === "boolean") state.llmEnabled = mock.llmEnabled;
      renderMonitorSetting();
      renderUpdateSetting();
      renderLlmEnabledSetting();
      if (els.llmChannel) renderLlmSection();
      applyMonitorAvailability();
      return;
    }
    try {
      const response = await fetch("/api/settings", { headers: { accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data === "object") {
          state.monitorEnabled = data.monitorEnabled === true;
          if (typeof data.autoUpdate === "boolean") state.autoUpdate = data.autoUpdate;
          if (typeof data.llmEnabled === "boolean") state.llmEnabled = data.llmEnabled;
          if (Number.isFinite(data.intervalMs)) state.monitorIntervalMs = data.intervalMs;
        }
      }
    } catch (error) {
      /* 设置接口不可用时保持默认关闭 */
    }
    renderMonitorSetting();
    renderUpdateSetting();
    renderLlmEnabledSetting();
    if (els.llmChannel) renderLlmSection();
    applyMonitorAvailability();
  }

  function applyMonitorAvailability() {
    if (!state.monitorEnabled) {
      state.monitor = null;
      if (state.mockMonitorTimer) {
        window.clearInterval(state.mockMonitorTimer);
        state.mockMonitorTimer = null;
      }
    }
    syncMonitorPolling();
    renderList();
    updateOpenDrawersMonitor();
  }

  async function toggleMonitor() {
    if (state.monitorSaving) return;
    const previous = state.monitorEnabled;
    const next = !previous;
    state.monitorSaving = true;
    state.monitorEnabled = next;
    renderMonitorSetting();
    showMonitorError("");
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        state.monitorSaving = false;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, {
          monitorEnabled: next,
        });
        renderMonitorSetting();
        applyMonitorAvailability();
        toast("演示模式 · 不会写入后端（" + (next ? "已开启" : "已关闭") + "运行监控）");
        return;
      }
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ monitorEnabled: next }),
      });
      const data = await safeJSON(response);
      if (!response.ok) throw new Error(errorMessage(data, response.status));
      state.monitorSaving = false;
      if (data && data.settings && typeof data.settings.monitorEnabled === "boolean") {
        state.monitorEnabled = data.settings.monitorEnabled;
      }
      if (data && data.monitor && typeof data.monitor === "object") {
        state.monitor = data.monitor;
      }
      renderMonitorSetting();
      applyMonitorAvailability();
      toast(state.monitorEnabled ? "已开启运行监控 · 每秒采样" : "已关闭运行监控");
    } catch (error) {
      state.monitorSaving = false;
      state.monitorEnabled = previous;
      renderMonitorSetting();
      applyMonitorAvailability();
      showMonitorError("监控开关没有保存：" + ((error && error.message) || "请稍后重试"));
      toast("监控开关保存失败，已回滚", { error: true });
    }
  }

  function syncMonitorPolling() {
    const visible = document.visibilityState !== "hidden";
    const running = hasRunningProjects();
    if (MOCK) {
      const shouldMock = state.monitorEnabled && running && visible;
      if (shouldMock && !state.mockMonitorTimer) {
        state.mockMonitorTick = 0;
        mockMonitorTick();
        state.mockMonitorTimer = window.setInterval(mockMonitorTick, 1000);
      } else if (!shouldMock && state.mockMonitorTimer) {
        window.clearInterval(state.mockMonitorTimer);
        state.mockMonitorTimer = null;
        state.monitor = null;
        updateMonitorDom();
        updateOpenDrawersMonitor();
      }
      return;
    }
    const shouldPoll = state.monitorEnabled && running && visible;
    if (shouldPoll && !state.monitorTimer) {
      state.monitorTimer = window.setInterval(pollMonitor, state.monitorIntervalMs || 1000);
      pollMonitor();
    } else if (!shouldPoll && state.monitorTimer) {
      window.clearInterval(state.monitorTimer);
      state.monitorTimer = null;
    }
  }

  async function pollMonitor() {
    if (state.monitorInFlight || MOCK) return;
    state.monitorInFlight = true;
    try {
      const response = await fetch("/api/monitor", { headers: { accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data === "object") {
          state.monitor = data;
          state.monitorError = "";
        }
      } else {
        state.monitorError = "监控数据读取失败（HTTP " + response.status + "）";
      }
    } catch (error) {
      state.monitorError = "监控数据读取失败，扫描服务可能已退出";
    }
    state.monitorInFlight = false;
    updateMonitorDom();
    updateOpenDrawersMonitor();
  }

  function mockMonitorTick() {
    state.mockMonitorTick += 1;
    const tick = state.mockMonitorTick;
    const running = [];
    state.projects.forEach((project) => {
      if (isRunning(project.run)) running.push(project);
      (project.children || []).forEach((child) => {
        if (isRunning(child.run)) running.push(child);
      });
    });
    if (!running.length) {
      state.monitor = null;
      updateMonitorDom();
      updateOpenDrawersMonitor();
      return;
    }
    const projects = running.map((project, index) => {
      const wave = Math.sin((tick + index * 5) / 3);
      return {
        projectId: project.id,
        pid: 48000 + index * 137,
        processCount: 2 + ((tick + index) % 4),
        cpuPercent: Math.max(
          2,
          12 + index * 9 + wave * 8 + ((tick * 7 + index * 13) % 11)
        ),
        memoryBytes: (180 + index * 90 + Math.sin(tick / 6 + index) * 12) * 1024 * 1024,
        gpuPercent: null,
        netRxBytesPerSec: Math.max(0, ((tick * 371 + index * 913) % 2600) * 1024),
        netTxBytesPerSec: Math.max(0, ((tick * 97 + index * 211) % 420) * 1024),
      };
    });
    state.monitor = {
      enabled: true,
      sampling: true,
      intervalMs: 1000,
      at: new Date().toISOString(),
      supported: state.mockUnsupported
        ? { cpu: false, gpuPerProcess: false, network: false }
        : { cpu: true, gpuPerProcess: false, network: true },
      system: {
        cpuPercent: Math.max(5, 18 + Math.sin(tick / 4) * 9),
        gpuPercent: Math.max(0, 12 + Math.sin(tick / 5 + 1) * 8),
        memoryUsedBytes: null,
      },
      projects: projects,
      overhead: {
        ticks: tick,
        ownCpuMs: 1.4,
        commandCalls: tick * 2,
        commandMs: 3.1,
        nettopRunning: true,
      },
    };
    updateMonitorDom();
    updateOpenDrawersMonitor();
  }

  function updateMonitorDom() {
    const nodes = document.querySelectorAll("[data-monitor-for]");
    if (!nodes.length) return;
    const supported = monitorSupported();
    nodes.forEach((node) => {
      const projectId = node.getAttribute("data-monitor-for");
      const metric = monitorMetricFor(projectId);
      const cpuEl = node.querySelector('[data-metric="cpu"]');
      const memEl = node.querySelector('[data-metric="mem"]');
      const netEl = node.querySelector('[data-metric="net"]');
      if (!metric) {
        if (cpuEl) cpuEl.textContent = "CPU 等待采样";
        if (memEl) memEl.textContent = "内存 —";
        if (netEl) netEl.textContent = "↓ — ↑ —";
        return;
      }
      if (cpuEl) {
        cpuEl.textContent =
          supported.cpu === false ? "CPU 不可用" : "CPU " + percentText(metric.cpuPercent);
      }
      if (memEl) {
        memEl.textContent =
          supported.cpu === false ? "内存 不可用" : "内存 " + metricBytes(metric.memoryBytes);
      }
      if (netEl) {
        netEl.textContent =
          supported.network === false
            ? "网络不可用"
            : "↓" +
              rateCompactText(metric.netRxBytesPerSec) +
              " ↑" +
              rateCompactText(metric.netTxBytesPerSec);
      }
    });
  }

  function renderDrawerMonitor(panel, project) {
    if (!panel || !panel.monitorSection) return;
    const visible = state.monitorEnabled && isRunning(project.run);
    panel.monitorSection.hidden = !visible;
    if (!visible) return;
    const snapshot = state.monitor;
    const supported = monitorSupported();
    const metric = monitorMetricFor(project.id);
    const system = (snapshot && snapshot.system) || {};
    const waiting = "等待采样…";
    const rows = [];
    rows.push(
      metaRowHTML(
        "CPU",
        supported.cpu === false
          ? "当前环境不支持读取进程 CPU"
          : metric && Number.isFinite(metric.cpuPercent)
            ? percentText(metric.cpuPercent)
            : waiting,
        true
      )
    );
    rows.push(
      metaRowHTML(
        "内存",
        supported.cpu === false
          ? "当前环境不支持读取进程内存"
          : metric && Number.isFinite(metric.memoryBytes)
            ? metricBytes(metric.memoryBytes)
            : waiting,
        true
      )
    );
    rows.push(
      metaRowHTML(
        "GPU（系统）",
        Number.isFinite(system.gpuPercent) ? percentText(system.gpuPercent) : "—",
        true
      )
    );
    const netText =
      supported.network === false
        ? "当前环境不支持读取网络"
        : metric && Number.isFinite(metric.netRxBytesPerSec)
          ? rateText(metric.netRxBytesPerSec)
          : waiting;
    const netUpText =
      supported.network === false
        ? "当前环境不支持读取网络"
        : metric && Number.isFinite(metric.netTxBytesPerSec)
          ? rateText(metric.netTxBytesPerSec)
          : waiting;
    rows.push(metaRowHTML("网络下行", netText, true));
    rows.push(metaRowHTML("网络上行", netUpText, true));
    rows.push(
      metaRowHTML(
        "进程数",
        metric && Number.isFinite(metric.processCount) ? formatCount(metric.processCount) : "—",
        true
      )
    );
    rows.push(
      metaRowHTML(
        "采样时间",
        snapshot && snapshot.at ? formatClockSeconds(snapshot.at) : "—",
        true
      )
    );
    panel.monitorGrid.innerHTML = rows.join("");
    const notes = ["GPU 为系统级利用率，macOS 无法按进程统计。"];
    if (supported.cpu === false) {
      notes.push("当前环境禁止读取进程 CPU/内存，只保留进程数与系统指标。");
    }
    if (state.monitorError) notes.push(state.monitorError);
    panel.monitorNote.textContent = notes.join(" ");
    panel.monitorNote.classList.toggle("is-error", Boolean(state.monitorError));
    const live = snapshot && snapshot.sampling;
    panel.monitorStatus.innerHTML =
      (live ? '<span class="status-dot" aria-hidden="true"></span>' : "") +
      esc(live ? "采样中" : snapshot ? "已暂停" : "等待采样");
  }

  function updateOpenDrawersMonitor() {
    [1, 2].forEach((level) => {
      const panel = drawerPanels[level];
      if (!panel || !panel.projectId) return;
      const project = getProject(panel.projectId);
      if (project) renderDrawerMonitor(panel, project);
    });
  }

  /* ---------- 运行中弹层 ---------- */

  function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total < 60) return total + " 秒";
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + " 分 " + (total % 60) + " 秒";
    const hours = Math.floor(minutes / 60);
    return hours + " 小时 " + (minutes % 60) + " 分";
  }

  function runningEntriesLocal() {
    const list = [];
    state.projects.forEach((project) => {
      if (isRunning(project.run)) list.push({ project: project, run: project.run, parent: null });
      (project.children || []).forEach((child) => {
        if (isRunning(child.run)) list.push({ project: child, run: child.run, parent: project });
      });
    });
    return list;
  }

  function runningEntryLocal(project, run, parent) {
    const startedAt = run && run.startedAt ? run.startedAt : null;
    const uptimeSec = startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
      : 0;
    return {
      projectId: project.id,
      name: project.name,
      workspaceId: project.workspaceId,
      workspaceName: project.workspaceName,
      parentId: parent ? parent.id : project.parentId || null,
      relPath: project.relPath || "",
      status: run && run.status ? run.status : "running",
      url: run && run.url ? run.url : null,
      pid: run && run.pid ? run.pid : null,
      startedAt: startedAt,
      uptimeSec: uptimeSec,
      command: run && run.command ? run.command : null,
      isScannerProject: project.id === "project-scan",
      external: isExternalRun(run),
      isExternalProject: isExternalRun(run),
    };
  }

  function mockScannerEntry() {
    const uptimeSec = 5400;
    return {
      projectId: null,
      name: "项目雷达扫描器",
      workspaceId: null,
      workspaceName: "本地服务",
      parentId: null,
      relPath: "",
      status: "running",
      url: "http://127.0.0.1:8790/",
      pid: 21661,
      startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
      uptimeSec: uptimeSec,
      command: null,
      isScannerProject: true,
      kind: "scanner",
    };
  }

  function mockRunningData() {
    // 扫描器项目自身的运行态由 mockScannerEntry() 单独表示，避免弹层里出现两行扫描器
    const entries = runningEntriesLocal()
      .filter((item) => item.project.isScanner !== true && item.project.id !== "project-scan")
      .map((item) => runningEntryLocal(item.project, item.run, item.parent));
    return {
      count: entries.length + 1,
      scanner: { pid: 21661, uptimeSec: 5400 },
      projects: [mockScannerEntry()].concat(entries),
    };
  }

  function renderRunningCount() {
    if (!els.runningButton) return;
    // 扫描器服务自身始终在运行；若扫描器项目卡片已带运行态则不重复 +1
    const localEntries = runningEntriesLocal();
    const scannerCardRunning = localEntries.some(
      (item) => item.project.isScanner === true || item.project.id === "project-scan"
    );
    const localCount = localEntries.length + (scannerCardRunning ? 0 : 1);
    const count =
      state.runningOpen && state.runningData && Number.isFinite(state.runningData.count)
        ? state.runningData.count
        : localCount;
    els.runningCount.textContent = String(count);
    els.runningCountMobile.textContent = String(count);
    els.runningButton.classList.toggle("has-running", count > 0);
    els.runningButton.setAttribute("aria-label", "运行中的项目，共 " + count + " 个");
  }

  function showRunningError(message) {
    state.runningError = message || "";
    if (!els.runningError) return;
    els.runningError.hidden = !state.runningError;
    els.runningError.textContent = state.runningError;
  }

  function clearRunningError() {
    showRunningError("");
  }

  function runningRowHTML(entry) {
    const isScannerService = Boolean(entry.isScannerProject && !entry.projectId);
    const external = !isScannerService && isExternalEntry(entry);
    const parent = entry.parentId ? getProject(entry.parentId) : null;
    const metaParts = [];
    if (isScannerService) {
      metaParts.push("本地服务（扫描器自身）");
    } else if (entry.workspaceName) {
      metaParts.push(entry.workspaceName);
    }
    if (entry.parentId) {
      const parentName = parent ? parent.name : entry.parentId;
      metaParts.push(parentName + " / " + (entry.relPath || entry.name));
    }
    metaParts.push(external ? "已运行 —" : "已运行 " + formatUptime(entry.uptimeSec));
    const busy = state.runningBusy.has(entry.projectId);
    const starting = entry.status === "starting";
    const projectName = entry.name || entry.projectId || "项目";
    return (
      '<li class="run-row' +
      (external ? " is-external" : "") +
      '"><div class="run-row-main">' +
      '<p class="run-row-head"><span class="status-dot ' +
      (starting ? "is-starting" : "is-live") +
      '" aria-hidden="true"></span>' +
      '<span class="run-row-name">' +
      esc(projectName) +
      "</span>" +
      '<span class="run-row-state">' +
      esc(starting ? "启动中" : "运行中") +
      "</span>" +
      (entry.isScannerProject ? '<span class="run-row-tag">扫描器</span>' : "") +
      (external ? '<span class="run-row-tag is-external">外部启动</span>' : "") +
      "</p>" +
      '<p class="run-row-meta">' +
      esc(metaParts.join(" · ")) +
      "</p>" +
      (entry.url
        ? '<p class="run-row-url"><a href="' +
          esc(entry.url) +
          '" target="_blank" rel="noopener noreferrer">' +
          esc(entry.url) +
          "</a></p>"
        : '<p class="run-row-url is-muted">没有捕获到访问地址</p>') +
      '</div><div class="run-row-actions">' +
      (isScannerService
        ? '<span class="run-row-note" title="扫描器由外部 start.sh 启动，不能单独重启或停止；需要关闭时用底部「全部停止」并勾选「包含当前扫描器」">外部启动</span>'
        : external
          ? entry.url
            ? '<button class="btn btn-quiet run-action" type="button" data-run-action="open" data-run-url="' +
              esc(entry.url) +
              '" data-run-name="' +
              esc(projectName) +
              '" aria-label="打开 ' +
              esc(projectName) +
              ' 的访问地址">打开</button>'
            : '<span class="run-row-note">外部启动</span>'
          : '<button class="btn btn-quiet run-action" type="button" data-run-action="restart" data-run-project="' +
            esc(entry.projectId) +
            '"' +
            (busy ? " disabled" : "") +
            ">重启</button>" +
            '<button class="btn btn-quiet run-action" type="button" data-run-action="stop" data-run-project="' +
            esc(entry.projectId) +
            '"' +
            (busy ? " disabled" : "") +
            ">停止</button>") +
      "</div></li>"
    );
  }

  function renderRunningFooter() {
    if (!els.runningStopAll) return;
    const includeScanner = state.runningIncludeScanner;
    const confirming = state.stopAllConfirm;
    els.runningStopAll.textContent = confirming
      ? includeScanner
        ? "确认停止（含扫描器）"
        : "确认全部停止"
      : "全部停止";
    els.runningStopAll.classList.toggle("is-confirming", confirming);
    els.runningScannerHint.textContent = includeScanner
      ? "扫描器服务也会停止，页面将断开连接。"
      : "勾选后「全部停止」会同时关闭扫描器服务，页面将断开连接。";
    const list = state.runningData && Array.isArray(state.runningData.projects)
      ? state.runningData.projects
      : [];
    // 扫描器自身不算「项目」；只有扫描器且未勾选包含扫描器时，全部停止没有可执行对象
    const hasProjectEntries = list.some(function (entry) {
      return !(entry.isScannerProject && !entry.projectId) && !isExternalEntry(entry);
    });
    els.runningStopAll.disabled =
      (!hasProjectEntries && !includeScanner) || state.runningBusy.size > 0;
  }

  function renderRunningModal() {
    if (!els.runningList) return;
    const data = state.runningData;
    const list = data && Array.isArray(data.projects) ? data.projects : [];
    const count = data && Number.isFinite(data.count) ? data.count : list.length;
    els.runningModalCount.textContent = String(count);
    if (!state.runningLoaded) {
      els.runningList.innerHTML = '<li class="fs-loading-item">正在读取运行中的项目…</li>';
      els.runningEmpty.hidden = true;
    } else if (!list.length) {
      els.runningList.innerHTML = "";
      els.runningEmpty.hidden = false;
    } else {
      els.runningEmpty.hidden = true;
      els.runningList.innerHTML = list.map(runningRowHTML).join("");
    }
    renderRunningFooter();
  }

  async function refreshRunningData() {
    if (MOCK) {
      state.runningData = mockRunningData();
      state.runningLoaded = true;
      clearRunningError();
      renderRunningModal();
      renderRunningCount();
      return;
    }
    try {
      const response = await fetch("/api/running", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("请求返回 " + response.status);
      const data = await response.json();
      if (data && typeof data === "object") {
        state.runningData = {
          count: Number.isFinite(data.count)
            ? data.count
            : Array.isArray(data.projects)
              ? data.projects.length
              : 0,
          scanner: data.scanner || null,
          projects: Array.isArray(data.projects) ? data.projects : [],
        };
        state.runningLoaded = true;
        clearRunningError();
      }
    } catch (error) {
      state.runningLoaded = true;
      showRunningError(
        "读取运行中项目失败" + (error && error.message ? "（" + error.message + "）" : "")
      );
    }
    renderRunningModal();
    renderRunningCount();
  }

  function startRunningPolling() {
    stopRunningPolling();
    state.runningTimer = window.setInterval(() => {
      if (!state.runningOpen) return;
      if (document.visibilityState === "hidden") return;
      refreshRunningData();
    }, 2000);
  }

  function stopRunningPolling() {
    if (state.runningTimer) {
      window.clearInterval(state.runningTimer);
      state.runningTimer = null;
    }
  }

  function scheduleRunningRefresh() {
    if (!state.runningOpen) return;
    if (state.runningRefreshTimer) return;
    state.runningRefreshTimer = window.setTimeout(() => {
      state.runningRefreshTimer = null;
      if (state.runningOpen) refreshRunningData();
    }, 250);
  }

  function openRunningModal() {
    if (state.runningOpen) return;
    state.runningOpen = true;
    state.runningLoaded = false;
    state.runningData = null;
    state.lastFocusRunning = document.activeElement;
    state.stopAllConfirm = false;
    state.runningIncludeScanner = false;
    els.runningIncludeScanner.checked = false;
    clearRunningError();
    renderRunningModal();
    els.runningScrim.hidden = false;
    els.runningModal.hidden = false;
    void els.runningModal.offsetWidth;
    els.runningModal.classList.add("is-open");
    els.runningScrim.classList.add("is-open");
    updateScrollLock();
    els.runningClose.focus({ preventScroll: true });
    refreshRunningData();
    startRunningPolling();
  }

  function closeRunningModal() {
    if (!state.runningOpen) return;
    state.runningOpen = false;
    state.stopAllConfirm = false;
    window.clearTimeout(state.stopAllTimer);
    stopRunningPolling();
    els.runningModal.classList.remove("is-open");
    els.runningScrim.classList.remove("is-open");
    window.setTimeout(() => {
      if (!state.runningOpen) {
        els.runningModal.hidden = true;
        els.runningScrim.hidden = true;
      }
    }, 300);
    updateScrollLock();
    if (state.lastFocusRunning && document.contains(state.lastFocusRunning)) {
      state.lastFocusRunning.focus({ preventScroll: true });
    }
    state.lastFocusRunning = null;
    renderRunningCount();
  }

  async function stopRunningProject(projectId) {
    if (!projectId || state.runningBusy.has(projectId)) return;
    state.runningBusy.add(projectId);
    renderRunningModal();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        const project = getProject(projectId);
        if (project && project.run) {
          applyRun(
            Object.assign({}, project.run, {
              projectId: projectId,
              status: "exited",
              exitCode: 0,
              endedAt: new Date().toISOString(),
            })
          );
        }
        toast("演示模式 · 已停止 " + (project ? project.name : projectId));
        await refreshRunningData();
        return;
      }
      const response = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/stop", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        showRunningError(errorMessage(data, response.status));
        refreshRunningData();
        return;
      }
      if (data && data.run) applyRun(data.run);
      const project = getProject(projectId);
      toast("已停止 " + (project ? project.name : projectId));
      await refreshRunningData();
    } catch (error) {
      showRunningError("停止失败，扫描服务可能已退出。");
    } finally {
      state.runningBusy.delete(projectId);
      renderRunningModal();
      renderRunningCount();
    }
  }

  async function restartRunningProject(projectId) {
    if (!projectId || state.runningBusy.has(projectId)) return;
    state.runningBusy.add(projectId);
    renderRunningModal();
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const project = getProject(projectId);
        if (project && project.run) {
          const startedAt = new Date().toISOString();
          applyRun(
            Object.assign({}, project.run, {
              runId: "run-demo-" + Date.now(),
              projectId: projectId,
              status: "running",
              startedAt: startedAt,
              endedAt: null,
              exitCode: null,
              log: ["$ " + (project.run.command || "restart"), "", " 演示重启：进程已重新拉起"],
            })
          );
        }
        toast("演示模式 · 已重启 " + (project ? project.name : projectId));
        await refreshRunningData();
        return;
      }
      const response = await fetch(
        "/api/projects/" + encodeURIComponent(projectId) + "/restart",
        { method: "POST", headers: { accept: "application/json" } }
      );
      const data = await safeJSON(response);
      if (!response.ok) {
        showRunningError(errorMessage(data, response.status));
        refreshRunningData();
        return;
      }
      if (data && data.run) applyRun(data.run);
      const project = getProject(projectId);
      toast("已重启 " + (project ? project.name : projectId));
      await refreshRunningData();
    } catch (error) {
      showRunningError("重启失败，扫描服务可能已退出。");
    } finally {
      state.runningBusy.delete(projectId);
      renderRunningModal();
      renderRunningCount();
    }
  }

  async function handleStopAll() {
    const list =
      state.runningData && Array.isArray(state.runningData.projects)
        ? state.runningData.projects
        : [];
    if (!list.length) return;
    if (!state.stopAllConfirm) {
      state.stopAllConfirm = true;
      renderRunningFooter();
      window.clearTimeout(state.stopAllTimer);
      state.stopAllTimer = window.setTimeout(() => {
        state.stopAllConfirm = false;
        renderRunningFooter();
      }, 5000);
      return;
    }
    state.stopAllConfirm = false;
    window.clearTimeout(state.stopAllTimer);
    renderRunningFooter();
    const includeScanner = state.runningIncludeScanner;
    els.runningStopAll.disabled = true;
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const entries = runningEntriesLocal();
        entries.forEach((item) => {
          applyRun(
            Object.assign({}, item.run, {
              projectId: item.project.id,
              status: "exited",
              exitCode: 0,
              endedAt: new Date().toISOString(),
            })
          );
        });
        toast(
          includeScanner
            ? "演示模式 · 已停止全部项目，扫描器不会真的停止"
            : "演示模式 · 已停止 " + entries.length + " 个项目"
        );
        await refreshRunningData();
        renderRunningFooter();
        return;
      }
      const response = await fetch("/api/running/stop-all", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ includeScanner: includeScanner }),
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        showRunningError(errorMessage(data, response.status));
        return;
      }
      const stopped = Array.isArray(data && data.stopped) ? data.stopped.length : 0;
      const failed = Array.isArray(data && data.failed) ? data.failed : [];
      toast(
        "已停止 " +
          stopped +
          " 个项目" +
          (data && data.scannerStopped ? " · 扫描器已停止，页面即将断开" : "")
      );
      if (failed.length) {
        showRunningError(
          "部分项目没有停止：" +
            failed
              .map((item) => {
                const project = getProject(item.projectId);
                return (project ? project.name : item.projectId) + "（" + item.message + "）";
              })
              .join("；")
        );
      }
      if (data && data.scannerStopped) {
        stopRunningPolling();
        state.sseState = "offline";
        renderScanStatus();
        showRunningError("扫描器已停止，页面即将断开连接。");
      }
      await loadProjects({ silent: true });
      await refreshRunningData();
    } catch (error) {
      showRunningError("全部停止失败，扫描服务可能已退出。");
    } finally {
      renderRunningFooter();
    }
  }

  function handleIncludeScannerChange(checked) {
    state.runningIncludeScanner = checked === true;
    state.stopAllConfirm = false;
    window.clearTimeout(state.stopAllTimer);
    renderRunningFooter();
  }

  function replaceCard(id) {
    if (!els.cardGrid || els.cardGrid.hidden) return;
    const project = getProject(id);
    if (!project) return;
    const card = els.cardGrid.querySelector('.card[data-id="' + attrEsc(id) + '"]');
    if (!card) return;
    const index = Array.prototype.indexOf.call(els.cardGrid.children, card);
    const hadFocus = card.contains(document.activeElement);
    card.outerHTML = cardHTML(project, index, false);
    if (hadFocus) {
      const next = els.cardGrid.querySelector(
        '.card[data-id="' + attrEsc(id) + '"] .card-open'
      );
      if (next) next.focus({ preventScroll: true });
    }
  }

  /* ---------- 扫描状态 ---------- */

  function computeNextRun(now, startHour, endHour, intervalMinutes) {
    const current = new Date(now);
    const minutes = current.getHours() * 60 + current.getMinutes();
    const start = startHour * 60;
    const end = endHour * 60;
    if (minutes < start) {
      current.setHours(startHour, 0, 0, 0);
      return current;
    }
    if (minutes >= end) {
      current.setDate(current.getDate() + 1);
      current.setHours(startHour, 0, 0, 0);
      return current;
    }
    const nextMinute = Math.floor(minutes / intervalMinutes) * intervalMinutes + intervalMinutes;
    const next = new Date(now);
    next.setHours(Math.floor(nextMinute / 60), nextMinute % 60, 0, 0);
    return next;
  }

  function nextScanTime() {
    const scheduler = (state.meta && state.meta.scheduler) || {};
    const fromMeta = scheduler.nextRunAt ? new Date(scheduler.nextRunAt) : null;
    if (fromMeta && !Number.isNaN(fromMeta.getTime()) && fromMeta.getTime() > Date.now() - MINUTE) {
      return fromMeta;
    }
    if (scheduler.enabled === false) return null;
    return computeNextRun(
      new Date(),
      scheduler.windowStartHour == null ? 9 : scheduler.windowStartHour,
      scheduler.windowEndHour == null ? 20 : scheduler.windowEndHour,
      scheduler.intervalMinutes == null ? 20 : scheduler.intervalMinutes
    );
  }

  function formatCountdown(target) {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return "即将开始";
    const minutes = Math.ceil(diff / MINUTE);
    if (minutes <= 1) return "不到 1 分钟";
    return "还有 " + minutes + " 分钟";
  }

  function renderScanStatus() {
    const scheduler = (state.meta && state.meta.scheduler) || {};
    const scanning = state.scanning || scheduler.running === true;
    let html;
    let title = "";
    let status = "idle";
    if (state.sseState === "offline" || state.sseState === "reconnecting") {
      html = esc("实时连接中断 · 正在重连");
      status = "error";
    } else if (scanning) {
      html = esc("正在扫描工作区…");
      status = "scanning";
    } else if (scheduler.enabled === false) {
      html = esc("自动扫描已关闭");
    } else {
      const next = nextScanTime();
      if (next) {
        html =
          '<span class="scan-label">下次扫描</span> <span class="scan-time">' +
          esc(formatClock(next)) +
          "</span>";
        title = formatCountdown(next);
      } else {
        html = esc("等待下次扫描");
      }
    }
    els.scanText.innerHTML = html;
    els.scanStatus.title = title;
    els.scanStatus.setAttribute("data-state", status);
    els.scanButton.disabled = scanning;
    els.scanButtonLabel.textContent = scanning ? "扫描中" : "手动扫描";
  }

  function tick() {
    updateRelativeTimes();
    updateHeroRelative();
    renderScanStatus();
    if (state.settingsOpen) renderUpdateSetting();
  }

  function updateRelativeTimes() {
    document.querySelectorAll("[data-rel-time]").forEach((el) => {
      const iso = el.getAttribute("data-rel-time");
      if (iso) el.textContent = formatRelative(iso);
    });
  }

  /* ---------- 详情抽屉 ---------- */

  function metaRowHTML(key, value, mono, block) {
    return (
      '<div class="meta-row' +
      (block ? " is-block" : "") +
      '"><dt class="meta-key">' +
      esc(key) +
      '</dt><dd class="meta-value' +
      (mono ? " mono" : "") +
      '">' +
      esc(value) +
      "</dd></div>"
    );
  }

  function metaRowsHTML(project) {
    const source = project.summarySource || (project.readmePath ? "readme" : "fallback");
    const sourceText =
      source === "llm"
        ? "AI 摘要" + (project.llm && project.llm.model ? " · " + project.llm.model : "")
        : source === "fallback"
          ? "兜底文案"
          : "README 提取";
    const rows = [
      metaRowHTML("文件数", formatCount(project.fileCount), true),
      metaRowHTML("体积", formatBytes(project.sizeBytes), true),
      metaRowHTML(
        "磁盘占用",
        project.diskUsageError
          ? "计算失败"
          : Number.isFinite(project.diskUsageBytes)
            ? formatBytes(project.diskUsageBytes)
            : "尚未计算",
        true
      ),
      metaRowHTML("创建时间", project.createdAt ? formatAbsolute(project.createdAt) : "未知", true),
      metaRowHTML("更新来源", sourceLabel(project.updatedSource), false),
      metaRowHTML("摘要来源", sourceText, false),
      metaRowHTML("README", project.readmePath || "没有 README", true),
      metaRowHTML("目录名", project.dir || "未知", true),
    ];
    if (project.workspaceName) {
      rows.push(metaRowHTML("工作区", project.workspaceName, false));
    }
    if (project.workspacePath) {
      rows.push(metaRowHTML("工作区路径", project.workspacePath, true));
    }
    if (project.hidden === true) {
      rows.push(metaRowHTML("状态", "已隐藏", false));
    }
    if (project.parentId && project.relPath) {
      rows.push(metaRowHTML("相对路径", project.relPath, true));
    }
    if (project.docAlias && project.docAlias.from) {
      rows.push(
        metaRowHTML(
          "文档来源",
          project.docAlias.from + (project.docAlias.copied ? "（已复制为 README.md）" : ""),
          true
        )
      );
    }
    return rows.join("");
  }

  function gitRowsHTML(git) {
    if (!git || !git.isRepo) {
      return '<div class="meta-row"><dt class="meta-key">仓库</dt><dd class="meta-value">不是 Git 仓库</dd></div>';
    }
    const rows = [metaRowHTML("分支", git.branch || "未知", true)];
    if (git.lastCommitSubject) {
      rows.push(metaRowHTML("最后提交", git.lastCommitSubject, false, true));
    }
    if (git.lastCommitAt) {
      rows.push(metaRowHTML("提交时间", formatAbsolute(git.lastCommitAt), true));
    }
    return rows.join("");
  }

  const drawerPanels = { 1: null, 2: null };

  function drawerTemplate(level) {
    return (
      '<header class="drawer-head">' +
      '<div class="drawer-head-top">' +
      '<div class="drawer-head-left">' +
      '<button class="icon-btn drawer-back" type="button" data-role="back" aria-label="返回上级项目" hidden>' +
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M8.5 2.5 4 7l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "</button>" +
      '<p class="drawer-kicker"><span class="status-dot" aria-hidden="true"></span><span data-role="kind">项目</span></p>' +
      "</div>" +
      '<button class="icon-btn" type="button" data-role="close" aria-label="关闭详情">' +
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m2 2 10 10M12 2 2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      "</button>" +
      "</div>" +
      '<h2 class="drawer-title" id="drawer-' +
      level +
      '-title" data-role="title" tabindex="0" aria-label="双击修改项目别称">项目详情</h2>' +
      '<span class="visually-hidden" id="drawer-' +
      level +
      '-name" data-role="dialog-name" aria-hidden="true"></span>' +
      '<div class="drawer-title-editor" data-role="title-editor" hidden>' +
      '<input class="drawer-title-input" id="drawer-' +
      level +
      '-title-input" data-role="title-input" type="text" maxlength="48" autocomplete="off" spellcheck="false" aria-label="项目别称，回车保存，Esc 取消" />' +
      '<span class="drawer-title-saving" data-role="title-saving" role="status" hidden>保存中…</span>' +
      '<p class="drawer-title-error" id="drawer-' +
      level +
      '-title-error" data-role="title-error" role="alert" hidden></p>' +
      "</div>" +
      '<p class="drawer-original-name" data-role="original-name" hidden></p>' +
      '<p class="drawer-time"><span class="rel" data-role="rel"></span><span class="sep" data-role="sep" aria-hidden="true">·</span><span class="mono" data-role="abs"></span></p>' +
      '<div class="drawer-actions" data-role="actions"></div>' +
      "</header>" +
      '<div class="drawer-body">' +
      '<section class="drawer-section"><h3 class="drawer-label">用途概要</h3><p class="drawer-summary" data-role="summary"></p></section>' +
      '<section class="drawer-section" data-role="children-section" hidden>' +
      '<div class="drawer-label-row"><h3 class="drawer-label">子项目</h3><span class="children-count" data-role="children-count"></span></div>' +
      '<div class="child-list" data-role="children"></div>' +
      "</section>" +
      '<section class="drawer-section"><h3 class="drawer-label">路径</h3><div class="path-row"><code class="path-value" data-role="path"></code><button class="btn btn-quiet btn-copy" type="button" data-role="copy">复制</button></div></section>' +
      '<section class="drawer-section"><h3 class="drawer-label">项目信息</h3><dl class="meta-grid" data-role="meta"></dl><p class="meta-note" data-role="meta-note"></p></section>' +
      '<section class="drawer-section"><h3 class="drawer-label">Git</h3><dl class="meta-grid" data-role="git"></dl></section>' +
      '<section class="drawer-section" data-role="monitor-section" hidden>' +
      '<div class="drawer-label-row"><h3 class="drawer-label">运行监控</h3><span class="monitor-status" data-role="monitor-status"></span></div>' +
      '<dl class="meta-grid" data-role="monitor-grid"></dl>' +
      '<p class="monitor-note" data-role="monitor-note"></p>' +
      "</section>" +
      '<section class="drawer-section"><div class="drawer-label-row"><h3 class="drawer-label">运行日志</h3><span class="log-status" data-role="log-status">未运行</span></div><pre class="log-panel is-empty" data-role="log" tabindex="0">还没有日志。运行项目后，输出会显示在这里。</pre></section>' +
      "</div>"
    );
  }

  function cacheDrawerPanel(level) {
    const root = document.getElementById("drawer-" + level);
    if (!root) return null;
    root.innerHTML = drawerTemplate(level);
    const q = (role) => root.querySelector('[data-role="' + role + '"]');
    return {
      level: level,
      root: root,
      close: q("close"),
      back: q("back"),
      kind: q("kind"),
      title: q("title"),
      dialogName: q("dialog-name"),
      titleEditor: q("title-editor"),
      titleInput: q("title-input"),
      titleSaving: q("title-saving"),
      titleError: q("title-error"),
      originalName: q("original-name"),
      rel: q("rel"),
      sep: q("sep"),
      abs: q("abs"),
      actions: q("actions"),
      summary: q("summary"),
      childrenSection: q("children-section"),
      childrenCount: q("children-count"),
      children: q("children"),
      path: q("path"),
      copy: q("copy"),
      meta: q("meta"),
      metaNote: q("meta-note"),
      git: q("git"),
      monitorSection: q("monitor-section"),
      monitorStatus: q("monitor-status"),
      monitorGrid: q("monitor-grid"),
      monitorNote: q("monitor-note"),
      log: q("log"),
      logStatus: q("log-status"),
      projectId: null,
      editState: "idle",
    };
  }

  function renderDrawerLogStatus(panel, project) {
    const run = project ? project.run : null;
    const external = isExternalRun(run);
    let text = "未运行";
    let live = false;
    if (run) {
      if (run.status === "starting") {
        text = "正在启动";
        live = true;
      } else if (run.status === "running") {
        text = external ? "运行中 · 外部启动" : "运行中";
        live = true;
      } else if (run.status === "exited") {
        text = "已退出 · 代码 " + (run.exitCode == null ? 0 : run.exitCode);
      } else if (run.status === "failed") {
        text = "启动失败 · 代码 " + (run.exitCode == null ? "未知" : run.exitCode);
      }
    }
    let html = (live ? '<span class="status-dot" aria-hidden="true"></span>' : "") + esc(text);
    if (external && isRunning(run) && run.url) {
      html +=
        '<a class="log-status-url" href="' +
        esc(run.url) +
        '" target="_blank" rel="noopener noreferrer" aria-label="打开 ' +
        esc(project.name) +
        ' 的访问地址">' +
        esc(run.url) +
        "</a>";
    }
    panel.logStatus.innerHTML = html;
  }

  function updateDrawerLog(panel, lines) {
    const list = Array.isArray(lines) ? lines.slice(-200) : [];
    const log = panel.log;
    if (!list.length) {
      log.classList.add("is-empty");
      log.textContent = "还没有日志。运行项目后，输出会显示在这里。";
      return;
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    log.classList.remove("is-empty");
    log.innerHTML = list
      .map(
        (line, index) =>
          '<span class="log-line' +
          (index === list.length - 1 ? " is-last" : "") +
          '">' +
          esc(String(line)) +
          "</span>"
      )
      .join("");
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function renderDrawerActions(panel, project) {
    const info = runInfoOf(project);
    const run = project.run;
    const running = isRunning(run);
    const external = running && isExternalRun(run);
    const runnableChildren = (project.children || []).filter((child) => runInfoOf(child).runnable).length;
    let html = "";
    if (running && project.isScanner) {
      html +=
        '<span class="run-tooltip" title="扫描器服务由外部 start.sh 启动，不能单独停止；如需停止，请在顶部「运行中」弹层勾选「包含当前扫描器」后全部停止"><span class="btn btn-run is-scanner" role="status"><span class="status-dot" aria-hidden="true"></span>扫描器运行中</span></span>';
    } else if (external) {
      html +=
        '<button class="btn btn-run is-external" type="button" data-action="open" data-id="' +
        esc(project.id) +
        '" aria-label="打开 ' +
        esc(project.name) +
        ' 的访问地址"><span class="status-dot" aria-hidden="true"></span>打开' +
        ARROW_ICON +
        "</button>";
    } else if (running) {
      html +=
        '<button class="btn btn-run is-stop" type="button" data-action="stop" data-id="' +
        esc(project.id) +
        '"><span class="status-dot" aria-hidden="true"></span>运行中 · 停止</button>';
    } else if (info.runnable) {
      html +=
        '<button class="btn btn-run" type="button" data-action="run" data-id="' +
        esc(project.id) +
        '">运行 ' +
        ARROW_ICON +
        "</button>";
    } else {
      html +=
        '<span class="run-tooltip" title="' +
        esc(info.reason || "没有找到可识别的运行入口") +
        '"><button class="btn btn-run" type="button" disabled aria-label="无法运行：' +
        esc(info.reason || "没有找到可识别的运行入口") +
        '">无法运行</button></span>';
    }
    if (!external && run && run.url && isRunning(run)) {
      html +=
        '<a class="btn btn-secondary" href="' +
        esc(run.url) +
        '" target="_blank" rel="noopener noreferrer">打开访问地址</a>';
    }
    const hint = info.runHint || info.command;
    if (project.isScanner) {
      html += '<p class="drawer-run-hint">入口 · 由外部 start.sh 启动（扫描器自身）</p>';
    } else if (external) {
      html +=
        '<p class="drawer-run-hint is-external">外部启动 · 该实例由外部终端启动，本服务只能打开访问地址，不能停止或重启。</p>';
    } else if (hint) {
      html += '<p class="drawer-run-hint">入口 · ' + esc(hint) + "</p>";
    }
    if (!info.runnable && !external) {
      const reasonText =
        runnableChildren > 0
          ? "项目本身没有运行入口，请在下方子项目里选择要运行的项目。"
          : info.reason || "没有找到可识别的运行入口";
      html += '<p class="drawer-run-reason">' + esc(reasonText) + "</p>";
    }
    panel.actions.innerHTML = html;
  }

  function renderChildren(panel, project) {
    const children = project.children || [];
    if (!children.length) {
      panel.childrenSection.hidden = true;
      panel.children.innerHTML = "";
      return;
    }
    const runnableCount = children.filter((child) => runInfoOf(child).runnable).length;
    panel.childrenSection.hidden = false;
    panel.childrenCount.textContent =
      "共 " + children.length + " 个" + (runnableCount > 0 ? " · " + runnableCount + " 个可运行" : "");
    panel.children.innerHTML = children
      .map((child, index) => cardHTML(child, index, false, { compact: true }))
      .join("");
  }

  function renderDrawerTitle(panel, project) {
    panel.title.textContent = project.name;
    if (panel.dialogName) panel.dialogName.textContent = project.name;
    const originalName = project.alias && project.originalName ? project.originalName : "";
    panel.originalName.textContent = originalName ? "原名：" + originalName : "";
    panel.originalName.hidden = !originalName;
    if (originalName) panel.originalName.setAttribute("title", originalName);
    else panel.originalName.removeAttribute("title");
  }

  function renderDrawerPanel(panel, project) {
    if (!panel || !project) return;
    panel.projectId = project.id;
    panel.root.style.setProperty("--card-accent", accentColor(project.accent));
    panel.kind.textContent = project.parentId
      ? "子项目 · " + kindLabel(project.kind)
      : kindLabel(project.kind);
    renderDrawerTitle(panel, project);
    const relativeTime = formatRelative(project.updatedAt);
    const absoluteTime = formatAbsolute(project.updatedAt);
    panel.rel.textContent = relativeTime;
    panel.rel.setAttribute("data-rel-time", project.updatedAt || "");
    const duplicated = relativeTime === absoluteTime;
    panel.abs.textContent = duplicated ? "" : absoluteTime;
    panel.abs.hidden = duplicated;
    panel.sep.hidden = duplicated;
    renderDrawerActions(panel, project);
    panel.summary.textContent = project.summary || "这个项目还没有可读的用途概要。";
    panel.path.textContent = project.path || "路径未知";
    panel.meta.innerHTML = metaRowsHTML(project);
    if (panel.metaNote) {
      panel.metaNote.textContent = project.diskUsageError
        ? "磁盘占用计算失败：" + project.diskUsageError
        : "磁盘占用包含 node_modules、.venv、素材等全部内容；体积为扫描到的代码与文档体积。";
    }
    panel.git.innerHTML = gitRowsHTML(project.git);
    renderDrawerMonitor(panel, project);
    renderDrawerLogStatus(panel, project);
    updateDrawerLog(panel, project.run && project.run.log ? project.run.log : []);
    renderChildren(panel, project);
    panel.back.hidden = panel.level !== 2;
  }

  /* ---------- 抽屉标题：修改别称 ---------- */

  const ALIAS_MAX_LENGTH = 48;

  function refreshProjectCard(project) {
    if (project.parentId) {
      replaceChildCard(project.parentId, project.id);
      return;
    }
    if (state.query.trim() || state.sort === "name") renderList();
    else replaceCard(project.id);
  }

  function applyAliasLocally(id, alias) {
    const project = getProject(id);
    if (!project) return null;
    const nextAlias = typeof alias === "string" && alias.trim() ? alias.trim() : null;
    if (nextAlias) {
      if (!project.alias) project.originalName = project.name;
      project.alias = nextAlias;
      project.name = nextAlias;
    } else {
      project.name = project.originalName || project.name;
      project.alias = null;
      project.originalName = null;
    }
    refreshProjectCard(project);
    return project;
  }

  function applyAliasUpdate(id, payload, fallbackAlias) {
    const raw = payload && payload.project && payload.project.id === id ? payload.project : null;
    if (raw) {
      const project = normalizeProject(raw);
      const topIndex = state.projects.findIndex((item) => item.id === id);
      if (topIndex >= 0) {
        state.projects[topIndex] = project;
        refreshProjectCard(project);
        return project;
      }
      if (project.parentId) {
        const parent = getProject(project.parentId);
        const childIndex =
          parent && Array.isArray(parent.children)
            ? parent.children.findIndex((item) => item.id === id)
            : -1;
        if (childIndex >= 0) {
          parent.children[childIndex] = project;
          refreshProjectCard(project);
          return project;
        }
      }
    }
    return applyAliasLocally(id, fallbackAlias);
  }

  function resetTitleEditor(panel) {
    panel.titleError.textContent = "";
    panel.titleError.hidden = true;
    panel.titleSaving.hidden = true;
    panel.titleInput.disabled = false;
    panel.titleInput.removeAttribute("aria-invalid");
    panel.titleEditor.classList.remove("is-saving");
  }

  function setTitleEditing(panel, editing) {
    panel.title.hidden = editing;
    panel.titleEditor.hidden = !editing;
    panel.root.classList.toggle("is-title-editing", editing);
  }

  function beginTitleEdit(panel) {
    if (!panel || !panel.projectId || panel.editState === "saving") return;
    const project = getProject(panel.projectId);
    if (!project) return;
    if (panel.editState === "editing") {
      panel.titleInput.focus({ preventScroll: true });
      panel.titleInput.select();
      return;
    }
    panel.editState = "editing";
    resetTitleEditor(panel);
    panel.titleInput.value = project.name || "";
    setTitleEditing(panel, true);
    panel.titleInput.focus({ preventScroll: true });
    panel.titleInput.select();
  }

  function endTitleEdit(panel) {
    panel.editState = "idle";
    resetTitleEditor(panel);
    setTitleEditing(panel, false);
  }

  function cancelTitleEdit(panel) {
    if (!panel || panel.editState !== "editing") return;
    const project = getProject(panel.projectId);
    if (project) renderDrawerTitle(panel, project);
    endTitleEdit(panel);
    panel.title.focus({ preventScroll: true });
  }

  function showTitleError(panel, message) {
    panel.titleError.textContent = message;
    panel.titleError.hidden = false;
    panel.titleInput.setAttribute("aria-invalid", "true");
    panel.titleInput.focus({ preventScroll: true });
    panel.titleInput.select();
  }

  function setTitleSaving(panel, saving) {
    panel.titleInput.disabled = saving;
    panel.titleSaving.hidden = !saving;
    panel.titleEditor.classList.toggle("is-saving", saving);
    if (saving) panel.titleEditor.setAttribute("aria-busy", "true");
    else panel.titleEditor.removeAttribute("aria-busy");
  }

  function focusTitleIfIdle(panel) {
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active === panel.titleInput ||
      active === panel.title
    ) {
      panel.title.focus({ preventScroll: true });
    }
  }

  function finishTitleSave(panel, message) {
    const project = getProject(panel.projectId);
    setTitleSaving(panel, false);
    endTitleEdit(panel);
    if (project) renderDrawerPanel(panel, project);
    focusTitleIfIdle(panel);
    if (message) toast(message);
  }

  function failTitleSave(panel, message) {
    const project = getProject(panel.projectId);
    if (project) renderDrawerTitle(panel, project);
    endTitleEdit(panel);
    focusTitleIfIdle(panel);
    if (message) toast(message, { error: true });
  }

  async function commitTitleEdit(panel) {
    if (!panel || panel.editState !== "editing") return;
    const projectId = panel.projectId;
    const project = getProject(projectId);
    if (!project) {
      endTitleEdit(panel);
      return;
    }
    const trimmed = String(panel.titleInput.value || "").trim();
    const previousAlias = project.alias || null;
    let nextAlias = trimmed || null;
    // 输入原名等价于清除别称，恢复扫描名称。
    if (nextAlias && project.originalName && nextAlias === project.originalName) nextAlias = null;
    if (nextAlias === previousAlias) {
      cancelTitleEdit(panel);
      return;
    }
    if (!previousAlias && nextAlias && nextAlias === project.name) {
      cancelTitleEdit(panel);
      return;
    }
    if (nextAlias && nextAlias.length > ALIAS_MAX_LENGTH) {
      showTitleError(panel, "别称最多 " + ALIAS_MAX_LENGTH + " 个字符");
      return;
    }
    panel.editState = "saving";
    panel.titleError.hidden = true;
    panel.titleError.textContent = "";
    setTitleSaving(panel, true);
    try {
      if (MOCK) {
        await new Promise((resolve) => window.setTimeout(resolve, 420));
        applyAliasUpdate(projectId, null, nextAlias);
        finishTitleSave(
          panel,
          nextAlias ? "演示模式 · 已保存别称「" + nextAlias + "」" : "演示模式 · 已恢复原名"
        );
        return;
      }
      const response = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/alias", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ alias: nextAlias }),
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        failTitleSave(panel, errorMessage(data, response.status));
        return;
      }
      applyAliasUpdate(projectId, data, nextAlias);
      finishTitleSave(panel, nextAlias ? "已保存别称「" + nextAlias + "」" : "已恢复原名");
    } catch (error) {
      failTitleSave(panel, "保存别称失败，请稍后重试");
    }
  }

  function activeDrawerPanel() {
    if (drawerPanels[2] && drawerPanels[2].projectId) return drawerPanels[2];
    if (drawerPanels[1] && drawerPanels[1].projectId) return drawerPanels[1];
    return null;
  }

  function panelForProject(projectId) {
    const list = [drawerPanels[1], drawerPanels[2]];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].projectId === projectId) return list[i];
    }
    return null;
  }

  function showDrawerPanel(panel) {
    panel.root.hidden = false;
    els.drawerScrim.hidden = false;
    // 强制一次样式计算，让过渡从关闭状态开始
    void panel.root.offsetWidth;
    panel.root.classList.add("is-open");
    els.drawerScrim.classList.add("is-open");
    updateScrollLock();
  }

  function openTopDrawer(id) {
    const found = getProject(id);
    if (!found) return;
    const top = found.parentId ? getProject(found.parentId) : found;
    if (!top) return;
    state.lastFocus1 = document.activeElement;
    if (drawerPanels[2] && drawerPanels[2].projectId) closeSecondDrawer({ restoreFocus: false });
    renderDrawerPanel(drawerPanels[1], top);
    showDrawerPanel(drawerPanels[1]);
    drawerPanels[1].close.focus({ preventScroll: true });
    syncDrawerPolling();
    refreshDrawerLogs(top);
    if (found.parentId && found.id !== top.id) openSecondDrawer(found.id);
  }

  function openSecondDrawer(id) {
    const project = getProject(id);
    if (!project || !project.parentId) return;
    const parent = getProject(project.parentId);
    if (!parent) return;
    if (!drawerPanels[1].projectId || drawerPanels[1].projectId !== parent.id) {
      openTopDrawer(parent.id);
    }
    if (drawerPanels[2].projectId === project.id) return;
    state.lastFocus2 = document.activeElement;
    renderDrawerPanel(drawerPanels[2], project);
    showDrawerPanel(drawerPanels[2]);
    drawerPanels[1].root.classList.add("drawer--behind");
    drawerPanels[1].root.inert = true;
    drawerPanels[1].root.setAttribute("aria-hidden", "true");
    drawerPanels[2].close.focus({ preventScroll: true });
    syncDrawerPolling();
    refreshDrawerLogs(project);
  }

  function closeSecondDrawer(options) {
    const opts = options || {};
    const panel = drawerPanels[2];
    if (!panel || !panel.projectId) return;
    const closedId = panel.projectId;
    panel.projectId = null;
    panel.root.classList.remove("is-open");
    window.setTimeout(() => {
      if (!panel.projectId) panel.root.hidden = true;
    }, 520);
    drawerPanels[1].root.classList.remove("drawer--behind");
    drawerPanels[1].root.inert = false;
    drawerPanels[1].root.removeAttribute("aria-hidden");
    syncDrawerPolling();
    if (opts.restoreFocus !== false) {
      let target = state.lastFocus2;
      if (!target || !document.contains(target) || target.closest("#drawer-2")) {
        target = drawerPanels[1].children.querySelector(
          '.card-open[data-open="' + attrEsc(closedId) + '"]'
        );
      }
      if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    }
    state.lastFocus2 = null;
  }

  function closeFirstDrawer() {
    const panel = drawerPanels[1];
    if (!panel || !panel.projectId) return;
    const closedId = panel.projectId;
    if (drawerPanels[2].projectId) closeSecondDrawer({ restoreFocus: false });
    panel.projectId = null;
    panel.root.classList.remove("is-open");
    stopRunPolling();
    updateScrollLock();
    els.drawerScrim.classList.remove("is-open");
    window.setTimeout(() => {
      if (!panel.projectId) panel.root.hidden = true;
      if (!drawerPanels[1].projectId && !drawerPanels[2].projectId) els.drawerScrim.hidden = true;
    }, 520);
    let target = state.lastFocus1;
    if (!target || !document.contains(target)) {
      target = els.cardGrid.querySelector('.card-open[data-open="' + attrEsc(closedId) + '"]');
    }
    if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    state.lastFocus1 = null;
  }

  function closeTopDrawer() {
    if (drawerPanels[2] && drawerPanels[2].projectId) {
      closeSecondDrawer();
      return;
    }
    closeFirstDrawer();
  }

  function syncOpenDrawer() {
    [1, 2].forEach((level) => {
      const panel = drawerPanels[level];
      if (!panel || !panel.projectId) return;
      const project = getProject(panel.projectId);
      if (!project) {
        if (level === 2) closeSecondDrawer({ restoreFocus: false });
        else closeFirstDrawer();
        return;
      }
      renderDrawerPanel(panel, project);
    });
  }

  function trapFocusIn(panel) {
    return function (event) {
      if (event.key !== "Tab") return;
      if (activeDrawerPanel() !== panel) return;
      const focusables = panel.root.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
  }

  function copyProjectPath(panel) {
    const project = panel && panel.projectId ? getProject(panel.projectId) : null;
    if (!project) return;
    const text = project.path || "";
    const done = (ok) => {
      toast(ok ? "已复制路径" : "复制失败，请手动选择路径文本", { error: !ok });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          let ok = false;
          try {
            ok = document.execCommand("copy");
          } catch (error) {
            ok = false;
          }
          area.remove();
          done(ok);
        }
      );
      return;
    }
    done(false);
  }

  function refreshDrawerLogs(project) {
    if (!project || !project.run || !project.run.runId) return;
    refreshRunLogs(project.run.runId);
  }

  function syncDrawerPolling() {
    if (MOCK) return;
    const active = [drawerPanels[1], drawerPanels[2]].some((panel) => {
      if (!panel || !panel.projectId) return false;
      const project = getProject(panel.projectId);
      return Boolean(project && isRunning(project.run));
    });
    if (active) {
      if (!state.pollTimer) state.pollTimer = window.setInterval(pollDrawerRuns, 1500);
    } else {
      stopRunPolling();
    }
  }

  function pollDrawerRuns() {
    const runIds = [];
    [drawerPanels[1], drawerPanels[2]].forEach((panel) => {
      if (!panel || !panel.projectId) return;
      const project = getProject(panel.projectId);
      if (project && project.run && project.run.runId && runIds.indexOf(project.run.runId) < 0) {
        runIds.push(project.run.runId);
      }
    });
    if (!runIds.length) {
      stopRunPolling();
      return;
    }
    runIds.forEach((runId) => refreshRunLogs(runId));
  }

  /* ---------- 运行 / 停止 ---------- */

  function setButtonBusy(el, busy, label) {
    if (!el) return;
    if (busy) {
      if (!el.dataset.idleHtml) el.dataset.idleHtml = el.innerHTML;
      el.disabled = true;
      el.innerHTML = esc(label || "启动中…");
    } else if (el.dataset.idleHtml) {
      el.innerHTML = el.dataset.idleHtml;
      delete el.dataset.idleHtml;
      el.disabled = false;
    }
  }

  async function safeJSON(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  function errorMessage(data, status) {
    if (data && data.error && data.error.message) return data.error.message;
    if (data && data.message) return data.message;
    return "请求失败（HTTP " + status + "）";
  }

  function closePlaceholder(win) {
    try {
      if (win && !win.closed) win.close();
    } catch (error) {
      /* 忽略 */
    }
  }

  function applyRun(run) {
    if (!run || !run.projectId) return;
    const project = getProject(run.projectId);
    if (!project) return;
    const previousStatus = project.run ? project.run.status : null;
    project.run = run;
    if (project.parentId) replaceChildCard(project.parentId, project.id);
    else replaceCard(project.id);
    [1, 2].forEach((level) => {
      const panel = drawerPanels[level];
      if (!panel || panel.projectId !== project.id) return;
      renderDrawerActions(panel, project);
      renderDrawerLogStatus(panel, project);
      if (Array.isArray(run.log)) updateDrawerLog(panel, run.log);
    });
    syncDrawerPolling();
    syncMonitorPolling();
    renderRunningCount();
    if (state.runningOpen) scheduleRunningRefresh();
    if (state.monitorEnabled) updateMonitorDom();
    if (previousStatus !== run.status && run.status === "failed") {
      toast("运行失败：退出码 " + (run.exitCode == null ? "未知" : run.exitCode), { error: true });
    }
  }

  function replaceChildCard(parentId, childId) {
    const parent = getProject(parentId);
    const panel = drawerPanels[1];
    if (!parent || !panel || panel.projectId !== parentId) return;
    const children = parent.children || [];
    const index = children.findIndex((child) => child.id === childId);
    if (index < 0) return;
    const card = panel.children.querySelector('.card[data-id="' + attrEsc(childId) + '"]');
    if (!card) return;
    const hadFocus = card.contains(document.activeElement);
    card.outerHTML = cardHTML(children[index], index, false, { compact: true });
    if (hadFocus) {
      const next = panel.children.querySelector('.card-open[data-open="' + attrEsc(childId) + '"]');
      if (next) next.focus({ preventScroll: true });
    }
  }

  function stopRunPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshRunLogs(runId) {
    if (!runId || MOCK) return;
    try {
      const response = await fetch("/api/runs/" + encodeURIComponent(runId), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.run) return;
      applyRun(data.run);
      const panel = panelForProject(data.run.projectId);
      if (panel) {
        updateDrawerLog(panel, Array.isArray(data.logs) ? data.logs : data.run.log || []);
        renderDrawerLogStatus(panel, getProject(data.run.projectId));
      }
    } catch (error) {
      /* 单次轮询失败忽略，下一次继续 */
    }
  }

  async function startRun(id, triggerEl) {
    const project = getProject(id);
    if (!project) return;
    const info = runInfoOf(project);
    if (!info.runnable) {
      toast(info.reason || "这个项目没有可识别的运行入口", { error: true });
      return;
    }
    if (isRunning(project.run)) {
      stopRun(id, triggerEl);
      return;
    }
    if (MOCK) {
      simulateRun(project);
      return;
    }

    const placeholder = window.open("about:blank", "_blank");
    if (placeholder) {
      try {
        placeholder.document.title = "正在启动项目…";
        placeholder.document.body.style.background = "#131209";
      } catch (error) {
        /* 跨窗口访问被拒绝时忽略 */
      }
    }
    setButtonBusy(triggerEl, true, "启动中…");
    try {
      const response = await fetch("/api/projects/" + encodeURIComponent(id) + "/run", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        closePlaceholder(placeholder);
        toast(errorMessage(data, response.status), { error: true });
        if (response.status === 409) refreshProject(id);
        return;
      }
      const run = data && data.run ? data.run : null;
      if (!run) {
        closePlaceholder(placeholder);
        toast("启动失败：服务没有返回运行状态", { error: true });
        return;
      }
      applyRun(run);
      if (run.url) {
        if (placeholder) {
          try {
            placeholder.location.replace(run.url);
          } catch (error) {
            window.open(run.url, "_blank", "noopener");
          }
        } else {
          window.open(run.url, "_blank", "noopener");
          toast("浏览器拦截了新窗口，已尝试重新打开访问地址");
        }
      } else {
        closePlaceholder(placeholder);
        toast("已启动，但没有捕获到访问地址");
      }
      if (panelForProject(id)) {
        syncDrawerPolling();
        refreshDrawerLogs(getProject(id));
      }
    } catch (error) {
      closePlaceholder(placeholder);
      toast("启动请求失败，扫描服务可能已经退出", { error: true });
    } finally {
      setButtonBusy(triggerEl, false);
    }
  }

  async function stopRun(id, triggerEl) {
    const project = getProject(id);
    if (!project) return;
    if (MOCK) {
      simulateStop(project);
      return;
    }
    setButtonBusy(triggerEl, true, "停止中…");
    try {
      const response = await fetch("/api/projects/" + encodeURIComponent(id) + "/stop", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (!response.ok) {
        toast(errorMessage(data, response.status), { error: true });
        refreshProject(id);
        return;
      }
      if (data && data.run) applyRun(data.run);
      toast("已停止运行");
      syncDrawerPolling();
    } catch (error) {
      toast("停止请求失败，扫描服务可能已经退出", { error: true });
    } finally {
      setButtonBusy(triggerEl, false);
    }
  }

  /* ---------- 演示模式（?mock=1）的运行模拟 ---------- */

  function simulateRun(project) {
    if (isRunning(project.run)) return;
    const info = runInfoOf(project);
    const command = info.command || info.runHint || "演示启动命令";
    const run = {
      runId: "run-demo-" + Date.now(),
      projectId: project.id,
      status: "starting",
      url: null,
      command: command,
      cwd: project.path,
      pid: 42000 + Math.floor(Math.random() * 800),
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      log: ["$ " + command, ""],
    };
    const entry = { run: run, timer: null, ticks: 0 };
    state.mockRuns.set(project.id, entry);
    applyRun(run);
    toast("演示模式 · 已模拟启动，不会真的运行项目");
    entry.timer = window.setTimeout(() => {
      const current = state.mockRuns.get(project.id);
      if (!current || current.run.status !== "starting") return;
      current.run.status = "running";
      current.run.url =
        info.kind === "static" || project.runKind === "static"
          ? "/preview/" + encodeURIComponent(project.id) + "/"
          : "http://localhost:5173";
      current.run.log.push("  VITE v5.4.2  ready in 412 ms", "", "  Local:   " + current.run.url);
      applyRun(current.run);
      current.timer = window.setInterval(() => {
        const latest = state.mockRuns.get(project.id);
        if (!latest || latest.run.status !== "running") return;
        latest.ticks += 1;
        latest.run.log.push(
          "[" + formatClock(new Date()) + "] GET / " + (200 + (latest.ticks % 3)) + " " + (2 + latest.ticks) + "ms"
        );
        if (latest.run.log.length > 200) latest.run.log.splice(0, latest.run.log.length - 200);
        if (latest.ticks >= 12) {
          window.clearInterval(latest.timer);
          latest.timer = null;
        }
        applyRun(latest.run);
      }, 1500);
    }, 1200);
  }

  function simulateStop(project) {
    const entry = state.mockRuns.get(project.id);
    if (entry) {
      if (entry.timer) {
        window.clearTimeout(entry.timer);
        window.clearInterval(entry.timer);
      }
      entry.run.status = "exited";
      entry.run.endedAt = new Date().toISOString();
      entry.run.exitCode = 0;
      entry.run.log.push("", "进程已退出（SIGTERM）");
      state.mockRuns.delete(project.id);
      applyRun(entry.run);
    } else if (project.run) {
      applyRun(
        Object.assign({}, project.run, {
          status: "exited",
          endedAt: new Date().toISOString(),
          exitCode: 0,
        })
      );
    }
    toast("已停止运行（演示模式）");
  }

  /* ---------- 手动扫描 ---------- */

  async function triggerScan() {
    if (state.scanning) return;
    if (MOCK) {
      simulateScan();
      return;
    }
    els.scanButton.disabled = true;
    els.scanButtonLabel.textContent = "扫描中";
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await safeJSON(response);
      if (response.status === 202) {
        state.scanning = true;
        renderScanStatus();
        toast("扫描已开始，完成后会自动刷新");
        if (state.scanFallback) window.clearTimeout(state.scanFallback);
        state.scanFallback = window.setTimeout(() => {
          state.scanning = false;
          renderScanStatus();
        }, 90000);
      } else {
        toast(errorMessage(data, response.status), { error: true });
      }
    } catch (error) {
      toast("无法触发扫描，扫描服务可能已经退出", { error: true });
    } finally {
      renderScanStatus();
    }
  }

  function simulateScan() {
    if (state.scanning) return;
    state.scanning = true;
    renderScanStatus();
    window.setTimeout(() => {
      state.scanning = false;
      if (state.meta) {
        state.meta.scannedAt = new Date().toISOString();
        state.meta.scanDurationMs = 1420;
      }
      renderHeroMeta();
      renderScanStatus();
      toast("演示模式 · 已重新读取本地夹具，没有真的扫描磁盘");
    }, 1200);
  }

  /* ---------- 筛选与排序 ---------- */

  function clearFilters() {
    state.query = "";
    state.tag = "all";
    state.workspaceFilter = "all";
    state.statusFilter = "available";
    els.searchInput.value = "";
    els.searchClear.hidden = true;
    updateTagPressed();
    renderWorkspaceFilter();
    renderList();
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    let searchTimer = null;
    els.searchInput.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.query = els.searchInput.value;
        els.searchClear.hidden = state.query.length === 0;
        renderList();
      }, 90);
    });
    els.searchInput.addEventListener("search", () => {
      state.query = els.searchInput.value;
      els.searchClear.hidden = state.query.length === 0;
      renderList();
    });
    els.searchClear.addEventListener("click", () => {
      els.searchInput.value = "";
      state.query = "";
      els.searchClear.hidden = true;
      renderList();
      els.searchInput.focus();
    });

    els.sortGroup.addEventListener("click", (event) => {
      const button = event.target.closest("[data-sort]");
      if (!button) return;
      state.sort = button.getAttribute("data-sort");
      els.sortGroup.querySelectorAll("[data-sort]").forEach((item) => {
        item.setAttribute(
          "aria-pressed",
          item.getAttribute("data-sort") === state.sort ? "true" : "false"
        );
      });
      renderList();
    });

    els.tagFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tag]");
      if (!button) return;
      const next = button.getAttribute("data-tag");
      state.tag = state.tag === next ? "all" : next;
      updateTagPressed();
      renderList();
    });

    els.cardGrid.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (action) {
        const id = action.getAttribute("data-id");
        if (action.getAttribute("data-action") === "run") startRun(id, action);
        else if (action.getAttribute("data-action") === "stop") stopRun(id, action);
        else if (action.getAttribute("data-action") === "open") openProjectRun(id);
        else if (action.getAttribute("data-action") === "open-children") openTopDrawer(id);
        return;
      }
      const open = event.target.closest("[data-open]");
      if (open) {
        openTopDrawer(open.getAttribute("data-open"));
        return;
      }
      const card = event.target.closest(".card");
      if (card) openTopDrawer(card.getAttribute("data-id"));
    });

    els.scanButton.addEventListener("click", triggerScan);
    els.errorRetry.addEventListener("click", () => loadProjects());
    els.emptyAction.addEventListener("click", () => {
      const mode = els.emptyAction.dataset.mode;
      if (mode === "clear") clearFilters();
      else if (mode === "settings") openSettingsModal();
      else if (mode === "status-hidden") setStatusFilter("hidden");
      else triggerScan();
    });

    // 设置弹层与可见状态分段控件
    els.settingsButton.addEventListener("click", openSettingsModal);
    els.settingsClose.addEventListener("click", closeSettingsModal);
    els.settingsScrim.addEventListener("click", closeSettingsModal);
    els.settingsModal.addEventListener("keydown", trapFocusWithin(els.settingsModal));
    els.settingsSearch.addEventListener("input", () => {
      state.settingsQuery = els.settingsSearch.value;
      renderSettingsModal();
    });
    els.settingsList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-hidden-id]");
      if (!button || button.disabled) return;
      const project = getProject(button.getAttribute("data-hidden-id"));
      if (!project) return;
      toggleProjectHidden(project.id, project.hidden !== true);
    });
    els.settingsTabs.addEventListener("click", handleSettingsTabClick);
    els.settingsTabs.addEventListener("keydown", handleSettingsTabsKeydown);
    els.monitorToggle.addEventListener("click", toggleMonitor);
    els.updateToggle.addEventListener("click", toggleAutoUpdate);
    els.updateCheck.addEventListener("click", checkForUpdates);
    els.updateRefresh.addEventListener("click", () => window.location.reload());
    if (els.llmEnabledToggle) els.llmEnabledToggle.addEventListener("click", toggleLlmEnabled);
    els.llmChannel.addEventListener("change", handleLlmChannelChange);
    els.llmModel.addEventListener("change", handleLlmModelChange);
    els.llmRetry.addEventListener("click", () => loadLlmChannels());

    // 运行中弹层
    els.runningButton.addEventListener("click", openRunningModal);
    els.runningClose.addEventListener("click", closeRunningModal);
    els.runningScrim.addEventListener("click", closeRunningModal);
    els.runningModal.addEventListener("keydown", trapFocusWithin(els.runningModal));
    els.runningList.addEventListener("click", (event) => {
      const action = event.target.closest("[data-run-action]");
      if (!action) return;
      const projectId = action.getAttribute("data-run-project");
      const runAction = action.getAttribute("data-run-action");
      if (runAction === "open") {
        openRunAddress(action.getAttribute("data-run-url"), action.getAttribute("data-run-name"));
      } else if (runAction === "restart") restartRunningProject(projectId);
      else if (runAction === "stop") stopRunningProject(projectId);
    });
    els.runningStopAll.addEventListener("click", handleStopAll);
    els.runningIncludeScanner.addEventListener("change", () => {
      handleIncludeScannerChange(els.runningIncludeScanner.checked);
    });
    els.statusSeg.addEventListener("click", (event) => {
      const button = event.target.closest("[data-status]");
      if (!button) return;
      setStatusFilter(button.getAttribute("data-status"));
    });

    // 工作区入口与筛选
    els.workspacesButton.addEventListener("click", openWorkspaceModal);
    els.wsFilterButton.addEventListener("click", () => {
      if (state.wsMenuOpen) closeWorkspaceMenu(true);
      else openWorkspaceMenu();
    });
    els.wsFilterMenu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-ws]");
      if (!item) return;
      selectWorkspaceFilter(item.getAttribute("data-ws"));
    });
    els.wsFilterMenu.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.prototype.slice.call(els.wsFilterMenu.querySelectorAll(".filter-item"));
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
      items[next].focus();
    });
    document.addEventListener("click", (event) => {
      if (!state.wsMenuOpen) return;
      if (event.target.closest("#ws-filter")) return;
      closeWorkspaceMenu(false);
    });

    // 工作区管理弹层
    els.wsClose.addEventListener("click", closeWorkspaceModal);
    els.wsScrim.addEventListener("click", closeWorkspaceModal);
    els.wsModal.addEventListener("keydown", trapFocusWithin(els.wsModal));
    els.wsBrowseButton.addEventListener("click", () => openDirPicker());
    els.wsAddForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitWorkspace();
    });
    els.wsPathInput.addEventListener("input", clearWsError);
    els.wsList.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-ws]");
      if (!remove) return;
      removeWorkspace(remove.getAttribute("data-remove-ws"), remove);
    });

    // 目录选择器
    els.fsClose.addEventListener("click", () => closeDirPicker(true));
    els.fsScrim.addEventListener("click", () => closeDirPicker(true));
    els.fsCancel.addEventListener("click", () => closeDirPicker(true));
    els.fsModal.addEventListener("keydown", trapFocusWithin(els.fsModal));
    els.fsUp.addEventListener("click", () => {
      if (state.fsParent) browseDir(state.fsParent);
    });
    els.fsHome.addEventListener("click", () => {
      if (state.fsHome) browseDir(state.fsHome);
    });
    els.fsDefault.addEventListener("click", () => browseDir(defaultWorkspacePath()));
    els.fsChoose.addEventListener("click", chooseDir);
    els.fsList.addEventListener("click", (event) => {
      const item = event.target.closest("[data-fs-path]");
      if (!item) return;
      browseDir(item.getAttribute("data-fs-path"));
    });

    els.drawerScrim.addEventListener("click", closeTopDrawer);
    [1, 2].forEach((level) => {
      const panel = drawerPanels[level];
      if (!panel) return;
      panel.close.addEventListener("click", () => {
        if (level === 2) closeSecondDrawer();
        else closeFirstDrawer();
      });
      panel.back.addEventListener("click", () => closeSecondDrawer());
      panel.copy.addEventListener("click", () => copyProjectPath(panel));
      panel.title.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        beginTitleEdit(panel);
      });
      panel.title.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        beginTitleEdit(panel);
      });
      panel.titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commitTitleEdit(panel);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelTitleEdit(panel);
        }
      });
      panel.titleInput.addEventListener("blur", () => {
        if (panel.editState === "editing") commitTitleEdit(panel);
      });
      panel.root.addEventListener("keydown", trapFocusIn(panel));
      panel.actions.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]");
        if (!action) return;
        const id = action.getAttribute("data-id");
        if (action.getAttribute("data-action") === "run") startRun(id, action);
        else if (action.getAttribute("data-action") === "stop") stopRun(id, action);
        else if (action.getAttribute("data-action") === "open") openProjectRun(id);
      });
      panel.children.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]");
        if (action) {
          const id = action.getAttribute("data-id");
          if (action.getAttribute("data-action") === "run") startRun(id, action);
          else if (action.getAttribute("data-action") === "stop") stopRun(id, action);
          else if (action.getAttribute("data-action") === "open") openProjectRun(id);
          return;
        }
        const open = event.target.closest("[data-open]");
        if (open) {
          openSecondDrawer(open.getAttribute("data-open"));
          return;
        }
        const card = event.target.closest(".card");
        if (card) openSecondDrawer(card.getAttribute("data-id"));
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.fsPickerOpen) {
          event.preventDefault();
          closeDirPicker(true);
          return;
        }
        if (state.wsMenuOpen) {
          event.preventDefault();
          closeWorkspaceMenu(true);
          return;
        }
        if (state.settingsOpen) {
          event.preventDefault();
          closeSettingsModal();
          return;
        }
        if (state.runningOpen) {
          event.preventDefault();
          closeRunningModal();
          return;
        }
        if (state.wsModalOpen) {
          event.preventDefault();
          closeWorkspaceModal();
          return;
        }
        if (activeDrawerPanel()) {
          event.preventDefault();
          closeTopDrawer();
          return;
        }
      }
      if (
        event.key === "/" &&
        !activeDrawerPanel() &&
        !state.wsModalOpen &&
        !state.fsPickerOpen &&
        !state.settingsOpen &&
        !state.runningOpen
      ) {
        const tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
        const typing =
          tag === "input" || tag === "textarea" || (event.target && event.target.isContentEditable);
        if (!typing) {
          event.preventDefault();
          els.searchInput.focus();
        }
      }
    });

    document.addEventListener("visibilitychange", () => {
      syncMonitorPolling();
      if (document.visibilityState === "visible") {
        if (state.runningOpen) refreshRunningData();
        if (!MOCK && state.phase === "ready") loadProjects({ silent: true });
      }
    });

    let settingsResizeTimer = null;
    window.addEventListener("resize", () => {
      if (!state.settingsOpen) return;
      window.clearTimeout(settingsResizeTimer);
      settingsResizeTimer = window.setTimeout(syncSettingsModalHeight, 150);
    });
  }

  /* ---------- 初始化 ---------- */

  function cacheEls() {
    els.scanStatus = document.getElementById("scan-status");
    els.scanText = document.getElementById("scan-text");
    els.scanButton = document.getElementById("scan-button");
    els.scanButtonLabel = document.getElementById("scan-button-label");
    els.heroTitle = document.getElementById("hero-title");
    els.heroMeta = document.getElementById("hero-meta");
    els.heroStats = document.getElementById("hero-stats");
    els.searchInput = document.getElementById("search-input");
    els.searchClear = document.getElementById("search-clear");
    els.sortGroup = document.getElementById("sort-group");
    els.tagFilters = document.getElementById("tag-filters");
    els.resultCount = document.getElementById("result-count");
    els.stateRegion = document.getElementById("state-region");
    els.skeletonGrid = document.getElementById("skeleton-grid");
    els.cardGrid = document.getElementById("card-grid");
    els.emptyState = document.getElementById("empty-state");
    els.emptyTitle = document.getElementById("empty-title");
    els.emptyDesc = document.getElementById("empty-desc");
    els.emptyAction = document.getElementById("empty-action");
    els.errorState = document.getElementById("error-state");
    els.errorTitle = document.getElementById("error-title");
    els.errorDesc = document.getElementById("error-desc");
    els.errorRetry = document.getElementById("error-retry");
    els.drawerScrim = document.getElementById("drawer-scrim");
    drawerPanels[1] = cacheDrawerPanel(1);
    drawerPanels[2] = cacheDrawerPanel(2);
    els.workspacesButton = document.getElementById("workspaces-button");
    els.workspaceCount = document.getElementById("workspace-count");
    els.wsFilter = document.getElementById("ws-filter");
    els.wsFilterButton = document.getElementById("ws-filter-button");
    els.wsFilterLabel = document.getElementById("ws-filter-label");
    els.wsFilterMenu = document.getElementById("ws-filter-menu");
    els.wsScrim = document.getElementById("ws-scrim");
    els.wsModal = document.getElementById("ws-modal");
    els.wsClose = document.getElementById("ws-close");
    els.wsList = document.getElementById("ws-list");
    els.wsListCount = document.getElementById("ws-list-count");
    els.wsLimitHint = document.getElementById("ws-limit-hint");
    els.wsAddForm = document.getElementById("ws-add-form");
    els.wsPathInput = document.getElementById("ws-path-input");
    els.wsBrowseButton = document.getElementById("ws-browse");
    els.wsAddButton = document.getElementById("ws-add");
    els.wsError = document.getElementById("ws-error");
    els.fsScrim = document.getElementById("fs-scrim");
    els.fsModal = document.getElementById("fs-modal");
    els.fsClose = document.getElementById("fs-close");
    els.fsPath = document.getElementById("fs-path");
    els.fsUp = document.getElementById("fs-up");
    els.fsHome = document.getElementById("fs-home");
    els.fsDefault = document.getElementById("fs-default");
    els.fsError = document.getElementById("fs-error");
    els.fsList = document.getElementById("fs-list");
    els.fsEmpty = document.getElementById("fs-empty");
    els.fsChoose = document.getElementById("fs-choose");
    els.fsCancel = document.getElementById("fs-cancel");
    els.settingsButton = document.getElementById("settings-button");
    els.settingsScrim = document.getElementById("settings-scrim");
    els.settingsModal = document.getElementById("settings-modal");
    els.settingsClose = document.getElementById("settings-close");
    els.settingsSearch = document.getElementById("settings-search");
    els.settingsHiddenCount = document.getElementById("settings-hidden-count");
    els.settingsError = document.getElementById("settings-error");
    els.settingsList = document.getElementById("settings-list");
    els.settingsEmpty = document.getElementById("settings-empty");
    els.statusSeg = document.getElementById("status-seg");
    els.monitorToggle = document.getElementById("monitor-toggle");
    els.monitorError = document.getElementById("monitor-error");
    els.llmChannel = document.getElementById("llm-channel");
    els.llmModel = document.getElementById("llm-model");
    els.llmStatus = document.getElementById("llm-status");
    els.llmError = document.getElementById("llm-error");
    els.llmRetry = document.getElementById("llm-retry");
    els.llmEnabledToggle = document.getElementById("llm-enabled-toggle");
    els.llmEnabledError = document.getElementById("llm-enabled-error");
    els.settingsTabs = document.getElementById("settings-tabs");
    els.settingsTabButtons = Array.prototype.slice.call(
      document.querySelectorAll("#settings-tabs [role='tab']")
    );
    els.updateToggle = document.getElementById("update-toggle");
    els.updateStatus = document.getElementById("update-status");
    els.updateCheck = document.getElementById("update-check");
    els.updateError = document.getElementById("update-error");
    els.updateRestart = document.getElementById("update-restart");
    els.updateRefresh = document.getElementById("update-refresh");
    els.runningButton = document.getElementById("running-button");
    els.runningCount = document.getElementById("running-count");
    els.runningCountMobile = document.getElementById("running-count-mobile");
    els.runningScrim = document.getElementById("running-scrim");
    els.runningModal = document.getElementById("running-modal");
    els.runningClose = document.getElementById("running-close");
    els.runningModalCount = document.getElementById("running-modal-count");
    els.runningList = document.getElementById("running-list");
    els.runningEmpty = document.getElementById("running-empty");
    els.runningError = document.getElementById("running-error");
    els.runningStopAll = document.getElementById("running-stop-all");
    els.runningIncludeScanner = document.getElementById("running-include-scanner");
    els.runningScannerHint = document.getElementById("running-scanner-hint");
    els.toasts = document.getElementById("toast-stack");
    els.footerSource = document.getElementById("footer-source");
  }

  // 自检用 hash：#demo-hover / #demo-drawer[:项目 id] / #demo-empty / #demo-metrics
  function applyDebugHash() {
    const hash = window.location.hash;
    if (hash.indexOf("#demo-drawer") === 0 || hash.indexOf("#demo-child") === 0) {
      const id = hash.split(":")[1];
      const project = id ? getProject(id) : state.projects[0];
      if (project) window.setTimeout(() => openTopDrawer(project.id), 60);
    } else if (hash === "#demo-llm") {
      if (state.meta) {
        state.meta.llm = Object.assign({}, state.meta.llm || {}, {
          enabled: true,
          running: true,
          model: "deepseek-flash",
        });
        renderHeroMeta();
      }
    } else if (hash === "#demo-ws-menu") {
      window.setTimeout(() => openWorkspaceMenu(), 400);
    } else if (hash === "#demo-workspaces") {
      window.setTimeout(() => openWorkspaceModal(), 400);
    } else if (hash === "#demo-browse") {
      window.setTimeout(() => {
        openWorkspaceModal();
        window.setTimeout(() => openDirPicker(), 500);
      }, 400);
    } else if (hash === "#demo-browse-error") {
      window.setTimeout(() => {
        openWorkspaceModal();
        window.setTimeout(() => openDirPicker("/不存在的目录"), 500);
      }, 400);
    } else if (hash.indexOf("#demo-ws-filter") === 0) {
      const wsFilterId = hash.split(":")[1] || "ws-7f3a";
      window.setTimeout(() => {
        state.workspaceFilter = wsFilterId;
        renderWorkspaceFilter();
        renderList();
      }, 400);
    } else if (hash.indexOf("#demo-ws-remove") === 0) {
      window.setTimeout(() => {
        openWorkspaceModal();
        window.setTimeout(() => {
          const removeButton = els.wsList.querySelector("[data-remove-ws]");
          if (removeButton) removeButton.click();
        }, 500);
      }, 400);
    } else if (hash === "#demo-running") {
      window.setTimeout(() => openRunningModal(), 400);
    } else if (hash === "#demo-running-empty") {
      window.setTimeout(() => {
        runningEntriesLocal().forEach((item) => {
          applyRun(
            Object.assign({}, item.run, {
              projectId: item.project.id,
              status: "exited",
              exitCode: 0,
              endedAt: new Date().toISOString(),
            })
          );
        });
        openRunningModal();
      }, 400);
    } else if (hash === "#demo-running-confirm") {
      window.setTimeout(() => {
        openRunningModal();
        window.setTimeout(() => {
          if (els.runningStopAll) els.runningStopAll.click();
        }, 700);
      }, 400);
    } else if (hash === "#demo-running-confirm-scanner") {
      window.setTimeout(() => {
        openRunningModal();
        window.setTimeout(() => {
          if (els.runningIncludeScanner) {
            els.runningIncludeScanner.checked = true;
            handleIncludeScannerChange(true);
          }
          if (els.runningStopAll) els.runningStopAll.click();
        }, 700);
      }, 400);
    } else if (hash === "#demo-monitor") {
      window.setTimeout(() => {
        state.monitorEnabled = true;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, {
          monitorEnabled: true,
        });
        renderMonitorSetting();
        renderList();
        syncMonitorPolling();
      }, 400);
      window.setTimeout(() => {
        document.title =
          "MON w=" +
          document.documentElement.scrollWidth +
          " vw=" +
          window.innerWidth +
          " cards=" +
          document.querySelectorAll(".card").length +
          " overflow=" +
          (document.documentElement.scrollWidth > window.innerWidth);
      }, 2500);
    } else if (hash.indexOf("#demo-monitor-drawer") === 0) {
      const monitorProjectId = hash.split(":")[1] || "demo-studio";
      window.setTimeout(() => {
        state.monitorEnabled = true;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, {
          monitorEnabled: true,
        });
        renderMonitorSetting();
        renderList();
        syncMonitorPolling();
        const monitorProject = getProject(monitorProjectId);
        if (monitorProject) openTopDrawer(monitorProject.id);
      }, 400);
    } else if (hash === "#demo-monitor-unsupported") {
      window.setTimeout(() => {
        state.mockUnsupported = true;
        state.monitorEnabled = true;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, {
          monitorEnabled: true,
        });
        renderMonitorSetting();
        renderList();
        syncMonitorPolling();
        const target = getProject("demo-studio");
        if (target) openTopDrawer(target.id);
      }, 400);
    } else if (hash === "#demo-monitor-settings") {
      window.setTimeout(() => openSettingsModal(), 400);
    } else if (hash === "#demo-monitor-settings-on") {
      window.setTimeout(() => {
        state.monitorEnabled = true;
        state.mockSettings = Object.assign({}, state.mockSettings || {}, {
          monitorEnabled: true,
        });
        renderMonitorSetting();
        syncMonitorPolling();
        openSettingsModal();
      }, 400);
    } else if (hash === "#demo-settings") {
      window.setTimeout(() => openSettingsModal(), 400);
    } else if (hash.indexOf("#demo-settings-search") === 0) {
      const settingsQuery = hash.split(":")[1] || "zzz";
      window.setTimeout(() => {
        openSettingsModal();
        window.setTimeout(() => {
          els.settingsSearch.value = settingsQuery;
          state.settingsQuery = settingsQuery;
          renderSettingsModal();
        }, 500);
      }, 400);
    } else if (hash.indexOf("#demo-status") === 0) {
      const statusValue = hash.split(":")[1] || "all";
      window.setTimeout(() => setStatusFilter(statusValue), 400);
    } else if (hash.indexOf("#demo-hide") === 0) {
      const hideId = hash.split(":")[1] || "api-proxy";
      window.setTimeout(() => {
        const target = getProject(hideId);
        if (target) applyHiddenState(target.id, true);
        renderStatusSeg();
        renderList();
      }, 400);
    } else if (hash === "#demo-scan") {
      window.setTimeout(() => triggerScan(), 300);
    } else if (hash.indexOf("#demo-run") === 0) {
      const runId = hash.split(":")[1] || "project-scan";
      window.setTimeout(() => {
        const project = getProject(runId);
        if (project) startRun(project.id, null);
      }, 300);
    } else if (hash.indexOf("#demo-hover") === 0) {
      const hoverId = hash.split(":")[1];
      window.setTimeout(() => {
        const selector = hoverId
          ? '.card[data-id="' + attrEsc(hoverId) + '"]'
          : ".card";
        const target = document.querySelector(selector);
        if (target) target.classList.add("is-demo-hover");
      }, 200);
    } else if (hash === "#demo-focus") {
      window.setTimeout(() => {
        const target = document.querySelector(".card-open");
        if (target) target.focus();
      }, 300);
    } else if (hash === "#demo-empty") {
      state.query = "不存在的项目名";
      els.searchInput.value = state.query;
      els.searchClear.hidden = false;
      renderList();
    } else if (hash === "#demo-metrics") {
      window.setTimeout(() => {
        const cards = document.querySelectorAll(".card").length;
        const overflow = document.documentElement.scrollWidth > window.innerWidth;
        document.title =
          "METRICS w=" +
          document.documentElement.scrollWidth +
          " vw=" +
          window.innerWidth +
          " cards=" +
          cards +
          " overflow=" +
          overflow;
      }, 400);
    }
  }

  function init() {
    cacheEls();
    bindEvents();
    setupHeroReveal();
    renderAll();
    loadProjects();
    loadUpdateStatus({ silent: true });
    window.setInterval(tick, 30000);
    window.setInterval(() => {
      if (!MOCK && state.phase === "ready") loadProjects({ silent: true });
    }, 300000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
