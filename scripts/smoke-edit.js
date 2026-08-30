;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    await window.api.project.open('/tmp/ce-demo')
    await sleep(3000)
    let ai = await window.api.ai.getState()
    for (let i = 0; i < 30 && ai.status !== 'connected'; i++) { await sleep(500); ai = await window.api.ai.getState() }
    step('ai-connected', ai.status === 'connected', ai.activeModel ?? '')

    const target = 'src/services/UserService.ts'
    let selEdit = null
    for (let attempt = 0; attempt < 3 && !selEdit; attempt++) {
      try {
        selEdit = await window.api.ai.run('selection-edit', {
          prompt: 'Add input validation to resetPassword: return false immediately when the email is empty',
          filePath: target,
          selectionStart: { line: 31, character: 0 },
          selectionEnd: { line: 37, character: 0 },
          selectedText: ''
        })
      } catch (e) {
        console.log('SMOKE attempt', attempt, 'failed:', e.message)
        await sleep(2000)
      }
    }
    step('ai-selection-edit', !!selEdit && selEdit.status === 'pending', selEdit ? `${selEdit.edits.length} edits — ${selEdit.summary}` : 'no proposal')
    if (selEdit) {
      const diff = await window.api.changes.get(selEdit.id)
      step('cr-diffs-readable', diff.files.length > 0, diff.files.map((f) => `${f.path}:${f.operation}`).join(','))
      const rejected = await window.api.changes.reject(selEdit.id)
      step('ai-edit-rejected', rejected.status === 'rejected')
    }
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()