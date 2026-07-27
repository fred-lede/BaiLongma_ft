// A small, deliberately high-precision boundary between conversational text
// and requests that require an observable side effect.  This is not a general
// intent classifier: false positives here would turn ordinary Q&A into an
// annoying tool loop.  Add a contract only when the wording clearly asks the
// agent to change state or retrieve fresh external/local evidence.

import {
  inferBrowserDisplayMode,
  isExplicitBrowserDisplayModeRequest,
  isSystemBrowserRequest,
} from '../mcp/browser-display.js'
import { explicitlyKeepsBrowserOpen } from './browser-intent-guards.js'

const META_QUESTION_RE = /(?:你(?:有|会|能).{0,18}(?:工具|能力)|(?:多少|哪些|什么).{0,12}(?:工具|命令|能力)|工具.{0,12}(?:多少|哪些|什么)|怎么(?:调用|使用).{0,12}(?:工具|命令))/i
const BROWSER_NAVIGATION_URL_RE = /(?:https?:\/\/|www\.|(?:[\w-]+\.)+(?:com|cn|org|net|io)\b)/i
const BROWSER_INFORMATION_ACTION_RE = /(?:搜索|查询|查找|浏览(?!器)|阅读|播放|观看)|(?:search|browse|read|play|watch)\b/i
const BROWSER_OPEN_TARGET_RE = /(?:打开|访问|进入|前往|加载)\s*(?:一下\s*)?(?!这个(?:网页|页面)|当前(?:网页|页面)|刚才(?:的)?(?:网页|页面)|$)[\p{L}\p{N}]/iu
const BROWSER_OPEN_TARGET_EN_RE = /(?:open|visit|go\s+to|navigate\s+to|load)\s+(?!(?:this|the current|the previous)\s+(?:page|webpage)\b)[a-z0-9]/i
const BROWSER_CLOSE_RE = /(?:(?:关闭|关掉|退出).{0,12}(?:你的浏览器|白龙马浏览器|agent\s*浏览器|小窗口浏览器|大窗口浏览器|小浏览器|大浏览器|当前网页|当前页面|浏览器|网页|页面)|(?:close|quit|exit)\s+(?:your|the\s+bailongma|the\s+agent|the\s+current)?\s*(?:browser|webpage|page)\b)/i
const BROWSER_CLOSE_FILLER_RE = /(?:不用|无需|不要|别)(?:再)?(?:说话|解释|说明)|只(?:要|需)?(?:回复|回)?(?:一个)?(?:ok)?(?:的)?(?:👌)?(?:表情|图标)?|那(?:现在)?(?:怎么办)?|请|麻烦(?:你)?|帮我|帮忙|给我|现在|就|直接|真的|真正|先|再|把|将|好的?|行|可以|一下|吧|啊|呀|哦|呢|啦|谢谢(?:你)?|麻烦了|就行(?:了)?|即可|\b(?:please|now|just|simply|thanks|thank\s+you|do\s+it)\b/giu
const BROWSER_CLOSE_PUNCTUATION_RE = /[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>《》…—-]/gu

function hasAdditionalBrowserCloseTask(text = '') {
  // Treat the close as standalone only when everything outside the matched
  // close clause is known conversational filler. Unknown words are substantive
  // by default, so combined tasks cannot lose their real answer merely because
  // a new verb was absent from an enumerated intent regex.
  const remainder = String(text || '')
    .replace(BROWSER_CLOSE_RE, ' ')
    .replace(BROWSER_CLOSE_FILLER_RE, ' ')
    .replace(BROWSER_CLOSE_PUNCTUATION_RE, '')
  return remainder.length > 0
}

function isExplicitBrowserNavigationRequest(text = '') {
  const value = String(text || '').trim()
  return isExplicitBrowserDisplayModeRequest(value) && (
    BROWSER_NAVIGATION_URL_RE.test(value)
    || BROWSER_INFORMATION_ACTION_RE.test(value)
    || BROWSER_OPEN_TARGET_RE.test(value)
    || BROWSER_OPEN_TARGET_EN_RE.test(value)
  )
}

