// functions/_shared/admin-bootstrap.js
import {
  delSessionsForUser,
  genToken,
  hashPw,
  rotatePasswordAndRevokeSessions,
  bumpSessionEpoch,
  validatePassword,
  verifyPw,
} from './auth.js'

export const BOOTSTRAP_KEY = 'auth:bootstrap:v2'
export const LEGACY_BOOTSTRAP_KEY = 'auth:has_default_admin'

const bootstrapInFlight = new WeakMap()
const bootstrapReady = new WeakMap()
const registrationInFlight = new WeakMap()

export class BootstrapError extends Error {
  constructor(message, status = 503) {
    super(message)
    this.name = 'BootstrapError'
    this.status = status
  }
}

function nowIso() { return new Date().toISOString() }

function readEnv(env, key) {
  if (env && Object.prototype.hasOwnProperty.call(env, key)) {
    const value = env[key]
    return value == null ? undefined : String(value)
  }
  try {
    if (typeof process !== 'undefined' && process?.env && Object.prototype.hasOwnProperty.call(process.env, key)) {
      return process.env[key]
    }
  } catch { /* Workers without process */ }
  return undefined
}

function getAdminEnv(env) {
  const rawUsername = readEnv(env, 'ADMIN_USERNAME')
  const rawPassword = readEnv(env, 'ADMIN_PASSWORD')
  const username = String(rawUsername || 'admin').trim() || 'admin'
  return { username, password: rawPassword, hasPassword: rawPassword !== undefined }
}

function assertValidEnvPassword(password) {
  if (password !== undefined && !validatePassword(password)) {
    throw new BootstrapError('ADMIN_PASSWORD 不符合策略（≥10 位，含字母与数字，非常见弱口令），拒绝初始化')
  }
}

let _cachedBootstrap = null
let _cachedBootstrapAt = 0
const BOOTSTRAP_CACHE_TTL = 30000

async function readBootstrap(kv) {
  if (_cachedBootstrap && Date.now() - _cachedBootstrapAt < BOOTSTRAP_CACHE_TTL) {
    return _cachedBootstrap
  }
  const raw = await kv.get(BOOTSTRAP_KEY)
  if (!raw) {
    _cachedBootstrap = null
    _cachedBootstrapAt = Date.now()
    return null
  }
  try {
    const record = JSON.parse(raw)
    if (record?.version === 2 && typeof record.state === 'string') {
      _cachedBootstrap = record
      _cachedBootstrapAt = Date.now()
      return record
    }
  } catch { /* noop */ }
  throw new BootstrapError('初始管理员状态损坏，请检查 KV 中的 auth:bootstrap:v2')
}

async function writeBootstrap(kv, record) {
  const next = { ...record, version: 2, updatedAt: nowIso() }
  await kv.put(BOOTSTRAP_KEY, JSON.stringify(next))
  _cachedBootstrap = next
  _cachedBootstrapAt = Date.now()
  return next
}

async function getWebUsers(db) {
  if (typeof db.getAllWebUsersRaw === 'function') return db.getAllWebUsersRaw()
  return []
}

async function findLegacyDefaultAdmin(db, envUsername) {
  const users = await getWebUsers(db)
  if (users.length === 0) return null
  if (users.length === 1) return users[0]

  const candidates = []
  if (envUsername) candidates.push(envUsername)
  candidates.push('admin')

  for (const username of candidates) {
    const user = await db.getWebUser(username).catch(() => null)
    if (user) return user
  }

  throw new BootstrapError('旧版默认管理员标记无法唯一匹配账号，请手动处理 auth:has_default_admin')
}

async function createBootstrapAdmin({ db, kv, env }) {
  const { username, password: envPassword, hasPassword } = getAdminEnv(env)
  assertValidEnvPassword(envPassword)

  // 未配置 ADMIN_PASSWORD 时自动生成临时密码，并在日志中明文打印一次
  const password = hasPassword ? envPassword : genToken(20)
  const user = await db.createWebUser(username, await hashPw(password), { isAdmin: true })
  const record = await writeBootstrap(kv, {
    state: 'pending',
    defaultAdminId: user.id,
    defaultAdminUsername: user.username,
    passwordSource: hasPassword ? 'env' : 'generated',
    createdAt: nowIso(),
    disabledAt: null,
    registrationUserId: null,
  })

  console.warn('='.repeat(60))
  console.warn('[SECURITY] 已创建初始管理员（首次启动）')
  console.warn(`[SECURITY] 用户名: ${user.username}`)
  if (hasPassword) {
    console.warn('[SECURITY] 密码: 使用环境变量 ADMIN_PASSWORD（已隐藏，不会明文打印）')
  } else {
    console.warn(`[SECURITY] 临时密码: ${password}`)
    console.warn('[SECURITY] 请立即登录后台完成首次注册，或修改密码。该账号会在真实注册后禁用。')
    console.warn('[SECURITY] 也可使用运维 CLI：npm run admin -- reset-password <user> --yes')
  }
  console.warn('='.repeat(60))

  return record
}

