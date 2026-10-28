<template>
  <LoginPage v-if="!state?.account" :initial-email="lastEmail" @done="refresh" />
  <EnvsPage v-else :state="state" @refresh="refresh" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref } from 'vue'
import { ElNotification } from 'element-plus'
import type { AppState, KernelStatus, MainEvent } from '@shared/types'
import { ob } from './api'
import { errMsg } from './fmt'
import LoginPage from './pages/LoginPage.vue'
import EnvsPage from './pages/EnvsPage.vue'

const state = ref<AppState | null>(null)
const lastEmail = ref(localStorage.getItem('ob:lastEmail') || '')

let off: (() => void) | null = null
const kernelStatus = ref<import('@shared/types').KernelStatus | null>(null)
const kernelBus = { listeners: new Set<(s: import('@shared/types').KernelStatus) => void>(), emit(s: import('@shared/types').KernelStatus) { for (const l of this.listeners) l(s) } }
provide('kernelStatus', kernelStatus)
provide('kernelBus', kernelBus)

async function refresh(): Promise<void> {
  try {
    state.value = await ob.getState()
    if (state.value.account) {
      localStorage.setItem('ob:lastEmail', state.value.account.email)
      lastEmail.value = state.value.account.email
    }
  } catch (e) {
    ElNotification.error({ title: '状态获取失败', message: errMsg(e) })
  }
}

// 24h 节流的后台更新检查（V0.5 阶段 a）：有新版 → 常驻通知，点击直达下载页
async function bgUpdateCheck(): Promise<void> {
  const last = Number(localStorage.getItem('ob:lastUpdateCheck') || 0)
  if (Date.now() - last < 24 * 3600 * 1000) return
  localStorage.setItem('ob:lastUpdateCheck', String(Date.now()))
  try {
    const r = await ob.checkUpdate()
    if (r.hasUpdate && r.releaseUrl) {
      ElNotification.info({
        title: `发现新版 v${r.latest}`,
        message: '点击此处打开下载页（当前版本不会自动安装）',
        duration: 0,
        onClick: () => {
          void ob.openUrl(r.releaseUrl || '')
        }
      })
    }
  } catch {
    /* 后台检查失败不打扰 */
  }
}

onMounted(() => {
  off = ob.onEvent((e: MainEvent) => {
    if (e.type === 'state') state.value = e.state
    else if (e.type === 'kernel') {
      kernelStatus.value = e.status
      kernelBus.emit(e.status)
    } else if (e.type === 'notify')
      (ElNotification as unknown as Record<string, (o: { title: string; message: string }) => void>)[
        e.level === 'success' ? 'success' : e.level === 'warning' ? 'warning' : 'error'
      ]({ title: 'OneBrowser', message: e.message })
  })
  ob.kernelStatus().then((s) => {
    kernelStatus.value = s
  })
  refresh()
  bgUpdateCheck()
})

onUnmounted(() => off?.())
</script>

<style>
#app {
  height: 100vh;
}
</style>
