import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

export const BROWSER_DISPLAY_CARD = 'card'
export const BROWSER_DISPLAY_WINDOW = 'window'

const EXPLICIT_CARD_MODE_RE = /(?:小窗口|小卡片|卡片模式|缩略(?:卡片|窗口|模式)?|行动日志.{0,8}(?:窗口|卡片)|后台浏览|静默浏览|不打开窗口|不(?:要|用|使用|打开).{0,10}(?:大窗口|外部窗口|外部大窗口))/i
const CARD_MODE_RE = /^(?:帮我|请)?(?:搜|搜索|查|查询|检索|看看)|(?:上网|网上|联网).{0,8}(?:搜|搜索|查|查询|看看)|(?:搜|搜索|查|查询|检索|了解|看看|读取|阅读|总结|概括|摘要).{0,18}(?:网页|网站|网上|互联网|资料|信息|内容|文章|新闻|结果|官网|文档|天气|价格|汇率|赛程|比分)|(?:百度|谷歌|bing|google).{0,12}(?:搜|搜索|查)|(?:web\s*search|search|look\s*up|find|read|summari[sz]e).{0,20}(?:web|online|internet|website|webpage|page|article|news|docs?)/i
const FACT_LOOKUP_RE = /(?:谁是|是谁|是什么(?:人|公司|组织|项目|产品|软件|东西)?|是做什么的|做什么的|(?:人物|公司|产品|项目)?(?:简介|资料|背景|经历|生平|履历))|^(?:请)?(?:介绍|讲讲|科普|了解)(?:一下|下)?[\s“"'‘’]*[\p{L}\p{N}]/iu
const WINDOW_MODE_RE = /(?:大窗口|外部窗口|完整浏览器|可见浏览器|我来操作|我自己操作|让我操作|手动操作|展示给我|(?:打开|切到|显示|展示).{0,12}(?:给我看|让我看))|(?:登录|登入|注册|填写|填入|输入框|点击|点一下|回复|发表评论|评论一下|写评论|发帖|发布|提交|上传|下载|拖动|悬停|验证码|支付|购买|下单).{0,18}(?:网页|网站|页面|按钮|链接|菜单|标签|表单|账号|内容|评论|帖子)?|(?:browser\s+window|visible\s+browser|log\s*in|sign\s*in|fill\s+(?:in\s+)?(?:a\s+)?form|click|reply|(?:write|leave|post)\s+(?:a\s+)?comment|post|publish|submit|upload|download|drag|hover|captcha|checkout)/i
const BROWSER_PREVIEW_FILE_RE = /^brain-ui-preview-\d{13}-\d+\.png$/
let previewSequence = 0

function normalizeBrowserIntentText(text = '') {
  return String(text || '')
    .trim()
    .replace(/^\[[^\]\r\n]+\]\s+\S+\s+\[[^\]\r\n]+\]\s*/, '')
    .trim()
}

export function inferBrowserDisplayMode(text = '', { autonomous = false } = {}) {
  const value = normalizeBrowserIntentText(text)
  // An explicit compact-view request is a presentation choice, not a guess
  // about task complexity. Honor it before generic interaction words or a
  // negated phrase such as "不要使用外部大窗口" can match WINDOW_MODE_RE.
  if (EXPLICIT_CARD_MODE_RE.test(value)) return BROWSER_DISPLAY_CARD
  if (WINDOW_MODE_RE.test(value)) return BROWSER_DISPLAY_WINDOW
  if (autonomous || CARD_MODE_RE.test(value) || FACT_LOOKUP_RE.test(value)) return BROWSER_DISPLAY_CARD
  return BROWSER_DISPLAY_CARD
}

export function isCardBrowserDisplayMode(value) {
  return String(value || '').trim().toLowerCase() === BROWSER_DISPLAY_CARD
}

export function browserPreviewDirectory() {
  return path.join(paths.sandboxDir, 'browser-output', 'reader')
}

export function createBrowserPreviewFilename(now = Date.now()) {
  previewSequence = (previewSequence + 1) % 1_000_000
  return `brain-ui-preview-${Number(now) || Date.now()}-${previewSequence}.png`
}

export function resolveBrowserPreviewFile(filename) {
  const raw = String(filename || '')
  const name = path.basename(raw)
  if (raw !== name) return ''
  if (!BROWSER_PREVIEW_FILE_RE.test(name)) return ''
  return path.join(browserPreviewDirectory(), name)
}

export function pruneBrowserPreviewFiles({ keep = 6 } = {}) {
  const directory = browserPreviewDirectory()
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  const files = entries
    .filter(entry => entry.isFile() && BROWSER_PREVIEW_FILE_RE.test(entry.name))
    .map(entry => {
      const filePath = path.join(directory, entry.name)
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(filePath).mtimeMs } catch {}
      return { filePath, mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const stale of files.slice(Math.max(1, Number(keep) || 6))) {
    try { fs.unlinkSync(stale.filePath) } catch {}
  }
}

export const __internal = {
  BROWSER_PREVIEW_FILE_RE,
  CARD_MODE_RE,
  EXPLICIT_CARD_MODE_RE,
  FACT_LOOKUP_RE,
  WINDOW_MODE_RE,
  normalizeBrowserIntentText,
}
