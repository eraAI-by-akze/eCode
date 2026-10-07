import type { EcodeApi } from '../shared/types'

declare global {
  interface Window {
    ecode: EcodeApi
  }
}

export {}
