/// <reference types="vite/client" />
import { IpcApi } from '../shared/types'

declare global {
  interface Window {
    api: IpcApi
  }
}

declare module 'monaco-editor/editor/editor.worker.js?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module 'monaco-editor/language/json/json.worker.js?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module 'monaco-editor/language/css/css.worker.js?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module 'monaco-editor/language/html/html.worker.js?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
declare module 'monaco-editor/language/typescript/ts.worker.js?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

export {}