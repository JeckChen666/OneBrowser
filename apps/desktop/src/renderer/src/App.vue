<template>
  <LoginPage v-if="!state?.account" :initial-email="lastEmail" @done="refresh" />
  <EnvsPage v-else :state="state" @refresh="refresh" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElNotification } from 'element-plus'
import type { AppState, MainEvent } from '@shared/types'
import { ob } from './api'
import LoginPage from './pages/LoginPage.vue'
import EnvsPage from './pages/EnvsPage.vue'

const state = ref<AppState | null>(null)
const lastEmail = ref(localStorage.getItem('ob:lastEmail') || '')

let off: (() => void) | null = null

async function refresh(): Promise<void> {
  try {
    state.value = await ob.getState()
    if (state.value.account) {
      localStorage.setItem('ob:lastEmail', state.value.account.email)
      lastEmail.value = state.value.account.email
    }
  } catch (e) {
    ElNotification.error({ title: '状态获取失败', message: String(e) })
  }
}

onMounted(() => {
  off = ob.onEvent((e: MainEvent) => {
    if (e.type === 'state') state.value = e.state
    else if (e.type === 'notify')
      (ElNotification as unknown as Record<string, (o: { title: string; message: string }) => void>)[
        e.level === 'success' ? 'success' : e.level === 'warning' ? 'warning' : 'error'
      ]({ title: 'OneBrowser', message: e.message })
  })
  refresh()
})

onUnmounted(() => off?.())
</script>

<style>
#app {
  height: 100vh;
}
</style>
