import fs from 'fs'
import path from 'path'
import { nowTimestamp } from '../time.js'
import {
  normalizeConversationPartyId,
  insertConversation,
  markConversationOpenQuestion,
  findRecentJarvisDuplicate,
} from '../db.js'
import { emitEvent } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { lookupReplyTarget, normalizeChannel, suggestProactiveChannel, isVoiceChannel } from '../identity.js'
import { sanitizeAssistantReplyForDelivery } from './markers.js'
import { persistChatMediaPath } from '../chat-media.js'

// P0-2：识别 send_message 末尾是否留了"非澄清型 follow-up question"。
//   触发条件：
//     - 结尾包含问号（? / ？）
//     - 问号所在句子里有"要 / 想 / 需要 / 是否 / 要不要 / 需不需要 / 帮 / 给 / 行不行"
//       或英文 "should/want/need/shall/would you like/do you want"
//   澄清型（"在哪个城市？"/"几点？"）也会被命中——可接受，因为标记本身不影响
//   当前轮输出，只在后续轮该悬念过期时降权，避免代词被钩偏。
const FOLLOWUP_VERB_RE = /(要不要|需不需要|要么|要|想|需要|是否|帮我?|给我?|行不行|可以吗|好吗|可否|能否)/
const FOLLOWUP_EN_RE = /\b(should|want|need|shall|would you like|do you want|may i|can i)\b/i
const OUTBOUND_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const OUTBOUND_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
const OUTBOUND_MESSAGE_DEDUPE_TTL_MS = 30_000
const recentOutboundMessages = new Map()

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function pruneRecentOutboundMessages(now = Date.now()) {
  for (const [key, entry] of recentOutboundMessages) {
    if (!entry || now - entry.timestamp > OUTBOUND_MESSAGE_DEDUPE_TTL_MS) {
      recentOutboundMessages.delete(key)
    }
  }
}

function outboundMessageKey({ toId, channel, externalTargetId, content }) {
  return JSON.stringify([
    normalizeConversationPartyId(toId || ''),
    String(channel || '').toUpperCase(),
    String(externalTargetId || ''),
    String(content || '').trim(),
  ])
}

function claimOutboundMessage(key) {
  const now = Date.now()
  pruneRecentOutboundMessages(now)
  if (recentOutboundMessages.has(key)) return false
  recentOutboundMessages.set(key, { timestamp: now })
  return true
}

function sendMessageResult(payload = {}) {
  return toolJson({ tool: 'send_message', ...payload })
}