const CONTRACTS = [
  {
    id: 'system_browser_open',
    label: '使用电脑浏览器打开网页',
    tools: ['system_browser_open'],
    match: isSystemBrowserRequest,
  },
  {
    id: 'browser_open_in_display_mode',
    label: '使用指定的白龙马浏览器打开网页',
    // Navigation already runs through the display mode selected
    // deterministically for this turn. Its browser_preview.mode is observable
    // evidence that both the requested presentation and navigation happened;
    // demanding an extra display-only call makes combined requests brittle.
    tools: ['browser_navigate'],
    match: isExplicitBrowserNavigationRequest,
    resolve: (text) => ({
      expectedBrowserDisplayMode: inferBrowserDisplayMode(text),
    }),
  },
  {
    id: 'browser_close',
    label: '真正关闭白龙马浏览器页面',
    tools: ['browser_close'],
    match: text => !explicitlyKeepsBrowserOpen(text) && BROWSER_CLOSE_RE.test(text),
    resolve: text => ({
      fixedReply: hasAdditionalBrowserCloseTask(text) ? '' : '👌',
    }),
  },
  {
    id: 'browser_display_mode',
    label: '切换浏览器显示大小',
    tools: ['browser_set_display_mode'],
    match: isExplicitBrowserDisplayModeRequest,
  },
  {
    id: 'directory_create',
    label: '创建目录',
    tools: ['make_dir'],
    pattern: /(?:创建|新建).{0,40}(?:目录|文件夹|folder|directory)/i,
  },
  {
    id: 'file_delete',
    label: '删除文件',
    tools: ['delete_file'],
    pattern: /(?:删除|删掉|清理).{0,40}(?:文件|文档|代码|脚本|配置|readme|\.md\b|\.txt\b|\.json\b|\.js\b|\.py\b|\.html\b)/i,
  },
  {
    id: 'file_write',
    label: '写入或修改文件',
    tools: ['write_file'],
    pattern: /(?:创建|新建|写入|保存|修改|编辑|更新).{0,40}(?:文件|文档|代码|脚本|配置|readme|\.md\b|\.txt\b|\.json\b|\.js\b|\.py\b|\.html\b)|(?:帮我|请).{0,24}(?:改|修|写).{0,30}(?:代码|项目|脚本|页面|文件)/i,
  },
  {
    id: 'command',
    label: '执行命令或启动程序',
    tools: ['exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'],
    pattern: /(?:请|帮我|给我)?\s*(?:运行|执行|启动|停止|杀掉|关闭).{0,40}(?:命令|程序|进程|服务|脚本|终端|powershell|bash|npm|node|python|server)|(?:run|execute|start|stop|kill)\s+(?:the\s+)?(?:command|process|server|script|npm|node|python)/i,
  },
  {
    id: 'web',
    label: '联网查询',
    // Requiring navigation prevents a stale snapshot/current-tab inspection
    // from being mistaken for a fresh web lookup. The normal router injects the
    // rest of the safe Playwright group for snapshot/find/click follow-through.
    tools: ['browser_navigate'],
    pattern: /(?:帮我|请|给我).{0,12}(?:上网|联网|搜索|查一下|查一查|检索|找一下|浏览).{0,40}|(?:搜索|查询|查找).{0,30}(?:网页|网站|新闻|资料|链接|网址)|\b(?:search|browse|look\s+up|fetch)\b/i,
  },
  {
    id: 'reminder',
    label: '创建或变更提醒',
    tools: ['manage_reminder'],
    pattern: /(?:提醒我|帮我提醒|设(?:置|一个).{0,12}提醒|取消.{0,12}提醒|删除.{0,12}提醒|remind me|set (?:a )?reminder)/i,
  },
  {
    id: 'memory_write',
    label: '保存记忆',
    tools: ['upsert_memory'],
    pattern: /(?:记住|记一下|帮我记|存到记忆|保存到记忆).{0,80}/i,
  },
  {
    id: 'software_install',
    label: '发起软件安装',
    tools: ['install_software'],
    pattern: /(?:帮我|请|给我).{0,16}(?:安装|装上|下载并安装).{0,40}(?:软件|应用|app|程序)?|(?:install|set up)\s+.+/i,
  },
  {
    id: 'ui_action',
    label: '更新界面状态',
    tools: ['focus_banner', 'hotspot_mode', 'worldcup_mode', 'typhoon_mode', 'ui_set'],
    pattern: /(?:打开|关闭|显示|隐藏).{0,30}(?:专注|热点|热搜|世界杯|台风|面板)|(?:进入|退出).{0,12}(?:专注|心流|focus)/i,
  },
]

