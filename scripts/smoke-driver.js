/**
 * Smoke test driver — executed inside the real renderer via executeJavaScript.
 * Drives the full product using window.api only (real IPC, real main process,
 * real AI endpoint). Writes a JSON report that the main process saves.
 */
;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => {
    out.steps.push({ name, ok, detail })
    console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '')
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    // 1. open project
    const project = await window.api.project.open('/tmp/ce-demo')
    step('open-project', !!project, project.name)
    await sleep(4000)

    // 2. tree + files
    const tree = await window.api.project.getTree()
    const flat = JSON.stringify(tree)
    step('tree-built', flat.includes('SearchService.ts') && flat.includes('UserService.ts'))

    // 3. AI connect
    let ai = await window.api.ai.getState()
    for (let i = 0; i < 30 && ai.status !== 'connected'; i++) {
      await sleep(500)
      ai = await window.api.ai.getState()
    }
    step('ai-connected', ai.status === 'connected', `${ai.status} ${ai.activeModel ?? ''}`)

    // 4. deterministic search
    const textHits = await window.api.search.text({ query: 'rankResults', maxResults: 20 })
    step('text-search', textHits.some((h) => h.relPath.endsWith('SearchService.ts')), `${textHits.length} hits`)

    // 5. fuzzy files
    const fuzzy = await window.api.search.files('user', 10)
    step('fuzzy-files', fuzzy.some((f) => f.relPath.includes('UserService')), fuzzy.map((f) => f.relPath).join(','))

    // 6. symbols / chunks (tree-sitter)
    const symbols = await window.api.search.getSymbols('src/services/UserService.ts')
    step(
      'symbols',
      symbols.some((s) => s.name === 'authenticate') && symbols.some((s) => s.name === 'UserService'),
      symbols.map((s) => `${s.kind}:${s.name}`).join(',')
    )
    const chunks = await window.api.search.getChunks('src/services/UserService.ts')
    step('chunks', chunks.length >= 4, `${chunks.length} chunks`)

    // 7. imports
    const imports = await window.api.search.getImports('src/auth/AuthController.ts')
    step('imports', imports.some((i) => i.rawTarget.includes('UserService')), JSON.stringify(imports))

    // 8. file overview (AI)
    const fo = await window.api.overview.getFileOverview('src/services/UserService.ts')
    step('file-overview', fo.summary.length > 10, fo.summary)

    // 9. project overview (AI)
    const po = await window.api.overview.getProjectOverview()
    step('project-overview', po.summary.length > 10, po.summary)
    step('po-commands', po.commands.length >= 0, JSON.stringify(po.commands))
    step('po-features', po.features.length > 0, po.features.map((f) => f.name).join(','))

    // 10. AI search
    const expanded = await window.api.ai.run('ai-search-expand', { query: 'password reset' })
    const aiSearch = await window.api.ai.run('ai-search-final', { query: 'password reset', expanded })
    step('ai-search', aiSearch.results.length > 0, `${aiSearch.results.length} results: ` + aiSearch.results.map((r) => `${r.path}(${r.startLine})`).join(','))

    // 11. selection edit → ChangeRequest → apply → verify → revert
    const target = 'src/services/UserService.ts'
    const before = await window.api.fs.readFile(target)
    const cr = await window.api.changes.create({
      prompt: 'smoke test edit',
      scope: 'selection',
      summary: 'Add a friendly greeting method',
      edits: [
        {
          operation: 'insert',
          path: target,
          startLine: 0,
          replacement: '// smoke-insert-marker\n'
        }
      ]
    })
    step('change-request-created', cr.status === 'pending', cr.id.slice(0, 8))
    const applied = await window.api.changes.apply(cr.id)
    step('change-request-applied', applied.status === 'accepted', applied.status)
    await sleep(800)
    const after = await window.api.fs.readFile(target)
    step('edit-applied-to-disk', after.includes('smoke-insert-marker'))
    const reverted = await window.api.changes.revert(cr.id)
    step('change-request-reverted', reverted.status === 'reverted')
    await sleep(800)
    const restored = await window.api.fs.readFile(target)
    step('edit-reverted-from-disk', restored === before)

    // 12. editing AI op (real proposal through context building)
    const selEdit = await window.api.ai.run('selection-edit', {
      prompt: 'Add input validation to resetPassword: reject empty emails',
      filePath: target,
      selectionStart: { line: 25, character: 0 },
      selectionEnd: { line: 30, character: 0 },
      selectedText: ''
    })
    step('ai-selection-edit', selEdit.status === 'pending' && selEdit.edits.length > 0, `${selEdit.edits.length} edits: ${selEdit.summary}`)
    const rejected = await window.api.changes.reject(selEdit.id)
    step('ai-edit-rejected', rejected.status === 'rejected')
  } catch (e) {
    step('uncaught', false, e.message)
  }
  window.__smokeResult = out
  return out
})()