<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>🌐 OneBrowser</h1>
      <p class="sub">指纹环境 + 登录态云端共享<span v-if="appVersion" class="ver">v{{ appVersion }}</span></p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="邮箱">
          <el-input ref="emailRef" v-model="email" placeholder="you@example.com" @keyup.enter="focusPassword" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span>主密码</span>
            <span class="label-hint">端到端加密密钥来源，服务端不可见</span>
          </template>
          <el-input
            ref="passwordRef"
            v-model="password"
            type="password"
            show-password
            placeholder="至少 8 位"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-alert
          v-if="mode === 'register'"
          type="warning"
          :closable="false"
          show-icon
          class="pw-alert"
          title="主密码无法找回"
          description="密码不上传服务器、无法重置：忘记后所有已上传的环境数据将永久无法解密。请务必牢记。"
        />
        <el-checkbox v-if="mode === 'register'" v-model="pwAcked" class="pw-ack">
          我已知晓主密码不可找回，并已妥善记忆
        </el-checkbox>
        <el-button
          type="primary"
          class="full"
          :loading="loading"
          :disabled="mode === 'register' && !pwAcked"
          @click="submit"
        >
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </el-button>
        <el-button link class="switch" @click="switchMode">
          {{ mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录' }}
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { InputInstance } from 'element-plus'
import { ElNotification } from 'element-plus'
import { ob } from '../api'
import { errMsg } from '../fmt'

const props = defineProps<{ initialEmail?: string }>()
const emit = defineEmits<{ done: [] }>()

const email = ref(props.initialEmail || '')
const password = ref('')
const mode = ref<'login' | 'register'>('login')
const loading = ref(false)
const pwAcked = ref(false)
const appVersion = ref('')
const emailRef = ref<InputInstance>()
const passwordRef = ref<InputInstance>()

onMounted(async () => {
  emailRef.value?.focus()
  try {
    appVersion.value = (await ob.appInfo()).version
  } catch {
    /* 版本号仅装饰用途，失败不打扰 */
  }
})

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  pwAcked.value = false
}

function focusPassword(): void {
  passwordRef.value?.focus()
}

async function submit(): Promise<void> {
  if (!email.value || password.value.length < 8) {
    ElNotification.warning({ title: '请输入邮箱与至少 8 位密码' })
    return
  }
  loading.value = true
  try {
    if (mode.value === 'login') await ob.login(email.value, password.value)
    else await ob.register(email.value, password.value)
    emit('done')
  } catch (e) {
    ElNotification.error({ title: mode.value === 'login' ? '登录失败' : '注册失败', message: errMsg(e) })
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f2d3d 0%, #2b4a6f 100%);
}
.login-card {
  width: 400px;
  background: #fff;
  border-radius: 12px;
  padding: 32px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
h1 {
  margin: 0 0 4px;
  font-size: 24px;
}
.sub {
  color: #8492a6;
  margin: 0 0 20px;
  font-size: 13px;
}
.ver {
  margin-left: 8px;
  color: #b0b9c6;
  font-size: 12px;
}
.label-hint {
  margin-left: 8px;
  font-size: 12px;
  font-weight: normal;
  color: #a8abb2;
}
.pw-alert {
  margin-bottom: 10px;
}
.pw-ack {
  width: 100%;
  margin-bottom: 12px;
}
.full {
  width: 100%;
}
.switch {
  width: 100%;
  margin-top: 8px;
}
</style>