export function detectOpenFollowupQuestion(text = '') {
  const s = String(text || '').trim()
  if (!s) return false
  // 必须有问号
  if (!/[?？]\s*$/.test(s) && !/[?？]\s*[")'』」】）)]?\s*$/.test(s)) return false
  // 取末尾问号所在的句子片段
  const segs = s.split(/[。!！\n]+/).filter(Boolean)
  const lastSeg = segs[segs.length - 1] || s
  return FOLLOWUP_VERB_RE.test(lastSeg) || FOLLOWUP_EN_RE.test(lastSeg)
}

function inferOutboundMediaKind(filePath = '') {
  const ext = path.extname(filePath).toLowerCase()
  if (OUTBOUND_IMAGE_EXTS.has(ext)) return 'image'
  if (OUTBOUND_VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

// 把聊天媒体复制进受管的内容寻址仓库（data/media/<sha256>.<ext>），返回供前端渲染的稳定 URL。
//   - 内容寻址：同图只存一份；原文件被同名替换成别的内容时哈希必然不同，老消息仍指向老副本。
//   - 与原始路径解耦：截图/临时文件即便事后被删，聊天记录里的图依旧能显示。
// 失败（如磁盘错误）时返回 null，调用方退化为仅文本标记，不阻断消息发送。
function persistChatMedia(resolvedPath) {
  try {
    return persistChatMediaPath(resolvedPath).url
  } catch (err) {
    console.warn(`[media] 聊天媒体落盘失败（退化为纯文本标记）：${err.message}`)
    return null
  }
}

function normalizeOptionalPath(value) {
  const text = value == null ? '' : String(value).trim()
  return text || ''
}

function prepareOutboundMedia({ image_path, media_path } = {}) {
  const imagePath = normalizeOptionalPath(image_path)
  const mediaPath = normalizeOptionalPath(media_path)
  if (imagePath && mediaPath && path.resolve(imagePath) !== path.resolve(mediaPath)) {
    return { error: 'Provide only one of image_path or media_path.' }
  }

  const rawPath = imagePath || mediaPath
  if (!rawPath) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
    return { error: 'media_path must be a local file path, not a URL.' }
  }

  let resolvedPath = ''
  try {
    resolvedPath = path.resolve(rawPath)
  } catch (err) {
    return { error: `Invalid media path: ${err.message}` }
  }

  let stat = null
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return { error: `Media file does not exist: ${resolvedPath}` }
  }
  if (!stat.isFile()) return { error: `Media path is not a file: ${resolvedPath}` }

  const kind = inferOutboundMediaKind(resolvedPath)
  if (imagePath && kind !== 'image') {
    return { error: 'image_path must point to an image file (.png, .jpg, .jpeg, .gif, .webp, .bmp).' }
  }

  return {
    path: resolvedPath,
    kind,
    fileName: path.basename(resolvedPath),
    size: stat.size,
    storedUrl: persistChatMedia(resolvedPath),
  }
}

function formatOutboundConversationContent(text, media) {
  if (!media) return text
  // 有内容寻址副本时写成可渲染的引用：图片用 markdown 图片语法，其它媒体用链接。
  //   markdown.js 会把 /media/ 开头的本地端点渲染成 <img>/<a>，截图删了也还能从副本显示。
  // 没拿到副本（落盘失败）才退回旧的纯文本标记，保证消息仍能发出。
  let marker
  if (media.storedUrl) {
    marker = media.kind === 'image'
      ? `![${media.fileName}](${media.storedUrl})`
      : `[${media.kind} · ${media.fileName}](${media.storedUrl})`
  } else {
    marker = `[${media.kind}] ${media.fileName}`
  }
  return text ? `${text}\n${marker}` : marker
}

function makeSocialPayload(text, media) {
  if (!media) return text
  return {
    text,
    mediaPath: media.path,
    mediaKind: media.kind,
    fileName: media.fileName,
    size: media.size,
  }
}

// 决议出站消息的真实投递目标：
// 输入 target_id（可能是 canonical ID:000001 或带前缀的外部 ID）+ channel 偏好（WECHAT/DISCORD/FEISHU/WECOM/TUI/AUTO）+ ctx
// 输出 { externalTargetId, deliveryChannel, isLocal, reason }
//   - externalTargetId: 传给 dispatchSocialMessage 的 ID（本地投递时为 null）
//   - deliveryChannel: conversations.channel 字段实际值（数据库格式，如 WECHAT_CLAWBOT/TUI）
//   - isLocal: true 时不调外部 dispatch，只走本地 SSE
//   - reason: 失败时给 LLM 的提示
// AUTO 决议顺序：当前 turn 渠道（响应模式）→ suggestProactiveChannel（主动模式）
function resolveDeliveryTarget(resolvedId, channelPref, context = {}) {
  const pref = (channelPref || 'AUTO').toUpperCase()

  // resolvedId 本身就是带渠道前缀的外部 ID（少见，但保留兼容）—— 直接当外部投递
  if (/^(wechat|discord|feishu|wecom):/i.test(resolvedId)) {
    return { externalTargetId: resolvedId, deliveryChannel: '', isLocal: false }
  }

  // canonical 用户 ID：根据 channel 偏好决议
  let actualPref = pref
  if (actualPref === 'AUTO') {
    // 优先用当前 turn 的渠道：用户在哪儿发消息就回到哪儿（响应直觉一致）
    const currentNorm = context.currentChannel ? normalizeChannel(context.currentChannel) : null
    if (currentNorm && currentNorm !== 'SYSTEM') {
      actualPref = currentNorm
    } else {
      // 没有当前 turn 渠道（典型场景：tick 主动外联）→ 用 presence 推荐
      actualPref = suggestProactiveChannel(resolvedId)
    }
  }

  if (actualPref === 'TUI') {
    return { externalTargetId: null, deliveryChannel: 'TUI', isLocal: true }
  }

  // 当前 turn 已经在该外部渠道、且带 externalPartyId → 直接复用，省一次 DB 查
  if (context.currentExternalPartyId && context.currentChannel) {
    const ctxNorm = normalizeChannel(context.currentChannel)
    if (ctxNorm === actualPref) {
      return {
        externalTargetId: context.currentExternalPartyId,
        deliveryChannel: context.currentChannel,
        isLocal: false,
      }
    }
  }

  // 否则反查该 canonical 用户在指定渠道最近一次的 external_id
  const reply = lookupReplyTarget({ canonicalId: resolvedId, channel: actualPref })
  if (reply) {
    return { externalTargetId: reply.externalId, deliveryChannel: reply.channel, isLocal: false }
  }

  // 用户在该渠道从未交互过，无法主动联系
  return {
    externalTargetId: null,
    deliveryChannel: '',
    isLocal: false,
    error: `cannot route to ${actualPref}: user ${resolvedId} has no recorded external_party_id on that channel`,
  }
}

// send_message：投递到指定渠道（本地 SSE 或外部平台），并写入 conversations 表
export async function deliverMessage({ target_id, content = '', channel = 'AUTO', image_path, media_path }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'

  const resolvedId = normalizeConversationPartyId(target_id)
  const cleanedContent = content == null ? '' : sanitizeAssistantReplyForDelivery(content)
  const media = prepareOutboundMedia({ image_path, media_path })
  if (media?.error) return `错误：${media.error}`
  if (!cleanedContent && !media) return '错误：未提供消息内容'
  const outboundContent = formatOutboundConversationContent(cleanedContent, media)

  const delivery = resolveDeliveryTarget(resolvedId, channel, context)
  if (delivery.error) return `错误：${delivery.error}`
  if (media && (delivery.isLocal || !delivery.externalTargetId || !/^wechat:clawbot:/i.test(delivery.externalTargetId))) {
    const resolvedTarget = delivery.externalTargetId || (delivery.isLocal ? 'TUI' : 'unknown')
    return `错误：媒体消息当前仅支持微信 ClawBot（wechat:clawbot:*），当前解析目标为 ${resolvedTarget}`
  }

  // 防重发：对同一 target 发过一字不差、且对方此后没回过话的内容 → 拒绝（不论隔多久）。
  //   常见诱因：启动期 directions（delegation ask 等）在用户回应前每 tick 都注入相同指令，
  //   模型每次都被驱动着发一遍同一句话。让 send_message 直接拦下来，并告知模型该停。
  //   判定细节见 db.findRecentJarvisDuplicate：以"用户是否已回应"为界，5 分钟窗只是兜底下限。
  const channelLabel = delivery.deliveryChannel || (delivery.isLocal ? 'TUI' : '')
  const outboxKey = outboundMessageKey({
    toId: resolvedId,
    channel: channelLabel,
    externalTargetId: delivery.externalTargetId || '',
    content: outboundContent,
  })
  if (!claimOutboundMessage(outboxKey)) {
    const preview = outboundContent.length > 50 ? outboundContent.slice(0, 50) + '...' : outboundContent
    return sendMessageResult({
      ok: false,
      skipped: 'duplicate_outbound',
      duplicate: true,
      delivered: false,
      message_sent: false,
      target_id: resolvedId,
      channel: channelLabel,
      error: `Duplicate outbound message suppressed: "${preview}"`,
      reason: 'The same message to the same target/channel is already being sent or was just sent. End the round; do not send it again.',
    })
  }

  const dup = findRecentJarvisDuplicate(resolvedId, outboundContent, 5 * 60 * 1000)
  if (dup) {
    const ageSec = Math.max(0, Math.round(dup.ageMs / 1000))
    const ageText = ageSec >= 60 ? `${Math.round(ageSec / 60)} 分钟前` : `${ageSec} 秒前`
    const preview = outboundContent.length > 50 ? outboundContent.slice(0, 50) + '…' : outboundContent
    return `错误：这条消息（"${preview}"）你在 ${ageText}已发给 ${resolvedId} 一次（conversation id=${dup.id}），对方至今没有回应。在对方回应之前逐字重发同一句话是无效且让人反感的行为，无论隔了多久。本轮不要再调用 send_message；保持安静，等对方主动开口再继续。如果确有新进展，也要换成带新信息的表达，不要照搬原话。`
  }

  const timestamp = nowTimestamp()
  console.log(`\n[消息发送] → ${resolvedId}${delivery.externalTargetId ? ` via ${delivery.externalTargetId}` : ''}${channelLabel ? ` [${channelLabel}]` : ''}`)
  console.log(`  ${outboundContent}`)
  if (media) console.log(`  media_path: ${media.path}`)
  console.log(`  时间：${timestamp}`)

  // 顺序：先写数据库（source of truth），再广播 SSE，最后外部投递。
  // 外部投递失败时仍保留对话记录，下次 LLM 仍能看到自己发过这句话；前端也已经显示。
  // P0-2：检测末尾是否留了"非澄清型 follow-up question"——这是后续轮次代词被钩偏的源头。
  //   保守判定：以问号收尾（? / ？）且至少含一个动词+助词组合（要 / 需 / 想 / 帮 / 给 / 是否）
  //   或英文 should/want/need/shall。澄清型疑问（"在哪个城市？"/"几点？"）也会被命中——
  //   接受这点：标 open_question 不阻止模型输出，只在后续轮过期时降权，不伤当前回合。
  const isOpenFollowup = detectOpenFollowupQuestion(cleanedContent)
  const insertedId = insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: resolvedId,
    content: outboundContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
    open_question: isOpenFollowup ? 1 : 0,
  })
  if (isOpenFollowup && insertedId) {
    // 写入时 open_question 已设；此处保留兜底（万一上面 column 没生效）
    try { markConversationOpenQuestion(insertedId, true) } catch {}
  }

  const shouldSpeakLocally = Boolean(cleanedContent)
    && !media
    && delivery.isLocal
    && (context.voiceReply === true || isVoiceChannel(context.currentChannel))

  emitEvent('message', {
    from: 'consciousness',
    to: resolvedId,
    content: outboundContent,
    timestamp,
    conversation_id: insertedId,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
    ...(shouldSpeakLocally ? { speak: true } : {}),
    ...(media ? { media_path: media.path, media_kind: media.kind, file_name: media.fileName } : {}),
  })

  let socialResult = null
  if (!delivery.isLocal && delivery.externalTargetId) {
    try {
      socialResult = await dispatchSocialMessage(delivery.externalTargetId, makeSocialPayload(cleanedContent, media))
    } catch (err) {
      console.warn(`[消息发送] 外部投递异常 (${delivery.deliveryChannel}): ${err.message}`)
      socialResult = { ok: false, error: err.message }
    }
  }

  if (socialResult?.ok) return `${media ? '媒体' : '消息'}已发送至 ${resolvedId}（${socialResult.platform} 已投递）`
  if (socialResult?.skipped) return `${media ? '媒体' : '消息'}已发送至 ${resolvedId}（社交平台未配置：${socialResult.reason}）`
  if (socialResult && socialResult.ok === false) {
    const reason = socialResult.reason || socialResult.error || 'unknown'
    // wechat-clawbot 缺 context_token 是该渠道最常见的失败：重启后内存 Map 清空、或用户从未入站。
    // 单独点名，让 LLM 直接告诉用户"先发一条过来"，不要去编造其他解释。
    const isMissingContextToken = /no context_token/i.test(reason)
    const hint = isMissingContextToken
      ? '（wechat-clawbot 必须先收到该用户的入站消息才能回发；告诉用户先从微信给你发一条任意内容即可。）'
      : ''
    return `消息发送失败：外部渠道 ${delivery.deliveryChannel || 'unknown'} 投递未成功（${reason}）。${hint}请如实告知用户该消息未送达及原因。`
  }
  return `消息已发送至 ${resolvedId}${channelLabel ? `（${channelLabel}）` : ''}`
}
