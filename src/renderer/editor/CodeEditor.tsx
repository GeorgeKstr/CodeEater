import React, { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useApp } from '../app/AppContext'
import { languageFromPath } from '../../shared/utils'

/**
 * Single Monaco editor instance that swaps models per active tab.
 * Models persist across tab switches (undo history preserved).
 */

const modelCache = new Map<string, monaco.editor.ITextModel>()

export interface SelectionSnapshot {
  startLine: number
  endLine: number
  text: string
}

interface Props {
  onSelectionChange: (sel: SelectionSnapshot | null) => void
}

function monacoLanguage(relPath: string): string {
  const lang = languageFromPath(relPath)
  const map: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'javascript',
    json: 'json',
    python: 'python',
    ruby: 'ruby',
    rust: 'rust',
    go: 'go',
    c: 'c',
    cpp: 'cpp',
    java: 'java',
    css: 'css',
    scss: 'scss',
    html: 'html',
    markdown: 'markdown',
    yaml: 'yaml',
    toml: 'ini',
    shell: 'shell',
    sql: 'sql',
    vue: 'html',
    php: 'php',
    csharp: 'csharp',
    swift: 'swift',
    kotlin: 'kotlin',
    dart: 'dart',
    lua: 'lua',
    solidity: 'solidity',
    scala: 'scala'
  }
  return map[lang] ?? 'plaintext'
}

export function CodeEditor({ onSelectionChange }: Props): React.JSX.Element | null {
  const app = useApp()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const currentPathRef = useRef<string | null>(null)
  const selectionRef = useRef<SelectionSnapshot | null>(null)

  const activePath = app.activePath
  const buffer = activePath ? app.buffers[activePath] : undefined

  // create editor once
  useEffect(() => {
    if (!hostRef.current || editorRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      theme: 'vs-dark',
      fontSize: 13,
      fontFamily: "var(--mono)",
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 2,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      wordWrap: 'off',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true }
    })
    editorRef.current = editor
    editor.onDidChangeModelContent((e) => {
      if (!currentPathRef.current) return
      if (e.isFlush) return
      const value = editor.getValue()
      app.updateBuffer(currentPathRef.current, value)
      app.setDirty(currentPathRef.current, true)
    })
    editor.onDidChangeCursorSelection((e) => {
      if (e.selection && !e.selection.isEmpty()) {
        const model = editor.getModel()
        if (!model) return
        const sel = e.selection
        const text = model.getValueInRange(sel)
        const snap: SelectionSnapshot = {
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          text
        }
        selectionRef.current = snap
        onSelectionChange(snap)
      } else {
        selectionRef.current = null
        onSelectionChange(null)
      }
    })
    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  // swap model when activePath changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activePath) {
      currentPathRef.current = null
      if (editor) {
        if (editor.getModel()) editor.setModel(null)
      }
      return
    }
    currentPathRef.current = activePath
    let model = modelCache.get(activePath)
    if (!model) {
      const content = app.buffers[activePath]?.content ?? ''
      model = monaco.editor.createModel(content, monacoLanguage(activePath), monaco.Uri.file(activePath))
      modelCache.set(activePath, model)
    }
    if (editor.getModel() !== model) {
      editor.setModel(model)
    }
    const lineCount = model.getLineCount()
    editor.revealLineInCenter(Math.max(1, Math.min(lineCount, 1)))
    editor.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

  // external content updates (watcher) — only when not dirty
  useEffect(() => {
    if (!activePath || !buffer) return
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    if (model.uri.path !== '/' + activePath) return
    if (buffer.dirty) return
    if (model.getValue() !== buffer.content) {
      model.setValue(buffer.content)
      editor.setPosition({ lineNumber: 1, column: 1 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer?.content, buffer?.dirty])

  // handle reveal requests (jump to line / select)
  useEffect(() => {
    if (!app.reveal) return
    const r = app.reveal
    if (r.path !== activePath) {
      void app.openFile(r.path).then(() => {
        requestAnimationFrame(() => applyReveal(r))
      })
    } else {
      applyReveal(r)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.reveal])

  function applyReveal(r: { startLine: number; endLine?: number; selectText?: string; ts: number }): void {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const lineCount = model.getLineCount()
    const start = Math.max(1, Math.min(lineCount, r.startLine))
    let end = r.endLine ? Math.max(start, Math.min(lineCount, r.endLine)) : start
    if (r.selectText && typeof r.selectText === 'string') {
      const scope = new monaco.Range(start, 1, lineCount, model.getLineMaxColumn(lineCount))
      const range = model.findMatches(r.selectText.slice(0, 300), scope, true, false, null, true)
      if (range.length > 0) {
        const m = range[0].range
        editor.setSelection(m)
        editor.revealRangeInCenter(m)
        editor.focus()
        return
      }
    }
    const range = new monaco.Range(start, 1, end, (model.getLineMaxColumn(end)))
    editor.setSelection(range)
    editor.revealRangeInCenter(range)
    editor.focus()
  }

  if (!activePath) return null

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}