async function migrateLegacyBootstrap({ db, kv, env }) {
  const { username } = getAdminEnv(env)
  const user = await findLegacyDefaultAdmin(db, username)
  if (!user) return createBootstrapAdmin({ db, kv, env })

  const record = await writeBootstrap(kv, {
    state: 'pending',
    defaultAdminId: user.id,
    defaultAdminUsername: user.username,
    passwordSource: 'legacy',
    createdAt: user.created_at || nowIso(),
    disabledAt: null,
    registrationUserId: null,
  })
  await kv.delete(LEGACY_BOOTSTRAP_KEY).catch(() => {})
  console.warn(`[SECURITY] 已迁移旧版初始管理员标记: ${user.username}`)
  return record
}

async function ensureBootstrapRecord({ db, kv, env }) {
  const existing = await readBootstrap(kv)
  if (existing) return existing

  const legacyMarker = await kv.get(LEGACY_BOOTSTRAP_KEY).catch(() => null)
  if (legacyMarker === '1') return migrateLegacyBootstrap({ db, kv, env })

  const count = await db.webUserCount()
  if (count === 0) return createBootstrapAdmin({ db, kv, env })

  return writeBootstrap(kv, {
    state: 'closed',
    defaultAdminId: null,
    defaultAdminUsername: null,
    passwordSource: 'existing-users',
    createdAt: nowIso(),
    disabledAt: null,
    registrationUserId: null,
  })
}

async function syncPendingEnvPassword({ db, kv, env, record }) {
  if (record.state !== 'pending') return record
  const { password: envPassword, hasPassword } = getAdminEnv(env)
  if (!hasPassword) return record
  assertValidEnvPassword(envPassword)

  const user = await db.getWebUserById(record.defaultAdminId)
  if (!user) throw new BootstrapError('初始管理员账号不存在，无法同步环境密码')
  if (String(user.password_hash || '').startsWith('!!disabled:')) {
    throw new BootstrapError('初始管理员已被禁用，拒绝通过环境变量重新启用')
  }

  if (await verifyPw(envPassword, user.password_hash)) return record

  await rotatePasswordAndRevokeSessions({ db, kv, userId: user.id, newPassword: envPassword })
  const next = await writeBootstrap(kv, { ...record, passwordSource: 'env' })
  console.log(`[SECURITY] 已同步初始管理员 ${user.username} 的密码（通过环境变量 ADMIN_PASSWORD）`)
  return next
}

export async function ensureAdminInitialized({ db, kv = db?.kv, env = {} }) {
  if (!db || !kv) throw new BootstrapError('管理员初始化缺少 DB/KV 绑定')
  let record = await ensureBootstrapRecord({ db, kv, env })
  if (record.state === 'finalizing' && record.registrationUserId) {
    record = await finalizeInitialRegistration({ db, kv, registeredUserId: record.registrationUserId })
  }
  return syncPendingEnvPassword({ db, kv, env, record })
}

export async function ensureAdminInitializedOnce(args) {
  const kv = args?.kv || args?.db?.kv
  if (!kv) throw new BootstrapError('管理员初始化缺少 KV 绑定')
  // 仅缓存终态，pending/finalizing 需要允许后续请求继续推进（尤其是 crash 恢复）
  const ready = bootstrapReady.get(kv)
  if (ready && (ready.state === 'disabled' || ready.state === 'closed')) return ready
  const current = bootstrapInFlight.get(kv)
  if (current) return current

  const promise = ensureAdminInitialized(args)
  bootstrapInFlight.set(kv, promise)
  try {
    const result = await promise
    if (result?.state === 'disabled' || result?.state === 'closed') {
      bootstrapReady.set(kv, result)
    } else {
      bootstrapReady.delete(kv)
    }
    return result
  } finally {
    bootstrapInFlight.delete(kv)
  }
}

export async function getBootstrapStatus({ db, kv = db?.kv }) {
  const record = await readBootstrap(kv)
  if (record) return { ...record, needsRegistration: record.state === 'pending' }

  const legacyMarker = await kv.get(LEGACY_BOOTSTRAP_KEY).catch(() => null)
  if (legacyMarker === '1') return { state: 'pending', needsRegistration: true, legacy: true }

  const count = await db.webUserCount()
  return { state: count === 0 ? 'empty' : 'closed', needsRegistration: count === 0 }
}

async function disableBootstrapUser({ db, kv, userId }) {
  if (!userId) return
  const user = await db.getWebUserById(userId)
  if (!user) return
  if (!String(user.password_hash || '').startsWith('!!disabled:')) {
    await db.updateWebUserPassword(user.id, `!!disabled:${genToken(32)}`)
  }
  await bumpSessionEpoch(kv, user.id)
  await delSessionsForUser(kv, user.id)
  console.log(`[SECURITY] 初始管理员账号已禁用: ${user.username}`)
}

/**
 * 首次正式管理员注册。
 * pending 阶段允许公开注册（无需先登录初始管理员）；成功后关闭注册并禁用初始账号。
 * 仍用 registrationInFlight 串行化，防止并发抢注。
 */