export function classifyActionContract(message = '') {
  const text = String(message || '').trim()
  if (!text || META_QUESTION_RE.test(text)) return null
  // “怎么/如何做” requests an explanation, not the side effect itself.
  if (/^(?:请问[，,：:]?\s*)?(?:怎么|如何|怎样|能否|可否|what\b|how\b)/i.test(text)) return null

  const match = CONTRACTS.find(contract => (
    typeof contract.match === 'function'
      ? contract.match(text)
      : contract.pattern.test(text)
  ))
  if (!match) return null
  if (match.id === 'software_install' && /(?:工具|插件|plugin|npm|依赖|扩展)/i.test(text)) return null
  if (match.id === 'memory_write' && /(?:你|能).{0,12}记住.*[？?]$/i.test(text)) return null

  return {
    id: match.id,
    label: match.label,
    requiredTools: [...match.tools],
    ...(typeof match.resolve === 'function' ? match.resolve(text) : {}),
  }
}

export function actionContractToolSucceeded(contract, toolName, result) {
  if (!contract?.requiredTools?.includes(toolName)) return false
  const text = String(result || '').trim()
  if (!text) return true
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false || parsed?.error) return false
    if (contract.id === 'browser_open_in_display_mode') {
      return parsed?.browser_preview?.mode === contract.expectedBrowserDisplayMode
    }
    return true
  } catch {
    return !/^(?:错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/i.test(text)
  }
}

export function actionContractCompletionIssue(contract, text = '') {
  if (contract?.id !== 'system_browser_open') return ''
  const value = String(text || '').trim()
  if (!value) return ''
  if (/(?:\b(?:safari|chrome|edge|firefox|arc|opera|brave)\b|谷歌浏览器|苹果浏览器)/i.test(value)) {
    return 'The tool verified only the computer default browser, not the browser application name.'
  }
  if (/(?:三个|三种).{0,16}浏览器.{0,20}(?:各自|彼此|互相|完全)?.{0,10}(?:独立|不共享|互不影响)/i.test(value)
      || /(?:你的浏览器).{0,30}(?:我的浏览器).{0,30}(?:各自独立|彼此独立|互不影响|不共享)/i.test(value)) {
    return 'Bailongma compact and large modes share one live page/profile; only the computer browser is separate.'
  }
  return ''
}

export function verifiedActionContractReply(contract, evidence = {}) {
  if (contract?.id === 'browser_close') return String(contract?.fixedReply || '')
  if (contract?.id !== 'system_browser_open') return ''
  let url = String(evidence?.args?.url || '').trim()
  try {
    const parsed = JSON.parse(String(evidence?.result || '{}'))
    if (parsed?.url) url = String(parsed.url)
  } catch {}
  const target = url ? `链接 \`${url}\`` : '链接'
  return `已将${target}交给电脑的系统默认浏览器打开。白龙马的“小窗口浏览器”和“大窗口浏览器”是同一个实时页面的两种显示形态；电脑浏览器与它们独立。`
}

export function containsUnsupportedCompletionClaim(text = '') {
  return /(?:已(?:经)?(?:完成|做好|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)|(?:完成|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:好了|完成了)|(?:创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:成功|完成)|搞定了|done|completed|created|installed|executed)/i.test(String(text || ''))
}
