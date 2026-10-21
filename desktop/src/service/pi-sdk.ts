import { ApiError } from '../shared/api-error.ts'

export const EXPECTED_PI_VERSION = '1.2.0'

export async function loadPiSdk(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
  try {
    const sdk = await import('@earendil-works/pi-coding-agent')
    if (sdk.VERSION !== EXPECTED_PI_VERSION) {
      throw new ApiError('PI_VERSION_MISMATCH', 'Pi 版本与应用固定版本不一致', 503)
    }
    return sdk
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('PI_SDK_LOAD_FAILED', 'Pi SDK 加载失败，请检查运行环境', 503)
  }
}
