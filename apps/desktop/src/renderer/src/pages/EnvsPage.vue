<template>
  <div class="envs-page">
    <header class="topbar">
      <div class="title">
        <h1>🌐 OneBrowser</h1>
        <el-tag size="small" type="info">{{ state.account.serverUrl }}</el-tag>
      </div>
      <div class="account">
        <span class="email">{{ state.account.email }}</span>
        <el-tag size="small" effect="plain">设备 {{ state.account.deviceId.slice(0, 8) }}</el-tag>
        <el-button size="small" @click="refresh">刷新</el-button>
        <el-button size="small" type="danger" plain @click="logout">登出</el-button>
      </div>
    </header>

    <main class="content">
      <div class="toolbar">
        <el-button type="primary" @click="showCreate = true">＋ 新建环境</el-button>
        <span class="hint">模式一：打开即从云端基线克隆，关闭即弃（点「保存为基线」更新基线）；模式二：同一时刻仅一台设备可用，他设备打开会接管。</span>
        <div class="kernel-chip">
          <template v-if="kernel">
            <el-tag v-if="kernel.ready" size="small" type="success">内核 {{ kernel.version }}</el-tag>
            <el-tag v-else size="small" type="info">内核未就绪</el-tag>
            <el-button v-if="!kernel.ready" size="small" :loading="kernelBusy" @click="downloadKernel">下载</el-button>
            <el-button size="small" text type="primary" @click="importKernel">本地导入</el-button>
            <span v-if="kernel.progress?.status === 'downloading'" class="hint">
              {{ kernel.progress.percent ?? 0 }}%
            </span>
            <span v-else-if="kernel.progress?.status === 'extracting'" class="hint">解压中…</span>
            <span v-else-if="kernel.message && !kernel.ready" class="hint">{{ kernel.message }}</span>
          </template>
        </div>
      </div>

      <el-table :data="state.envs" v-loading="loading" empty-text="还没有环境，先新建一个">
        <el-table-column label="环境" min-width="200">
          <template #default="{ row }">
            <div class="env-name">
              <b>{{ row.env.name }}</b>
              <el-tag size="small" :type="row.env.hosting === 'kernel' ? 'primary' : 'info'" effect="plain">
                {{ row.env.hosting === 'kernel' ? '指纹内核' : row.env.hosting === 'browser' ? '标准浏览器' : '内置' }}
              </el-tag>
              <el-tag size="small" :type="row.env.mode === 'snapshot' ? 'success' : 'warning'">
                {{ row.env.mode === 'snapshot' ? '模式一 · 快照' : '模式二 · 互斥' }}
              </el-tag>
            </div>
            <div class="env-meta">{{ row.env.homepage || '（未设置主页）' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="云端基线" width="190">
          <template #default="{ row }">
            <template v-if="row.hasBase">
              <span>{{ formatTime(row.baseCreatedAt) }}</span>
              <el-tag v-if="row.env.hosting === 'kernel'" size="small" type="warning" style="margin-left: 6px">文件级 L2</el-tag>
              <el-tag v-else size="small" type="info" style="margin-left: 6px">结构化 L1</el-tag>
            </template>
            <span v-else class="dim">无（首次登录后保存）</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="200">
          <template #default="{ row }">
            <el-tag v-if="row.phase === 'running'" type="success" size="small">运行中</el-tag>
            <el-tag v-else-if="row.phase === 'idle'" size="small" type="info">空闲</el-tag>
            <el-tag v-else size="small" type="warning">{{ phaseText(row.phase) }}</el-tag>
            <div v-if="row.message" class="env-meta">{{ row.message }}</div>
            <div v-if="row.leaseHolder && row.phase === 'idle'" class="env-meta">
              🔒 被设备 {{ row.leaseHolder.slice(0, 8) }} 占用
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <template v-if="row.phase === 'idle' || row.phase === ''">
              <el-button size="small" type="primary" @click="open(row.env.id)">
                {{ row.env.mode === 'exclusive' ? '打开 / 接管' : '打开' }}
              </el-button>
              <el-button size="small" @click="edit(row)">编辑</el-button>
              <el-popconfirm title="删除该环境及其云端数据？" @confirm="del(row.env.id)">
                <template #reference>
                  <el-button size="small" type="danger" plain>删除</el-button>
                </template>
              </el-popconfirm>
            </template>
            <template v-else-if="row.phase === 'running'">
              <el-button size="small" type="primary" plain @click="saveBase(row.env.id)">保存为基线</el-button>
              <el-button size="small" type="warning" plain @click="close(row.env.id)">
                {{ row.env.mode === 'exclusive' ? '保存并关闭' : '关闭（丢弃改动）' }}
              </el-button>
            </template>
            <template v-else>
              <el-button size="small" disabled>处理中…</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </main>

    <el-dialog v-model="showCreate" title="新建环境" width="520">
      <el-form label-width="110px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="例如：我的 B 站号" />
        </el-form-item>
        <el-form-item label="模式" required>
          <el-radio-group v-model="form.mode">
            <el-radio value="snapshot">模式一 · 快照分支</el-radio>
            <el-radio value="exclusive">模式二 · 互斥接管</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="承载" required>
          <el-radio-group v-model="form.hosting">
            <el-radio value="kernel">指纹内核（推荐，需下载内核）</el-radio>
            <el-radio value="browser">标准浏览器（本机 Edge/Chrome，无指纹，免下载）</el-radio>
            <el-radio value="builtin">内置轻量（Electron，无指纹）</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.hosting === 'kernel'">
          <el-form-item label="指纹平台">
            <el-select v-model="form.fpPlatform" style="width: 200px">
              <el-option value="Windows" label="Windows" />
              <el-option value="macOS" label="macOS" />
              <el-option value="Linux" label="Linux" />
            </el-select>
            <span class="hint" style="margin-left: 10px">种子决定整套指纹；跨设备同种子指纹一致</span>
          </el-form-item>
          <el-form-item label="时区">
            <el-select v-model="form.fpTzMode" style="width: 130px">
              <el-option value="seed" label="跟随种子" />
              <el-option value="auto" label="按代理 IP" />
              <el-option value="manual" label="手动" />
            </el-select>
            <el-input
              v-if="form.fpTzMode === 'manual'"
              v-model="form.fpTimezone"
              placeholder="Asia/Shanghai"
              style="width: 220px; margin-left: 8px"
            />
          </el-form-item>
          <el-form-item label="语言">
            <el-select v-model="form.fpLangMode" style="width: 130px">
              <el-option value="seed" label="跟随种子" />
              <el-option value="auto" label="按代理 IP" />
              <el-option value="manual" label="手动" />
            </el-select>
            <el-input
              v-if="form.fpLangMode === 'manual'"
              v-model="form.fpLang"
              placeholder="zh-CN"
              style="width: 220px; margin-left: 8px"
            />
          </el-form-item>
        </template>
        <el-form-item label="主页">
          <el-input v-model="form.homepage" placeholder="http://127.0.0.1:18080" />
        </el-form-item>
        <el-form-item label="代理（可选）">
          <div class="proxy-row">
            <el-select v-model="proxy.scheme" style="width: 90px">
              <el-option value="http" label="http" />
              <el-option value="socks5" label="socks5" />
            </el-select>
            <el-input v-model="proxy.host" placeholder="host" style="flex: 1" />
            <el-input-number v-model="proxy.port" :min="1" :max="65535" placeholder="端口" style="width: 110px" />
          </div>
          <div class="proxy-row" style="margin-top: 6px">
            <el-input v-model="proxy.username" placeholder="用户名（可选）" style="flex: 1" />
            <el-input v-model="proxy.password" type="password" placeholder="密码（可选）" style="flex: 1" />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showEdit" title="编辑环境" width="480">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="主页">
          <el-input v-model="editForm.homepage" />
        </el-form-item>
        <el-form-item label="会话检测">
          <div class="proxy-row">
            <el-input v-model="editForm.scPath" placeholder="检测路径，如 /api/whoami" style="flex: 1" />
          </div>
          <div class="proxy-row" style="margin-top: 6px">
            <el-input v-model="editForm.scMarker" placeholder="登录标记，响应体包含即视为有效" style="flex: 1" />
          </div>
          <span class="hint">打开环境恢复登录态后探测；失效则提示重新登录并更新基线。留空不检测</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref, type Ref } from 'vue'
import { ElNotification } from 'element-plus'
import type { AppState, EnvMode, EnvView, KernelStatus, ProxyConfig } from '@shared/types'
import { ob } from '../api'

const props = defineProps<{ state: AppState }>()
const emit = defineEmits<{ refresh: [] }>()

const kernel = inject<Ref<KernelStatus | null>>('kernelStatus', ref(null))
const kernelBusy = ref(false)

const loading = ref(false)
const creating = ref(false)
const showCreate = ref(false)
const showEdit = ref(false)
const editing = ref<EnvView | null>(null)

const form = reactive<{
  name: string
  mode: EnvMode
  hosting: 'kernel' | 'builtin'
  homepage: string
  fpPlatform: string
  fpTzMode: 'seed' | 'auto' | 'manual'
  fpTimezone: string
  fpLangMode: 'seed' | 'auto' | 'manual'
  fpLang: string
}>({
  name: '',
  mode: 'snapshot',
  hosting: 'kernel',
  homepage: 'http://127.0.0.1:18080',
  fpPlatform: 'Windows',
  fpTzMode: 'seed',
  fpTimezone: '',
  fpLangMode: 'seed',
  fpLang: ''
})
const proxy = reactive<Required<Pick<ProxyConfig, 'scheme' | 'host' | 'port'>> & Partial<ProxyConfig>>({
  scheme: 'http',
  host: '',
  port: 1080,
  username: '',
  password: ''
})
const editForm = reactive({ name: '', homepage: '', scPath: '', scMarker: '' })

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    ElNotification.error({ title: '操作失败', message: String(e) })
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  await guard(async () => {
    /* 状态经事件推送；这里触发一次主进程刷新 */
    await ob.getState()
  })
  loading.value = false
  emit('refresh')
}

