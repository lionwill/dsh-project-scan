import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 只读目录浏览，供页面里的「添加工作区」目录选择器使用。
 *
 * list(inputPath, options?) -> { path, realPath, parent, isRoot, home, entries }
 *   - 只列目录，不列文件；默认跳过以 . 开头的目录；按名称排序后最多 300 条。
 *   - entries: [{ name, path, hasProjectMarker }]，hasProjectMarker 表示该目录根下有
 *     README.md / package.json / .git / index.html / project.godot / requirements.txt 之一
 *     （只 stat 这几个名字，不递归、不读文件内容）。
 *   - options: { hidden?: boolean } 为 true 时包含隐藏目录。
 *   - 不做递归、不跟随符号链接（符号链接目录不进入列表），交给调用方 realpath 归一。
 *   - 非法路径抛错，err.code = INVALID_PATH / NOT_DIRECTORY / NOT_READABLE。
 */

const MAX_ENTRIES = 300;
const MARKER_FILES = ['README.md', 'package.json', '.git', 'index.html', 'project.godot', 'requirements.txt'];

function browseError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 展开 ~、允许相对路径（相对进程 cwd），返回绝对路径；不访问文件系统。 */
function toAbsolute(inputPath) {
  if (typeof inputPath !== 'string') throw browseError('INVALID_PATH', '路径必须是字符串');
  const raw = inputPath.trim();
  if (!raw) throw browseError('INVALID_PATH', '路径不能为空');
  let target = raw;
  if (target === '~') {
    target = os.homedir();
  } else if (target.startsWith('~/')) {
    target = path.join(os.homedir(), target.slice(2));
  } else if (target.startsWith('~')) {
    throw browseError('INVALID_PATH', '不支持 ~用户 形式的路径，请使用绝对路径');
  }
  return path.resolve(target);
}

function hasProjectMarker(dirPath) {
  for (const marker of MARKER_FILES) {
    try {
      fs.statSync(path.join(dirPath, marker));
      return true;
    } catch (err) {
      // 不存在 / 无权限都视为没有该标记
    }
  }
  return false;
}

function wantsHidden(options) {
  if (!options || typeof options !== 'object') return false;
  const value = options.hidden;
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function createFsBrowse(options) {
  const opts = options || {};
  const home = os.homedir();
  const defaultRoot = path.resolve(opts.defaultRoot || process.cwd());
  let defaultRootReal = defaultRoot;
  try {
    defaultRootReal = fs.realpathSync(defaultRoot);
  } catch (err) {
    // defaultRoot 暂时不存在时按字面路径比较
  }

  function list(inputPath, listOptions) {
    const target = toAbsolute(inputPath);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        throw browseError('INVALID_PATH', '路径不存在：' + target);
      }
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        throw browseError('NOT_READABLE', '没有访问权限：' + target);
      }
      throw browseError('INVALID_PATH', '无法访问路径：' + target);
    }
    if (!stat.isDirectory()) {
      throw browseError('NOT_DIRECTORY', '不是目录：' + target);
    }
    try {
      fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      throw browseError('NOT_READABLE', '没有读取权限：' + target);
    }

    let realPath;
    try {
      realPath = fs.realpathSync(target);
    } catch (err) {
      throw browseError('INVALID_PATH', '无法解析路径：' + target);
    }

    let dirents;
    try {
      dirents = fs.readdirSync(realPath, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        throw browseError('NOT_READABLE', '没有读取权限：' + target);
      }
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        throw browseError('INVALID_PATH', '路径不存在：' + target);
      }
      throw browseError('NOT_READABLE', '目录读取失败：' + target);
    }

    const includeHidden = wantsHidden(listOptions);
    const names = [];
    for (const dirent of dirents) {
      // dirent.isDirectory() 对符号链接为 false —— 也就是列表里不会出现符号链接目录
      if (!dirent.isDirectory()) continue;
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      names.push(dirent.name);
    }
    names.sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
    });

    const entries = names.slice(0, MAX_ENTRIES).map(function (name) {
      const childPath = path.join(realPath, name);
      return { name: name, path: childPath, hasProjectMarker: hasProjectMarker(childPath) };
    });

    const atRoot = realPath === path.parse(realPath).root;
    return {
      path: target,
      realPath: realPath,
      parent: atRoot ? null : path.dirname(realPath),
      isRoot: realPath === defaultRootReal || target === defaultRoot,
      home: home,
      entries: entries
    };
  }

  return { list: list };
}
