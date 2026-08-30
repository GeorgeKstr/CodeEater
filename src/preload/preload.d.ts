import { IpcApi } from '../shared/types'

declare global {
  interface Window {
    api: IpcApi
  }
}

export {}