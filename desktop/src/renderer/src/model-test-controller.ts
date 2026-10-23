import { ModelTestController } from '../../shared/model-test'
// 一份 renderer 内存实例。导航卸载不等于取消后端请求，也不允许重挂载重复发请求。
export const modelTestController = new ModelTestController()