async function logout(): Promise<void> {
  await guard(() => ob.logout())
  emit('refresh')
}

async function create(): Promise<void> {
  if (!form.name) {
    ElNotification.warning('请填写环境名称')
    return
  }
  creating.value = true
  const p: ProxyConfig | undefined = proxy.host
    ? {
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {})
      }
    : undefined
  await guard(async () => {
    await ob.createEnv({
      name: form.name,
      mode: form.mode,
      hosting: form.hosting,
      homepage: form.homepage,
      proxy: p,
      fingerprint: form.hosting === 'kernel'
        ? {
            platform: form.fpPlatform || undefined,
            timezoneMode: form.fpTzMode,
            ...(form.fpTzMode === 'manual' && form.fpTimezone ? { timezone: form.fpTimezone } : {}),
            langMode: form.fpLangMode,
            ...(form.fpLangMode === 'manual' && form.fpLang ? { lang: form.fpLang } : {})
          }
        : undefined
    })
    showCreate.value = false
    form.name = ''
  })
  creating.value = false
}

async function downloadKernel(): Promise<void> {
  kernelBusy.value = true
  await guard(() => ob.kernelDownload())
  kernelBusy.value = false
}

async function importKernel(): Promise<void> {
  const p = await ob.pickKernelPath()
  if (!p) return
  kernelBusy.value = true
  await guard(() => ob.kernelSetLocal(p))
  kernelBusy.value = false
}

