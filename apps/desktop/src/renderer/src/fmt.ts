// 渲染进程共享的展示格式化工具

/** Electron IPC 错误串是 "Error invoking remote method 'xxx': Error: 业务消息" 多层包装，剥到可读的业务消息 */
export function errMsg(e: unknown): string {
  let s = e instanceof Error ? e.message : String(e)
  s = s.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  s = s.replace(/^(Error:\s*)+/, '')
  if (/ECONNREFUSED|fetch failed|network/i.test(s)) s = '无法连接服务端，请检查网络或服务端地址'
  return s
}

/** 紧凑时间（同一年省略年份）：10-27 14:30 */
export function fmtTimeShort(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}-${d.getDate()} ${hm}`
    : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/** 完整时间：2026-10-27 14:30:05 */
export function fmtTimeFull(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
