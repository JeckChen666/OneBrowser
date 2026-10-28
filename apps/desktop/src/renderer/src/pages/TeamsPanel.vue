<template>
  <div class="teams-panel">
    <!-- 待接受邀请 -->
    <div v-if="pendingTeams.length" class="invite-bar">
      <span>📨 你有 {{ pendingTeams.length }} 个团队邀请待处理：</span>
      <span v-for="t in pendingTeams" :key="t.id" class="invite-item">
        <b>{{ t.name }}</b>（发起人 {{ t.ownerEmail }}）
        <el-button size="small" type="primary" @click="accept(t.id)">接受</el-button>
        <el-button size="small" @click="decline(t.id)">拒绝</el-button>
      </span>
    </div>

    <div class="toolbar">
      <el-input v-model="newName" placeholder="新团队名称" style="width: 240px" @keyup.enter="create" />
      <el-button type="primary" :loading="creating" :disabled="!newName.trim()" @click="create">＋ 创建团队</el-button>
      <span class="hint">团队环境的配置与登录态用团队密钥端到端加密，仅成员可解</span>
      <el-button size="small" style="margin-left: auto" @click="reload">刷新</el-button>
    </div>

    <el-empty v-if="!teams.length" description="还没有团队：创建一个，邀请成员，即可共享指纹环境" />

    <div class="team-cards">
      <div v-for="t in activeTeams" :key="t.id" class="team-card">
        <div class="tc-head">
          <b class="tc-name">{{ t.name }}</b>
          <el-tag size="small" :type="t.role === 'owner' ? 'danger' : t.role === 'admin' ? 'warning' : 'info'">
            {{ t.role === 'owner' ? 'owner' : t.role === 'admin' ? '管理员' : '成员' }}
          </el-tag>
          <span class="tc-meta">{{ t.memberCount }} 名成员 · 发起人 {{ t.ownerEmail }}</span>
          <div class="tc-actions">
            <el-button v-if="t.role !== 'member'" size="small" @click="openMembers(t)">成员管理</el-button>
            <el-button v-if="t.role === 'owner'" size="small" text type="warning" @click="rotate(t)">轮换密钥</el-button>
          </div>
        </div>
        <div class="tc-desc hint">
          在「环境」页新建环境时选择本团队，成员即可免登录共享其登录态；吊销成员会立即切断其云端访问
        </div>
      </div>
    </div>

    <!-- 成员管理 -->
    <el-dialog v-model="showMembers" :title="`成员管理 · ${curTeam?.name || ''}`" width="640">
      <div class="invite-row">
        <el-input v-model="inviteEmail" placeholder="成员邮箱（须已注册并登录过新版客户端）" style="flex: 1" />
        <el-select v-model="inviteRole" style="width: 110px">
          <el-option value="member" label="成员" />
          <el-option value="admin" label="管理员" />
        </el-select>
        <el-button type="primary" :loading="inviting" :disabled="!inviteEmail.trim()" @click="invite">邀请</el-button>
      </div>
      <el-table :data="members" v-loading="membersLoading" size="small">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }">
            <span>{{ row.email }}</span>
            <el-tag size="small" style="margin-left: 6px" :type="row.role === 'owner' ? 'danger' : row.role === 'admin' ? 'warning' : 'info'">
              {{ row.role }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.state === 'active' ? 'success' : 'warning'">
              {{ row.state === 'active' ? '已加入' : '待接受' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加入时间" width="150">
          <template #default="{ row }">{{ fmtTimeShort(row.joinedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-popconfirm v-if="row.role !== 'owner'" title="移出后其云端访问立即断开。确定？" @confirm="revoke(row.userId)">
              <template #reference>
                <el-button size="small" text type="danger">移出</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint" style="margin-top: 8px">
        被移出的成员将立即无法访问团队环境与云端基线；其成员期内已获取的本地数据无法远程清除（端到端加密的固有性质）
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import type { TeamInfo, TeamMember } from '@shared/types'
import { ob } from '../api'
import { errMsg, fmtTimeShort } from '../fmt'

const emit = defineEmits<{ changed: [] }>() // 团队变化 → 环境列表可能变化

const teams = ref<TeamInfo[]>([])
const newName = ref('')
const creating = ref(false)
const loading = ref(false)

const pendingTeams = computed(() => teams.value.filter((t) => t.state === 'pending'))
const activeTeams = computed(() => teams.value.filter((t) => t.state === 'active'))

async function reload(): Promise<void> {
  loading.value = true
  try {
    teams.value = await ob.teams()
  } catch (e) {
    ElNotification.error({ title: '团队列表获取失败', message: errMsg(e) })
  } finally {
    loading.value = false
  }
}
onMounted(reload)

async function create(): Promise<void> {
  creating.value = true
  try {
    await ob.teamCreate(newName.value.trim())
    newName.value = ''
    await reload()
    emit('changed')
  } catch (e) {
    ElNotification.error({ title: '创建失败', message: errMsg(e) })
  } finally {
    creating.value = false
  }
}

async function accept(teamId: string): Promise<void> {
  try {
    await ob.teamAccept(teamId)
    ElMessage.success('已加入团队')
    await reload()
    emit('changed')
  } catch (e) {
    ElNotification.error({ title: '接受邀请失败', message: errMsg(e) })
  }
}

async function decline(teamId: string): Promise<void> {
  try {
    await ob.teamDecline(teamId)
    await reload()
  } catch (e) {
    ElNotification.error({ title: '拒绝失败', message: errMsg(e) })
  }
}

// --- 成员管理 ---
const showMembers = ref(false)
const curTeam = ref<TeamInfo | null>(null)
const members = ref<TeamMember[]>([])
const membersLoading = ref(false)
const inviteEmail = ref('')
const inviteRole = ref<'admin' | 'member'>('member')
const inviting = ref(false)

async function openMembers(t: TeamInfo): Promise<void> {
  curTeam.value = t
  showMembers.value = true
  membersLoading.value = true
  try {
    members.value = await ob.teamMembers(t.id)
  } catch (e) {
    ElNotification.error({ title: '成员列表获取失败', message: errMsg(e) })
  } finally {
    membersLoading.value = false
  }
}

async function invite(): Promise<void> {
  if (!curTeam.value) return
  inviting.value = true
  try {
    await ob.teamInvite(curTeam.value.id, inviteEmail.value.trim(), inviteRole.value)
    inviteEmail.value = ''
    members.value = await ob.teamMembers(curTeam.value.id)
    await reload()
  } catch (e) {
    ElNotification.error({ title: '邀请失败', message: errMsg(e) })
  } finally {
    inviting.value = false
  }
}

async function revoke(userId: string): Promise<void> {
  if (!curTeam.value) return
  try {
    await ob.teamRevoke(curTeam.value.id, userId)
    members.value = await ob.teamMembers(curTeam.value.id)
    await reload()
  } catch (e) {
    ElNotification.error({ title: '移出失败', message: errMsg(e) })
  }
}

async function rotate(t: TeamInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '轮换后团队的新快照立即使用新密钥。请确保在线成员刷新后能解封新密钥。确定轮换？',
      `轮换「${t.name}」的团队密钥`,
      { type: 'warning', confirmButtonText: '轮换', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await ob.teamRotate(t.id)
    ElMessage.success('已轮换')
  } catch (e) {
    ElNotification.error({ title: '轮换失败', message: errMsg(e) })
  }
}
</script>

<style scoped>
.invite-bar {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 8px;
  padding: 10px 16px;
  margin-bottom: 14px;
  font-size: 13px;
  color: #b88230;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.invite-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
}
.hint {
  font-size: 12px;
  color: #8492a6;
}
.team-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}
.team-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 14px 18px;
}
.tc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tc-name {
  font-size: 15px;
}
.tc-meta {
  font-size: 12px;
  color: #909399;
}
.tc-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.tc-desc {
  margin-top: 8px;
  line-height: 1.6;
}
.invite-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
