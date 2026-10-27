<template>
  <div class="envs-page">
    <header class="topbar">
      <div class="title">
        <h1>🌐 OneBrowser</h1>
        <span v-if="appVersion" class="ver">v{{ appVersion }}</span>
      </div>
      <div class="account">
        <span class="email">{{ state.account.email }}</span>
        <el-tag size="small" effect="plain">设备 {{ state.account.deviceId.slice(0, 8) }}</el-tag>
        <el-popover placement="bottom-end" width="420" trigger="click">
          <template #reference>
            <el-button size="small" circle title="使用说明">?</el-button>
          </template>
          <div class="help-pop">
            <div class="hp-sec">
              <div class="hp-title">两种模式</div>
              <p><b>快照分支</b>：打开 = 从云端基线克隆一份，关闭默认丢弃改动；点「保存为基线」才把当前登录态固化上云。</p>
              <p><b>互斥接管</b>：同一时刻仅一台设备可用；关闭时自动保存，其他设备打开会保存并接管。</p>
            </div>
            <div class="hp-sec">
              <div class="hp-title">三种承载</div>
              <p><b>指纹内核</b>：每环境独立浏览器指纹（UA/时区/语言等），防关联，首次需下载内核。</p>
              <p><b>标准浏览器</b>：用本机 Edge/Chrome 隔离窗口，无指纹、免下载。</p>
              <p><b>内置轻量</b>：Electron 内置窗口，无指纹、秒开。</p>
            </div>
            <div class="hp-sec">
              <div class="hp-title">典型流程</div>
              <p>新建环境 → 打开并登录目标网站 → 保存为基线 → 换设备打开同一环境，登录态自动恢复。</p>
            </div>
            <div class="hp-sec hp-dim">服务端：{{ state.account.serverUrl }}</div>
          </div>
        </el-popover>
        <el-button size="small" :loading="loading" @click="refresh">刷新</el-button>
        <el-button size="small" type="danger" plain @click="logout">登出</el-button>
      </div>
    </header>

    <main class="content">
      <div class="toolbar">
        <el-button type="primary" @click="showCreate = true">＋ 新建环境</el-button>
        <span class="stats">共 {{ state.envs.length }} 个 · 运行中 {{ runningCount }} 个</span>
        <div class="kernel-chip">
          <el-popover placement="bottom-end" width="360" trigger="click">
            <template #reference>
              <el-badge :is-dot="kernelNeedsAttention" type="warning">
                <el-button size="small">{{ kernelChipText }}</el-button>
              </el-badge>
            </template>
            <div class="kernel-pop">
              <div class="kp-row kp-title">指纹内核（仅「指纹内核」承载需要）</div>
              <div v-if="kernel?.ready" class="kp-row">
                已就绪：<b>{{ kernel.version }}</b>
                <el-tag size="small" effect="plain" style="margin-left: 6px">
                  {{ kernel.source === 'local' ? '本地导入' : '官方下载' }}
                </el-tag>
              </div>
              <div v-else-if="kernelMsg" class="kp-row kp-msg">{{ kernelMsg }}</div>
              <div v-else class="kp-row kp-msg">尚未就绪。标准浏览器 / 内置轻量模式无需下载。</div>
              <template v-if="kernel?.progress?.status === 'downloading' || kernel?.progress?.status === 'extracting'">
                <el-progress
                  :percentage="kernel.progress?.percent ?? 0"
                  :indeterminate="kernel.progress?.status === 'extracting'"
                  :duration="2"
                  style="margin: 8px 0"
                />
                <div class="kp-row kp-dim">
                  {{ kernel.progress?.status === 'extracting' ? '解压中，请稍候…' : kernel.progress?.message || '下载中…' }}
                </div>
              </template>
              <div class="kp-actions">
                <el-button size="small" type="primary" :loading="kernelBusy" :disabled="kernelDownloading" @click="downloadKernel">
                  {{ kernel?.ready ? '重新下载' : '下载内核' }}
                </el-button>
                <el-button size="small" :disabled="kernelBusy || kernelDownloading" @click="importKernel">本地导入</el-button>
              </div>
            </div>
          </el-popover>
        </div>
      </div>

      <el-table :data="state.envs" v-loading="loading">
        <template #empty>
          <el-empty description="还没有环境">
            <div class="empty-guide">
              三步开始：① 新建环境 → ② 打开并登录目标网站 → ③ 点「保存为基线」。<br />
              之后换设备打开同一环境，登录态自动恢复。
            </div>
            <el-button type="primary" @click="showCreate = true">新建第一个环境</el-button>
          </el-empty>
        </template>
        <el-table-column label="环境" min-width="200">
          <template #default="{ row }">
            <div class="env-name">
              <b>{{ row.env.name }}</b>
              <el-tag size="small" :type="hostingTagType(row.env.hosting)" effect="plain">
                {{ hostingText(row.env.hosting) }}
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
              <span>{{ fmtTimeShort(row.baseCreatedAt) }}</span>
              <el-tag v-if="row.env.hosting === 'kernel'" size="small" type="warning" style="margin-left: 6px">文件级 L2</el-tag>
              <el-tag v-else size="small" type="info" style="margin-left: 6px">结构化 L1</el-tag>
            </template>
            <span v-else class="dim">无（首次保存后生成）</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="200">
          <template #default="{ row }">
            <el-tag v-if="row.phase === 'running'" type="success" size="small">运行中</el-tag>
            <el-tag v-else-if="row.phase === 'idle'" size="small" type="info">空闲</el-tag>
            <el-tag v-else size="small" type="warning">{{ phaseText(row.phase) }}</el-tag>
            <div v-if="row.message" class="env-meta">{{ row.message }}</div>
            <div v-if="row.leaseHolder && row.phase === 'idle'" class="env-meta">
              🔒 {{ row.leaseHolder === state.account.deviceId ? '上次会话未正常释放，打开即可接管' : `被设备 ${row.leaseHolder.slice(0, 8)} 占用` }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <template v-if="row.phase === 'idle' || row.phase === ''">
              <el-button size="small" type="primary" :disabled="busy(row.env.id)" @click="open(row.env.id)">
                {{ row.env.mode === 'exclusive' ? '打开 / 接管' : '打开' }}
              </el-button>
              <el-button size="small" text type="primary" @click="openDetail(row)">详情</el-button>
              <el-button size="small" text @click="edit(row)">编辑</el-button>
              <el-popconfirm
                title="删除后云端环境与基线一并删除，不可恢复。确定？"
                width="260"
                @confirm="del(row.env.id)"
              >
                <template #reference>
                  <el-button size="small" text type="danger">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
            <template v-else-if="row.phase === 'running'">
              <el-button size="small" type="primary" plain :disabled="busy(row.env.id)" @click="saveBase(row.env.id)">
                保存为基线
              </el-button>
              <el-button size="small" type="warning" plain :disabled="busy(row.env.id)" @click="close(row)">
                {{ row.env.mode === 'exclusive' ? '保存并关闭' : '关闭' }}
              </el-button>
            </template>
            <template v-else>
              <el-button size="small" disabled>处理中…</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </main>

    <!-- 环境详情抽屉：实时跟随 state 更新 -->
    <el-drawer v-model="showDetail" :title="detailRow ? `环境详情 · ${detailRow.env.name}` : '环境详情'" size="440">
      <template v-if="detailRow">
        <div class="detail-sec">
          <div class="ds-title">基本信息</div>
          <div class="ds-row"><span class="ds-label">模式</span><span>{{ detailRow.env.mode === 'snapshot' ? '快照分支（关闭即弃，保存为基线固化）' : '互斥接管（关闭自动保存）' }}</span></div>
          <div class="ds-row"><span class="ds-label">承载</span><span>{{ hostingText(detailRow.env.hosting) }}</span></div>
          <div class="ds-row"><span class="ds-label">主页</span><span class="ds-mono">{{ detailRow.env.homepage || '—' }}</span></div>
        </div>
        <div v-if="detailRow.env.hosting === 'kernel'" class="detail-sec">
          <div class="ds-title">指纹配置<span class="ds-hint">（实际值在打开时按代理 geo 解析）</span></div>
          <div class="ds-row">
            <span class="ds-label">种子</span>
            <span class="ds-mono">{{ detailRow.env.seed }}</span>
            <el-button size="small" text type="primary" @click="copySeed(detailRow.env.seed)">复制</el-button>
          </div>
          <div class="ds-row"><span class="ds-label">平台</span><span>{{ detailRow.env.fingerprint?.platform || '跟随内核默认' }}</span></div>
          <div class="ds-row">
            <span class="ds-label">时区</span>
            <span>{{ fpItemText(detailRow.env.fingerprint?.timezoneMode, detailRow.env.fingerprint?.timezone) }}</span>
          </div>
          <div class="ds-row">
            <span class="ds-label">语言</span>
            <span>{{ fpItemText(detailRow.env.fingerprint?.langMode, detailRow.env.fingerprint?.lang) }}</span>
          </div>
        </div>
        <div class="detail-sec">
          <div class="ds-title">网络</div>
          <div class="ds-row">
            <span class="ds-label">代理</span>
            <span>
              <template v-if="detailRow.env.proxy">
                <span class="ds-mono">{{ detailRow.env.proxy.scheme }}://{{ detailRow.env.proxy.host }}:{{ detailRow.env.proxy.port }}</span>
                <el-tag v-if="detailRow.env.proxy.username" size="small" effect="plain" style="margin-left: 6px">带认证</el-tag>
              </template>
              <span v-else class="dim">直连</span>
            </span>
          </div>
        </div>
        <div class="detail-sec">
          <div class="ds-title">云端数据</div>
          <div class="ds-row">
            <span class="ds-label">基线</span>
            <span>
              <template v-if="detailRow.hasBase">
                {{ fmtTimeFull(detailRow.baseCreatedAt) }}
                <el-tag size="small" :type="detailRow.env.hosting === 'kernel' ? 'warning' : 'info'" style="margin-left: 6px">
                  {{ detailRow.env.hosting === 'kernel' ? 'L2 文件级' : 'L1 结构化' }}
                </el-tag>
              </template>
              <span v-else class="dim">尚未保存基线</span>
            </span>
          </div>
          <div v-if="detailRow.leaseHolder && detailRow.phase === 'idle'" class="ds-row">
            <span class="ds-label">占用</span>
            <span>{{ detailRow.leaseHolder === state.account.deviceId ? '本机上次会话（未正常释放）' : `设备 ${detailRow.leaseHolder.slice(0, 8)}` }}</span>
          </div>
          <div class="ds-row"><span class="ds-label">创建</span><span>{{ fmtTimeFull(detailRow.env.createdAt) }}</span></div>
          <div class="ds-row"><span class="ds-label">更新</span><span>{{ fmtTimeFull(detailRow.env.updatedAt) }}</span></div>
        </div>
        <div v-if="detailRow.env.sessionCheck" class="detail-sec">
          <div class="ds-title">会话检测</div>
          <div class="ds-row"><span class="ds-label">路径</span><span class="ds-mono">{{ detailRow.env.sessionCheck.urlPath }}</span></div>
          <div class="ds-row"><span class="ds-label">标记</span><span class="ds-mono">{{ detailRow.env.sessionCheck.loggedInMarker }}</span></div>
        </div>
        <div class="detail-actions">
          <el-button v-if="detailRow.phase === 'idle'" type="primary" @click="open(detailRow.env.id)">打开环境</el-button>
          <el-button @click="edit(detailRow); showDetail = false">编辑</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="showCreate" title="新建环境" width="560" top="6vh">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="例如：我的 B 站号" @keyup.enter="create" />
        </el-form-item>
        <el-form-item label="模式">
          <div class="radio-cards">
            <div
              v-for="opt in MODE_OPTS"
              :key="opt.value"
              :class="['radio-card', form.mode === opt.value ? 'active' : '']"
              @click="form.mode = opt.value"
            >
              <div class="rc-title">{{ opt.title }}</div>
              <div class="rc-desc">{{ opt.desc }}</div>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="承载">
          <div class="radio-cards">
            <div
              v-for="opt in HOSTING_OPTS"
              :key="opt.value"
              :class="['radio-card', form.hosting === opt.value ? 'active' : '']"
              @click="form.hosting = opt.value"
            >
              <div class="rc-title">
                {{ opt.title }}
                <el-tag v-if="opt.tag" size="small" type="success" effect="plain" style="margin-left: 4px">{{ opt.tag }}</el-tag>
              </div>
              <div class="rc-desc">{{ opt.desc }}</div>
            </div>
          </div>
        </el-form-item>
        <template v-if="form.hosting === 'kernel'">
          <el-form-item label="指纹平台">
            <div class="inline-row">
              <el-select v-model="form.fpPlatform" style="width: 200px">
                <el-option value="Windows" label="Windows" />
                <el-option value="macOS" label="macOS" />
                <el-option value="Linux" label="Linux" />
              </el-select>
              <span class="hint">其余指纹项（UA/显卡/字体等）由种子驱动</span>
            </div>
          </el-form-item>
          <el-form-item label="时区">
            <div class="inline-row">
              <el-select v-model="form.fpTzMode" style="width: 130px">
                <el-option value="seed" label="跟随种子" />
                <el-option value="auto" label="按代理 IP" />
                <el-option value="manual" label="手动" />
              </el-select>
              <el-input
                v-if="form.fpTzMode === 'manual'"
                v-model="form.fpTimezone"
                placeholder="Asia/Shanghai"
                style="width: 220px"
              />
            </div>
          </el-form-item>
          <el-form-item label="语言">
            <div class="inline-row">
              <el-select v-model="form.fpLangMode" style="width: 130px">
                <el-option value="seed" label="跟随种子" />
                <el-option value="auto" label="按代理 IP" />
                <el-option value="manual" label="手动" />
              </el-select>
              <el-input v-if="form.fpLangMode === 'manual'" v-model="form.fpLang" placeholder="zh-CN" style="width: 220px" />
            </div>
          </el-form-item>
        </template>
        <el-form-item label="主页">
          <el-input v-model="form.homepage" placeholder="http://127.0.0.1:18080" />
        </el-form-item>
        <el-collapse class="adv-collapse">
          <el-collapse-item title="高级选项（代理、指纹种子）">
            <el-form-item label="指纹种子">
              <div class="inline-row">
                <el-input v-model="form.seed" placeholder="留空随机生成" style="width: 220px" />
                <span class="hint">1 ~ 2147483647 的整数；相同种子 = 相同指纹（跨设备一致）</span>
              </div>
            </el-form-item>
            <el-form-item label="代理">
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
          </el-collapse-item>
        </el-collapse>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showEdit" title="编辑环境" width="560" top="6vh">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="主页">
          <el-input v-model="editForm.homepage" />
        </el-form-item>
        <el-form-item label="承载">
          <div class="radio-cards">
            <div
              v-for="opt in HOSTING_OPTS"
              :key="opt.value"
              :class="['radio-card', editForm.hosting === opt.value ? 'active' : '']"
              @click="editForm.hosting = opt.value"
            >
              <div class="rc-title">{{ opt.title }}</div>
              <div class="rc-desc">{{ opt.desc }}</div>
            </div>
          </div>
          <div class="hint">切换承载不影响云端基线；本地浏览数据各承载独立，均随关闭丢弃。下次打开生效。</div>
        </el-form-item>
        <template v-if="editForm.hosting === 'kernel'">
          <el-form-item label="指纹平台">
            <el-select v-model="editForm.fpPlatform" style="width: 200px">
              <el-option value="Windows" label="Windows" />
              <el-option value="macOS" label="macOS" />
              <el-option value="Linux" label="Linux" />
            </el-select>
          </el-form-item>
          <el-form-item label="时区">
            <div class="inline-row">
              <el-select v-model="editForm.fpTzMode" style="width: 130px">
                <el-option value="seed" label="跟随种子" />
                <el-option value="auto" label="按代理 IP" />
                <el-option value="manual" label="手动" />
              </el-select>
              <el-input
                v-if="editForm.fpTzMode === 'manual'"
                v-model="editForm.fpTimezone"
                placeholder="Asia/Shanghai"
                style="width: 220px"
              />
            </div>
          </el-form-item>
          <el-form-item label="语言">
            <div class="inline-row">
              <el-select v-model="editForm.fpLangMode" style="width: 130px">
                <el-option value="seed" label="跟随种子" />
                <el-option value="auto" label="按代理 IP" />
                <el-option value="manual" label="手动" />
              </el-select>
              <el-input v-if="editForm.fpLangMode === 'manual'" v-model="editForm.fpLang" placeholder="zh-CN" style="width: 220px" />
            </div>
          </el-form-item>
          <el-form-item label="指纹种子">
            <div class="inline-row">
              <el-input v-model="editForm.seed" style="width: 220px" />
              <span class="hint">更改后下次打开使用新指纹身份（云端基线的登录态不受影响）</span>
            </div>
          </el-form-item>
        </template>
        <el-collapse class="adv-collapse">
          <el-collapse-item title="高级选项（代理、会话检测）">
            <el-form-item label="代理">
              <div class="proxy-row">
                <el-select v-model="editProxy.scheme" style="width: 90px">
                  <el-option value="http" label="http" />
                  <el-option value="socks5" label="socks5" />
                </el-select>
                <el-input v-model="editProxy.host" placeholder="留空 = 直连（清除代理）" style="flex: 1" />
                <el-input-number v-model="editProxy.port" :min="1" :max="65535" placeholder="端口" style="width: 110px" />
              </div>
              <div class="proxy-row" style="margin-top: 6px">
                <el-input v-model="editProxy.username" placeholder="用户名（可选）" style="flex: 1" />
                <el-input v-model="editProxy.password" type="password" placeholder="密码（可选）" style="flex: 1" />
              </div>
            </el-form-item>
            <el-form-item label="会话检测">
              <div class="proxy-row">
                <el-input v-model="editForm.scPath" placeholder="检测路径，如 /api/whoami" style="flex: 1" />
              </div>
              <div class="proxy-row" style="margin-top: 6px">
                <el-input v-model="editForm.scMarker" placeholder="登录标记，响应体包含即视为有效" style="flex: 1" />
              </div>
              <div class="hint">打开环境恢复登录态后探测；失效则提示重新登录并更新基线。两项留空 = 关闭检测</div>
            </el-form-item>
          </el-collapse-item>
        </el-collapse>
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
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import type { AppState, EnvMode, EnvView, Hosting, KernelStatus, ProxyConfig } from '@shared/types'
import { ob } from '../api'
import { errMsg, fmtTimeFull, fmtTimeShort } from '../fmt'

const props = defineProps<{ state: AppState }>()
const emit = defineEmits<{ refresh: [] }>()

const kernel = inject<Ref<KernelStatus | null>>('kernelStatus', ref(null))
const kernelBusy = ref(false)
const appVersion = ref('')
ob.appInfo().then((i) => (appVersion.value = i.version)).catch(() => undefined)

const loading = ref(false)
const creating = ref(false)
const showCreate = ref(false)
const showEdit = ref(false)
const showDetail = ref(false)
const detailId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const busyMap = reactive<Record<string, boolean>>({})

const MODE_OPTS: Array<{ value: EnvMode; title: string; desc: string }> = [
  { value: 'snapshot', title: '快照分支', desc: '打开 = 克隆云端基线，关闭即弃；点「保存为基线」固化改动' },
  { value: 'exclusive', title: '互斥接管', desc: '同一时刻仅一台设备可用；关闭自动保存，他设备打开会接管' }
]
const HOSTING_OPTS: Array<{ value: Hosting; title: string; desc: string; tag?: string }> = [
  { value: 'kernel', title: '指纹内核', desc: '每环境独立指纹防关联；首次需下载内核', tag: '推荐' },
  { value: 'browser', title: '标准浏览器', desc: '本机 Edge/Chrome 隔离窗口，无指纹、免下载' },
  { value: 'builtin', title: '内置轻量', desc: 'Electron 内置窗口，无指纹、秒开' }
]

const form = reactive<{
  name: string
  mode: EnvMode
  hosting: Hosting
  homepage: string
  seed: string
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
  seed: '',
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
const editForm = reactive({
  name: '',
  homepage: '',
  hosting: 'kernel' as Hosting,
  seed: '',
  fpPlatform: 'Windows',
  fpTzMode: 'seed' as 'seed' | 'auto' | 'manual',
  fpTimezone: '',
  fpLangMode: 'seed' as 'seed' | 'auto' | 'manual',
  fpLang: '',
  scPath: '',
  scMarker: ''
})
const editProxy = reactive<Required<Pick<ProxyConfig, 'scheme' | 'host' | 'port'>> & Partial<ProxyConfig>>({
  scheme: 'http',
  host: '',
  port: 1080,
  username: '',
  password: ''
})

const runningCount = computed(() => props.state.envs.filter((v) => v.phase === 'running').length)
const detailRow = computed(() => props.state.envs.find((v) => v.env.id === detailId.value) || null)

const kernelDownloading = computed(() => kernel.value?.progress?.status === 'downloading' || kernel.value?.progress?.status === 'extracting')
const kernelNeedsAttention = computed(() => {
  const k = kernel.value
  return !!(k && !k.ready && !k.progress && props.state.envs.some((v) => v.env.hosting === 'kernel'))
})
const kernelMsg = computed(() => {
  const k = kernel.value
  if (!k || k.ready) return ''
  return k.message || (k.progress?.message ?? '')
})
const kernelChipText = computed(() => {
  const k = kernel.value
  if (!k) return '内核…'
  if (k.progress?.status === 'downloading') return `内核下载 ${k.progress.percent ?? 0}%`
  if (k.progress?.status === 'extracting') return '内核解压中…'
  if (k.ready) return `内核 v${k.version || '?'}`
  return '内核未就绪'
})

function busy(id: string): boolean {
  return !!busyMap[id]
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    ElNotification.error({ title: '操作失败', message: errMsg(e) })
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  await guard(() => ob.sync()) // 真正从云端拉取并推送状态
  loading.value = false
  emit('refresh')
}

async function logout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定登出当前账号？云端数据不受影响，重新登录即可恢复。', '登出', {
      type: 'warning',
      confirmButtonText: '登出',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await guard(() => ob.logout())
  emit('refresh')
}

async function create(): Promise<void> {
  if (!form.name.trim()) {
    ElNotification.warning({ title: '请填写环境名称' })
    return
  }
  if (form.seed && !/^\d{1,10}$/.test(form.seed.trim())) {
    ElNotification.warning({ title: '指纹种子必须是整数（1 ~ 2147483647）' })
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
      name: form.name.trim(),
      mode: form.mode,
      hosting: form.hosting,
      homepage: form.homepage,
      proxy: p,
      ...(form.hosting === 'kernel' && form.seed.trim() ? { seed: form.seed.trim() } : {}),
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
    form.seed = '' // 防止连续创建误用同一种子（= 同一指纹身份）
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

function openDetail(row: EnvView): void {
  detailId.value = row.env.id
  showDetail.value = true
}

function edit(row: EnvView): void {
  const env = row.env
  editingId.value = env.id
  editForm.name = env.name
  editForm.homepage = env.homepage
  editForm.hosting = env.hosting
  editForm.seed = env.seed || ''
  editForm.fpPlatform = env.fingerprint?.platform || 'Windows'
  editForm.fpTzMode = env.fingerprint?.timezoneMode ?? (env.fingerprint?.timezone ? 'manual' : 'seed')
  editForm.fpTimezone = env.fingerprint?.timezone || ''
  editForm.fpLangMode = env.fingerprint?.langMode ?? (env.fingerprint?.lang ? 'manual' : 'seed')
  editForm.fpLang = env.fingerprint?.lang || ''
  editForm.scPath = env.sessionCheck?.urlPath || ''
  editForm.scMarker = env.sessionCheck?.loggedInMarker || ''
  editProxy.scheme = env.proxy?.scheme === 'socks5' ? 'socks5' : 'http'
  editProxy.host = env.proxy?.host || ''
  editProxy.port = env.proxy?.port || 1080
  editProxy.username = env.proxy?.username || ''
  editProxy.password = env.proxy?.password || ''
  showEdit.value = true
}

async function saveEdit(): Promise<void> {
  if (!editingId.value) return
  if (editForm.seed && !/^\d{1,10}$/.test(editForm.seed.trim())) {
    ElNotification.warning({ title: '指纹种子必须是整数（1 ~ 2147483647）' })
    return
  }
  creating.value = true
  await guard(async () => {
    const id = editingId.value!
    const sessionCheck =
      editForm.scPath.trim() && editForm.scMarker.trim()
        ? { urlPath: editForm.scPath.trim(), loggedInMarker: editForm.scMarker.trim() }
        : null // 留空 = 清除检测
    const hadProxy = !!props.state.envs.find((v) => v.env.id === id)?.env.proxy
    const newProxy: ProxyConfig | null = editProxy.host
      ? {
          scheme: editProxy.scheme,
          host: editProxy.host.trim(),
          port: editProxy.port,
          ...(editProxy.username ? { username: editProxy.username } : {}),
          ...(editProxy.password ? { password: editProxy.password } : {})
        }
      : hadProxy
        ? null // 原 有代理 → 现清空 host = 清除代理
        : undefined
    const cur = props.state.envs.find((v) => v.env.id === id)?.env
    await ob.updateEnv(id, {
      name: editForm.name.trim(),
      homepage: editForm.homepage,
      hosting: editForm.hosting,
      ...(editForm.hosting === 'kernel'
        ? {
            fingerprint: {
              platform: editForm.fpPlatform || undefined,
              timezoneMode: editForm.fpTzMode,
              ...(editForm.fpTzMode === 'manual' && editForm.fpTimezone ? { timezone: editForm.fpTimezone.trim() } : {}),
              langMode: editForm.fpLangMode,
              ...(editForm.fpLangMode === 'manual' && editForm.fpLang ? { lang: editForm.fpLang.trim() } : {})
            },
            ...(editForm.seed.trim() !== (cur?.seed || '') ? { seed: editForm.seed.trim() } : {})
          }
        : {}),
      proxy: newProxy,
      sessionCheck
    })
    showEdit.value = false
  })
  creating.value = false
}

async function open(id: string): Promise<void> {
  busyMap[id] = true
  await guard(() => ob.openEnv(id))
  busyMap[id] = false
}

async function close(row: EnvView): Promise<void> {
  if (row.env.mode === 'snapshot') {
    try {
      await ElMessageBox.confirm(
        '该环境为快照分支模式：关闭将丢弃本次会话的全部改动，云端基线不变。如需保留，请先点「保存为基线」。',
        `丢弃改动并关闭「${row.env.name}」？`,
        { type: 'warning', confirmButtonText: '丢弃并关闭', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }
  busyMap[row.env.id] = true
  const discard = row.env.mode === 'snapshot'
  await guard(() => ob.closeEnv(row.env.id))
  busyMap[row.env.id] = false
  if (discard) ElMessage.info('已关闭（改动未保存，云端基线不变）')
}

async function saveBase(id: string): Promise<void> {
  busyMap[id] = true
  await guard(() => ob.saveBase(id)) // 成功通知由主进程统一推送
  busyMap[id] = false
}

async function del(id: string): Promise<void> {
  busyMap[id] = true
  await guard(() => ob.deleteEnv(id))
  busyMap[id] = false
}

async function copySeed(seed: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(seed)
    ElMessage.success('种子已复制')
  } catch {
    ElNotification.warning({ title: '复制失败', message: '请手动选中复制' })
  }
}

function hostingText(h: Hosting): string {
  return h === 'kernel' ? '指纹内核' : h === 'browser' ? '标准浏览器' : '内置'
}
function hostingTagType(h: Hosting): 'primary' | 'info' | 'success' {
  return h === 'kernel' ? 'primary' : h === 'browser' ? 'success' : 'info'
}
function fpItemText(mode?: string, value?: string): string {
  if (mode === 'manual' && value) return value
  if (mode === 'auto') return '按代理 IP 自动'
  return '跟随种子'
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
  align-items: baseline;
  gap: 10px;
}
.title h1 {
  font-size: 18px;
  margin: 0;
}
.ver {
  font-size: 12px;
  color: #b0b9c6;
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
.stats {
  font-size: 12px;
  color: #8492a6;
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
  line-height: 1.6;
}
.inline-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
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
/* 模式/承载说明卡片 */
.radio-cards {
  display: grid;
  gap: 8px;
  width: 100%;
}
.radio-card {
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.radio-card:hover {
  border-color: #a0cfff;
}
.radio-card.active {
  border-color: #409eff;
  background: #ecf5ff;
}
.rc-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  display: flex;
  align-items: center;
}
.rc-desc {
  font-size: 12px;
  color: #8492a6;
  margin-top: 3px;
  line-height: 1.5;
}
.adv-collapse {
  border-top: none;
  margin-top: 2px;
}
.adv-collapse :deep(.el-collapse-item__header) {
  font-weight: 600;
  color: #606266;
}
/* 内核 popover */
.kernel-pop .kp-row {
  font-size: 13px;
  color: #606266;
  margin-bottom: 6px;
}
.kernel-pop .kp-title {
  font-weight: 600;
  color: #303133;
}
.kernel-pop .kp-msg {
  color: #8492a6;
}
.kernel-pop .kp-dim {
  font-size: 12px;
  color: #8492a6;
}
.kernel-pop .kp-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
/* 帮助 popover */
.help-pop p {
  margin: 4px 0;
  font-size: 12px;
  color: #606266;
  line-height: 1.6;
}
.help-pop .hp-sec {
  margin-bottom: 10px;
}
.help-pop .hp-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.help-pop .hp-dim {
  font-size: 12px;
  color: #a8abb2;
}
/* 空状态 */
.empty-guide {
  font-size: 13px;
  color: #8492a6;
  line-height: 1.8;
  margin-bottom: 14px;
}
/* 详情抽屉 */
.detail-sec {
  margin-bottom: 18px;
}
.ds-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #f0f2f5;
}
.ds-hint {
  font-weight: normal;
  font-size: 12px;
  color: #a8abb2;
}
.ds-row {
  display: flex;
  align-items: center;
  font-size: 13px;
  color: #606266;
  margin-bottom: 6px;
}
.ds-label {
  width: 64px;
  flex: none;
  color: #909399;
  font-size: 12px;
}
.ds-mono {
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}
.detail-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}
</style>