function edit(row: EnvView): void {
  editing.value = row
  editForm.name = row.env.name
  editForm.homepage = row.env.homepage
  editForm.scPath = row.env.sessionCheck?.urlPath || ''
  editForm.scMarker = row.env.sessionCheck?.loggedInMarker || ''
  showEdit.value = true
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  creating.value = true
  await guard(async () => {
    const sessionCheck =
      editForm.scPath.trim() && editForm.scMarker.trim()
        ? { urlPath: editForm.scPath.trim(), loggedInMarker: editForm.scMarker.trim() }
        : null // 留空 = 清除检测
    await ob.updateEnv(editing.value!.env.id, {
      name: editForm.name,
      homepage: editForm.homepage,
      sessionCheck
    })
    showEdit.value = false
  })
  creating.value = false
}

async function open(id: string): Promise<void> {
  await guard(() => ob.openEnv(id))
}
async function close(id: string): Promise<void> {
  await guard(() => ob.closeEnv(id))
}
async function saveBase(id: string): Promise<void> {
  await guard(() => ob.saveBase(id))
}
async function del(id: string): Promise<void> {
  await guard(() => ob.deleteEnv(id))
}

function phaseText(p: string): string {
  const map: Record<string, string> = {
    opening: '打开中…',
    'downloading-kernel': '准备指纹内核…',
    acquiring: '获取租约…',
    'waiting-evict': '等待对方下线…',
    saving: '上传快照…',
    evicting: '被接管，保存中…',
    closing: '关闭中…'
  }
  return map[p] || p
}

function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<style scoped>
.envs-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.topbar {
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 12px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.title h1 {
  font-size: 18px;
  margin: 0;
}
.account {
  display: flex;
  align-items: center;
  gap: 10px;
}
.email {
  font-size: 13px;
  color: #606266;
}
.content {
  padding: 20px 24px;
  overflow: auto;
}
.toolbar {
  margin-bottom: 14px;
  display: flex;
  gap: 14px;
  align-items: center;
}
.kernel-chip {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  font-size: 12px;
  color: #8492a6;
}
.env-name {
  display: flex;
  gap: 8px;
  align-items: center;
}
.env-meta {
  font-size: 12px;
  color: #8492a6;
  margin-top: 3px;
}
.dim {
  color: #c0c4cc;
  font-size: 12px;
}
.proxy-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
</style>
