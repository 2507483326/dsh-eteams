/**
 * 测试临时目录清理（SQLite 改造后所有落库测试共用，tests/ 内部辅助）：
 * getDb 按状态根缓存连接（src/host/state/db.ts），不关连接就占住
 * db/-wal/-shm 三个文件，Windows 上 rmSync 直接 EPERM。先 closeDb 再删；
 * 刚写完的文件偶发仍被句柄短暂占住（Defender 扫描），退避重试一轮，
 * 仍失败则按文件逐个删（残留在临时目录不碍事）。
 *
 * @module dsh-eteams/tests/support/tmpWorkspace
 */
import { readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { closeDb } from '../../src/host/state/db';

/** 同步小睡（Atomics.wait 不可用时自旋兜底）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 自旋兜底
    }
  }
}

/** 后序逐项删除（兜底：跳过删不掉的项，残留在临时目录不碍事）。 */
function rmTreeItemwise(dir: string): void {
  const walk = (root: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = `${root}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else {
        try {
          unlinkSync(p);
        } catch {
          // 留在临时目录不碍事
        }
      }
    }
    try {
      rmdirSync(root);
    } catch {
      // 同上
    }
  };
  walk(dir);
}

/**
 * 测试收尾：关掉该状态根（或工作区根下 .eteams）的 SQLite 连接后删目录。
 * stateRootKey 与运行时 joinPath 同口径——runtime 用「/」拼状态根
 * （base.ts joinPath），纯 node:path join 的反斜杠串是另一把键。
 */
export function cleanupTempWorkspace(workspace: string, stateDir = '.eteams'): void {
  closeDb(`${workspace}/${stateDir}`);
  closeDb(workspace);
  const attempts = [0, 50, 150, 400];
  for (const waitMs of attempts) {
    if (waitMs > 0) sleepSync(waitMs);
    try {
      rmSync(workspace, { recursive: true, force: true });
      return;
    } catch {
      // 重试
    }
  }
  rmTreeItemwise(workspace);
}