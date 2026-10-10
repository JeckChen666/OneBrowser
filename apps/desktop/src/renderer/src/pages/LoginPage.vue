<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>🌐 OneBrowser</h1>
      <p class="sub">指纹环境 + 登录态云端共享（V0.1.0）</p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="邮箱">
          <el-input v-model="email" placeholder="you@example.com" autofocus />
        </el-form-item>
        <el-form-item label="主密码（E2E 加密密钥来源，服务端不可见）">
          <el-input v-model="password" type="password" show-password placeholder="至少 8 位" @keyup.enter="submit" />
        </el-form-item>
        <el-button
          type="primary"
          class="full"
          :loading="loading"
          @click="submit"
        >
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </el-button>
        <el-button link class="switch" @click="mode = mode === 'login' ? 'register' : 'login'">
          {{ mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录' }}
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElNotification } from 'element-plus'
import { ob } from '../api'

const props = defineProps<{ initialEmail?: string }>()
const emit = defineEmits<{ done: [] }>()

const email = ref(props.initialEmail || '')
const password = ref('')
const mode = ref<'login' | 'register'>('login')
const loading = ref(false)

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
    ElNotification.error({ title: mode.value === 'login' ? '登录失败' : '注册失败', message: String(e) })
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
.full {
  width: 100%;
}
.switch {
  width: 100%;
  margin-top: 8px;
}
</style>
