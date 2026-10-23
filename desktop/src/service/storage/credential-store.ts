import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'
import { credentialScript } from './windows-credential-script.ts'

export interface CredentialStore {
  write(reference: string, secret: string): Promise<void>
  read(reference: string): Promise<string | undefined>
  delete(reference: string): Promise<void>
}
const referencePattern = /^PiAuditHarness\/model\/[a-f0-9-]{36}$/
export class WindowsCredentialStore implements CredentialStore {
  private async invoke(
    operation: 'write' | 'read' | 'delete',
    reference: string,
    secret?: string
  ): Promise<string | undefined> {
    if (process.platform !== 'win32')
      throw new ApiError('CREDENTIAL_PLATFORM_UNSUPPORTED', '本实现需要 Windows 凭据管理器', 503)
    if (!referencePattern.test(reference))
      throw new ApiError('INVALID_CREDENTIAL_REFERENCE', '系统凭据引用格式无效', 400)
    if (
      operation === 'write' &&
      (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > 2048)
    )
      throw new ApiError('INVALID_CREDENTIAL_VALUE', '系统凭据长度无效', 400)
    const executable = join(
      process.env.SystemRoot ?? 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    return new Promise((resolve, reject) => {
      // 使用参数数组、固定脚本、隐藏窗口、私有管道。不要记录 stdout/stderr/输入。
      const child = spawn(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(credentialScript, 'utf16le').toString('base64')
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      )
      let output = ''
      let finished = false
      const fail = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.kill()
        reject(
          new ApiError(
            'CREDENTIAL_STORE_FAILED',
            '系统凭据读写失败，请检查当前 Windows 登录环境',
            503,
            true
          )
        )
      }
      const timer = setTimeout(fail, 6000)
      child.on('error', fail)
      child.stdin.on('error', fail)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (Buffer.byteLength(output) > 16384) fail()
      })
      child.once('close', (code) => {
        if (finished) return
        if (code !== 0) {
          fail()
          return
        }
        try {
          const body: unknown = JSON.parse(output)
          if (
            !body ||
            typeof body !== 'object' ||
            !('ok' in body) ||
            body.ok !== true ||
            !('secret' in body) ||
            !(body.secret === null || typeof body.secret === 'string')
          ) {
            fail()
            return
          }
          finished = true
          clearTimeout(timer)
          resolve(typeof body.secret === 'string' ? body.secret : undefined)
        } catch {
          fail()
        }
      })
      child.stdin.end(
        JSON.stringify({ operation, reference, ...(secret === undefined ? {} : { secret }) })
      )
    })
  }
  async write(reference: string, secret: string): Promise<void> {
    await this.invoke('write', reference, secret)
  }
  async read(reference: string): Promise<string | undefined> {
    return this.invoke('read', reference)
  }
  async delete(reference: string): Promise<void> {
    await this.invoke('delete', reference)
  }
}