export async function registerInitialAdmin({ db, kv = db?.kv, username, password, bootstrapUserId = null }) {
  if (!kv) throw new BootstrapError('管理员初始化缺少 KV 绑定')
  const current = registrationInFlight.get(kv)
  if (current) return current

  const promise = (async () => {
    const record = await ensureBootstrapRecord({ db, kv, env: {} })
    if (record.state !== 'pending') {
      throw new BootstrapError('首次注册已关闭，请重新登录', 403)
    }
    // 若调用方带了 bootstrapUserId，仍校验一致性（兼容旧客户端/会话路径）
    if (bootstrapUserId && record.defaultAdminId && bootstrapUserId !== record.defaultAdminId) {
      throw new BootstrapError('初始管理员会话无效', 403)
    }
    if (!username || !validatePassword(password)) {
      throw new BootstrapError('注册信息无效', 400)
    }
    // 不允许占用初始管理员用户名（避免与待禁用账号冲突）
    if (record.defaultAdminUsername
      && String(username).toLowerCase() === String(record.defaultAdminUsername).toLowerCase()) {
      throw new BootstrapError('用户名已被初始管理员占用，请换一个', 400)
    }
    if (await db.getWebUser(username)) {
      throw new BootstrapError('用户名已存在', 400)
    }

    const user = await db.createWebUser(username, await hashPw(password), { isAdmin: true })
    await finalizeInitialRegistrationInternal({ db, kv, registeredUserId: user.id })
    return user
  })()

  registrationInFlight.set(kv, promise)
  try {
    return await promise
  } finally {
    registrationInFlight.delete(kv)
  }
}

export async function finalizeInitialRegistration({ db, kv = db?.kv, registeredUserId = null }) {
  if (!kv) throw new BootstrapError('管理员初始化缺少 KV 绑定')
  const current = registrationInFlight.get(kv)
  if (current) return current
  const promise = finalizeInitialRegistrationInternal({ db, kv, registeredUserId })
  registrationInFlight.set(kv, promise)
  try {
    return await promise
  } finally {
    registrationInFlight.delete(kv)
  }
}

async function finalizeInitialRegistrationInternal({ db, kv, registeredUserId = null }) {
  let record = await ensureBootstrapRecord({ db, kv, env: {} })
  if (record.state === 'disabled') return record
  if (record.state === 'closed') throw new BootstrapError('注册已关闭', 403)
  if (record.state !== 'pending' && record.state !== 'finalizing') {
    throw new BootstrapError('初始管理员状态不允许注册')
  }

  if (record.state === 'pending') {
    record = await writeBootstrap(kv, { ...record, state: 'finalizing', registrationUserId: registeredUserId })
  }

  if (record.defaultAdminId && record.defaultAdminId !== registeredUserId) {
    await disableBootstrapUser({ db, kv, userId: record.defaultAdminId })
  }

  const next = await writeBootstrap(kv, {
    ...record,
    state: 'disabled',
    disabledAt: nowIso(),
    registrationUserId: registeredUserId || record.registrationUserId || null,
  })
  bootstrapReady.delete(kv)
  await kv.delete(LEGACY_BOOTSTRAP_KEY).catch(() => {})
  return next
}

/**
 * 初始管理员直接登录并采用该账号为正式管理员：
 * 关闭首次注册入口，但不禁用当前登录账号。
 */
export async function adoptBootstrapAdmin({ db, kv = db?.kv, userId }) {
  if (!kv || !userId) throw new BootstrapError('缺少 KV 或用户')
  const record = await readBootstrap(kv).catch(() => null)
  if (!record || record.state !== 'pending') {
    return record || { state: 'closed', needsRegistration: false }
  }
  if (record.defaultAdminId && record.defaultAdminId !== userId) {
    throw new BootstrapError('只有初始管理员可以完成此操作', 403)
  }
  // registeredUserId === defaultAdminId → finalize 不会禁用自己
  return finalizeInitialRegistration({ db, kv, registeredUserId: userId })
}

export async function isBootstrapAdminDisabled({ kv, user }) {
  if (!user) return true
  // 密码被标记禁用 → 一定不可登录
  if (String(user.password_hash || '').startsWith('!!disabled:')) return true

  const record = await readBootstrap(kv).catch(() => null)
  if (record?.defaultAdminId && record.defaultAdminId === user.id && record.state !== 'pending') {
    // 初始管理员通过登录 adopt 为自己：registrationUserId === 自身，应允许继续使用
    if (record.registrationUserId && String(record.registrationUserId) === String(user.id)) {
      return false
    }
    // 其他人完成首次注册后，初始账号应不可用（即便密码尚未写入 !!disabled:）
    return true
  }

  // 兼容旧行为：没有 v2/旧 marker 时，用户名 admin 视为已退役的临时账号。
  if (!record && String(user.username || '').toLowerCase() === 'admin') {
    const legacyMarker = await kv.get(LEGACY_BOOTSTRAP_KEY).catch(() => null)
    if (legacyMarker !== '1') return true
  }
  return false
}
