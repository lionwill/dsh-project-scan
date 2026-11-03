import fs from 'node:fs';
import path from 'node:path';

function isoNow() {
  return new Date().toISOString();
}

function tagsEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/**
 * 持久化 + 扫描 diff + 子项目索引。
 * 数据文件：<dataDir>/projects.json
 */
export function createStore(options) {
  const dataDir = options.dataDir;
  const root = options.root || null;
  const file = path.join(dataDir, 'projects.json');

  let projects = [];
  let meta = {
    root: root,
    scannedAt: null,
    scanDurationMs: 0,
    count: 0,
    subprojectCount: 0,
    version: '1.0.0',
    scheduler: null,
    workspaces: [],
    scanErrors: []
  };

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) {
        projects = parsed.projects.filter(function (p) { return p && typeof p.id === 'string'; });
        projects.forEach(function (p) {
          if (!Array.isArray(p.children)) p.children = [];
          // 兼容旧索引：补默认工作区字段
          if (!p.workspaceId) p.workspaceId = 'main';
          if (!p.workspaceName) p.workspaceName = root ? path.basename(root) : 'main';
          if (!p.workspacePath) p.workspacePath = root || null;
          p.children.forEach(function (child) {
            if (!child.workspaceId) child.workspaceId = p.workspaceId;
            if (!child.workspaceName) child.workspaceName = p.workspaceName;
            if (!child.workspacePath) child.workspacePath = p.workspacePath;
          });
        });
      }
      if (parsed && parsed.meta && typeof parsed.meta === 'object') {
        meta = Object.assign({}, meta, parsed.meta);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn('[store] 读取历史索引失败，将重新扫描：' + err.message);
      }
    }
    return snapshot();
  }

  function snapshot() {
    return { projects: projects.slice(), meta: Object.assign({}, meta, { count: projects.length }) };
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = {
      version: 1,
      savedAt: isoNow(),
      meta: Object.assign({}, meta, { count: projects.length }),
      projects: projects
    };
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  }

  function projectChanged(prev, next) {
    if (!prev) return true;
    if (prev.updatedAt !== next.updatedAt) return true;
    if (prev.path !== next.path) return true;
    if (prev.name !== next.name) return true;
    if (prev.summary !== next.summary) return true;
    if (prev.readmePath !== next.readmePath) return true;
    if (prev.summarySource !== next.summarySource) return true;
    if (!tagsEqual(prev.tags, next.tags)) return true;
    return false;
  }

  function childChanged(prev, next) {
    if (prev.updatedAt !== next.updatedAt) return true;
    if (prev.summary !== next.summary) return true;
    if (prev.name !== next.name) return true;
    if (prev.readmePath !== next.readmePath) return true;
    if (!tagsEqual(prev.tags, next.tags)) return true;
    if (prev.runHint !== next.runHint) return true;
    return false;
  }

  /**
   * 扫描结果来自只读扫描器，会把 LLM 富化字段覆盖掉；这里在文件未变化时保留上一次的
   * 摘要 / 名称 / 文档别名 / LLM 元信息，避免每次扫描在「启发式摘要」和「LLM 摘要」之间来回跳。
   */
  function preserveEnriched(prev, next) {
    if (!prev) return next;
    if (!next.docAlias && prev.docAlias) next.docAlias = prev.docAlias;
    if (!next.llm && prev.llm) next.llm = prev.llm;
    const unchanged = prev.updatedAt === next.updatedAt && prev.readmePath === next.readmePath;
    if (prev.summarySource === 'llm' && prev.llm && unchanged) {
      next.summary = prev.summary;
      next.summarySource = 'llm';
      if (prev.tags && prev.tags.length) next.tags = prev.tags;
      if (prev.docAlias && prev.docAlias.copied && prev.name) next.name = prev.name;
    }
    return next;
  }

  function mergeChildren(prevChildren, nextChildren, now) {
    const prevMap = new Map();
    (prevChildren || []).forEach(function (child) { prevMap.set(child.id, child); });
    const changedIds = [];
    const merged = (nextChildren || []).map(function (child) {
      const next = Object.assign({}, child);
      const prev = prevMap.get(next.id);
      next.children = [];
      if (!prev) {
        next.firstSeenAt = now;
        next.lastChangedAt = now;
        changedIds.push(next.id);
      } else {
        next.firstSeenAt = prev.firstSeenAt || now;
        preserveEnriched(prev, next);
        const changed = childChanged(prev, next);
        next.lastChangedAt = changed ? now : (prev.lastChangedAt || next.updatedAt);
        if (changed) changedIds.push(next.id);
      }
      return next;
    });
    return { children: merged, changedIds: changedIds };
  }

  function childrenStructureChanged(prevChildren, nextChildren) {
    const prevIds = (prevChildren || []).map(function (child) { return child.id; }).sort();
    const nextIds = (nextChildren || []).map(function (child) { return child.id; }).sort();
    return JSON.stringify(prevIds) !== JSON.stringify(nextIds);
  }

  function applyScan(scanned, stats) {
    const now = isoNow();
    const previous = new Map();
    for (const p of projects) previous.set(p.id, p);

    const next = [];
    const changedIds = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let subprojectCount = 0;

    for (const item of scanned) {
      const project = Object.assign({}, item);
      const prev = previous.get(project.id);
      const mergedChildren = mergeChildren(prev ? prev.children : [], project.children || [], now);
      project.children = mergedChildren.children;
      subprojectCount += project.children.length;

      if (!prev) {
        added += 1;
        project.firstSeenAt = now;
        project.lastChangedAt = now;
        changedIds.push(project.id);
      } else {
        project.firstSeenAt = prev.firstSeenAt || now;
        preserveEnriched(prev, project);
        const changed =
          projectChanged(prev, project) ||
          mergedChildren.changedIds.length > 0 ||
          childrenStructureChanged(prev.children, project.children);
        if (changed) {
          updated += 1;
          project.lastChangedAt = now;
          changedIds.push(project.id);
        } else {
          unchanged += 1;
          project.lastChangedAt = prev.lastChangedAt || project.updatedAt;
        }
      }
      next.push(project);
    }

    const nextIds = new Set(next.map(function (p) { return p.id; }));
    const removed = projects.filter(function (p) { return !nextIds.has(p.id); }).length;

    next.sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

    projects = next;
    meta.scannedAt = now;
    meta.scanDurationMs = (stats && stats.durationMs) || 0;
    meta.count = projects.length;
    meta.subprojectCount = subprojectCount;

    return {
      projects: projects.slice(),
      diff: { added: added, updated: updated, removed: removed, unchanged: unchanged, changedIds: changedIds }
    };
  }

  function applyEnrichment(patches) {
    if (!patches || typeof patches.get !== 'function') return 0;
    const now = isoNow();
    let applied = 0;

    function applyOne(project) {
      const patch = patches.get(project.id);
      if (!patch) return;
      let changed = false;
      for (const field of ['name', 'summary', 'summarySource', 'tags', 'readmePath', 'docAlias', 'llm']) {
        if (patch[field] === undefined) continue;
        if (JSON.stringify(project[field]) !== JSON.stringify(patch[field])) {
          project[field] = patch[field];
          changed = true;
        }
      }
      if (changed) {
        project.lastChangedAt = now;
        applied += 1;
      }
    }

    for (const project of projects) {
      applyOne(project);
      for (const child of project.children || []) applyOne(child);
    }
    return applied;
  }

  /** 应用磁盘占用结果（只更新元信息，不改变 updatedAt / lastChangedAt，不影响排序）。 */
  function applyUsage(patches) {
    if (!patches || typeof patches.get !== 'function') return 0;
    let applied = 0;

    function applyOne(project) {
      const patch = patches.get(project.id);
      if (!patch) return;
      const nextBytes = Number.isFinite(patch.bytes) ? Math.max(0, Math.round(patch.bytes)) : null;
      const nextError = patch.error ? String(patch.error) : null;
      const nextAt = patch.at || isoNow();
      const changed = project.diskUsageBytes !== nextBytes || (project.diskUsageError || null) !== nextError;
      if (changed || !project.diskUsageAt) {
        project.diskUsageBytes = nextBytes;
        project.diskUsageError = nextError;
        project.diskUsageAt = nextAt;
        applied += 1;
      }
    }

    for (const project of projects) {
      applyOne(project);
      for (const child of project.children || []) applyOne(child);
    }
    return applied;
  }

  /** 移除某个工作区的全部项目，返回移除的项目数。 */
  function removeByWorkspace(workspaceId) {
    const target = String(workspaceId || 'main');
    const next = [];
    let removed = 0;
    for (const project of projects) {
      if (String(project.workspaceId || 'main') === target) {
        removed += 1;
        continue;
      }
      next.push(project);
    }
    projects = next;
    meta.count = projects.length;
    meta.subprojectCount = projects.reduce(function (total, project) {
      return total + (project.children || []).length;
    }, 0);
    return removed;
  }

  function setMeta(patch) {
    meta = Object.assign({}, meta, patch);
    return meta;
  }

  function getProject(id) {
    for (const p of projects) {
      if (p.id === id) return p;
      for (const child of p.children || []) {
        if (child.id === id) return child;
      }
    }
    return null;
  }

  function childIndex() {
    const map = new Map();
    for (const p of projects) {
      for (const child of p.children || []) map.set(child.id, child);
    }
    return map;
  }

  function allProjects() {
    const out = [];
    for (const p of projects) {
      out.push(p);
      for (const child of p.children || []) out.push(child);
    }
    return out;
  }

  function list() {
    return projects.slice();
  }

  function hasChanges() {
    return projects.length > 0;
  }

  return {
    load: load,
    save: save,
    snapshot: snapshot,
    applyScan: applyScan,
    applyEnrichment: applyEnrichment,
    applyUsage: applyUsage,
    removeByWorkspace: removeByWorkspace,
    setMeta: setMeta,
    getProject: getProject,
    childIndex: childIndex,
    allProjects: allProjects,
    list: list,
    hasChanges: hasChanges,
    get meta() { return meta; }
  };
}
