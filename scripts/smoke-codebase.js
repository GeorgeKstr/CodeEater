;(async () => {
  const out = { steps: [] }
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log('SMOKE', ok ? 'OK ' : 'FAIL', name, detail ?? '') }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    await window.api.project.open('/tmp/ce-demo')
    await sleep(3000)
    let ai = await window.api.ai.getState()
    for (let i = 0; i < 30 && ai.status !== 'connected'; i++) { await sleep(500); ai = await window.api.ai.getState() }
    step('ai-connected', ai.status === 'connected', `${ai.status} ${ai.activeModel ?? ''}`)

    let plan = null
    for (let a = 0; a < 1 && !plan; a++) {
      try {
        plan = await window.api.ai.run('codebase-plan', { prompt: 'Add a helper method isValidEmail to the UserService class' })
      } catch (e) {
        console.log('SMOKE plan attempt', a, 'failed:', e.message)
        await sleep(1500)
      }
    }
    step('codebase-plan', !!plan && plan.files?.length > 0, plan ? `${plan.files.length} files: ` + plan.files.map((f) => f.path).join(', ') : 'no plan')

    let cr = null
    if (plan?.files?.length) {
      for (let a = 0; a < 1 && !cr; a++) {
        try {
          cr = await window.api.ai.run('codebase-edit', { prompt: 'Add a helper method isValidEmail to the UserService class', plan })
        } catch (e) {
          console.log('SMOKE edit attempt', a, 'failed:', e.message)
          await sleep(1500)
        }
      }
    }
    step('codebase-edit', !!cr && cr.status === 'pending', cr ? `${cr.edits.length} edits — ${cr.summary}` : 'no change request')
    if (cr) {
      const rejected = await window.api.changes.reject(cr.id)
      step('cr-rejected', rejected.status === 'rejected')
    }
  } catch (e) {
    step('uncaught', false, e.message)
  }
  return out
})()