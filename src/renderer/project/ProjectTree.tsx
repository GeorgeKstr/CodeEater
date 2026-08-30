import React, { useState } from 'react'
import { useApp } from '../app/AppContext'
import { TreeNode } from '../../shared/types'

function indent(level: number): number {
  return 6 + level * 14
}

export function ProjectTree(): React.JSX.Element {
  const app = useApp()
  const rows: React.ReactNode[] = []
  const build = (nodes: TreeNode[] | null, level: number): void => {
    if (!nodes) return
    for (const n of nodes) {
      const active = app.activePath === n.relPath && !n.isDir
      rows.push(
        <div
          key={n.path}
          className={`tree-row${active ? ' active' : ''}`}
          style={{ paddingLeft: indent(level) }}
          onClick={() => {
            if (n.isDir) void app.toggleDir(n.relPath)
            else void app.openFile(n.relPath)
          }}
          onDoubleClick={() => {
            if (n.isDir) void app.toggleDir(n.relPath)
          }}
          title={n.relPath}
        >
          <span className="twisty">{n.isDir ? (n.expanded ? '▾' : '▸') : ''}</span>
          <span className="icon">{n.isDir ? '📁' : fileIcon(n.relPath)}</span>
          <span className="name">{n.name}</span>
          {!n.isDir && app.buffers[n.relPath]?.dirty && <span className="dot" style={{ borderRadius: '50%', width: 6, height: 6, marginLeft: 'auto' }} />}
        </div>
      )
      if (n.isDir && n.expanded && n.children) build(n.children, level + 1)
    }
  }
  build(app.tree, 0)

  if (!app.tree || app.tree.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>Empty project</div>
  }

  return <div style={{ minWidth: 0 }}>{rows}</div>
}

function fileIcon(relPath: string): string {
  const name = relPath.split('/').pop() ?? ''
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (name === 'package.json' || name.endsWith('.json')) return '🟡'
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': return '📘'
    case 'py': return '🐍'
    case 'rs': return '🦀'
    case 'go': return '🐹'
    case 'md': return '📄'
    case 'html': case 'css': case 'scss': return '🎨'
    default: return '📄'
  }
}

export function projectTreeSummary(tree: TreeNode[] | null): string {
  const files = countFiles(tree)
  const dirs = countDirs(tree)
  return `${files} files · ${dirs} dirs`
}

function countFiles(nodes: TreeNode[] | null): number {
  if (!nodes) return 0
  let c = 0
  for (const n of nodes) {
    if (n.isDir) c += countFiles(n.children ?? [])
    else c++
  }
  return c
}
function countDirs(nodes: TreeNode[] | null): number {
  if (!nodes) return 0
  let c = 0
  for (const n of nodes) {
    if (n.isDir) c += 1 + countDirs(n.children ?? [])
  }
  return c
}

void useState