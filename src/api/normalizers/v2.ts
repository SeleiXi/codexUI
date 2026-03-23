import type {
  Thread,
  ThreadItem,
  ThreadReadResponse,
  ThreadListResponse,
  Turn,
  UserInput,
} from '../appServerDtos'
import type { CommandExecutionData, UiFileAttachment, UiMessage, UiProjectGroup, UiThread } from '../../types/codex'

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}

function toRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function summarizeJsonValue(value: unknown, maxLength = 160): string {
  const raw = toRawPayload(value).replace(/\s+/gu, ' ').trim()
  if (raw.length <= maxLength) return raw
  return `${raw.slice(0, maxLength - 1)}…`
}

function formatStatus(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Unknown'
  if (value === 'inProgress') return 'Running'
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}

function buildSystemMessage(id: string, messageType: string, lines: Array<string | null | undefined>, rawPayload?: unknown): UiMessage[] {
  const text = lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0).join('\n')
  if (!text) return []
  return [
    {
      id,
      role: 'system',
      text,
      messageType,
      rawPayload: rawPayload === undefined ? undefined : toRawPayload(rawPayload),
    },
  ]
}

function buildReasoningMessage(item: Extract<ThreadItem, { type: 'reasoning' }>): UiMessage[] {
  const contentLines = Array.isArray(item.content)
    ? item.content.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : []
  const summaryLines = Array.isArray(item.summary)
    ? item.summary.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : []
  const text = (contentLines.length > 0 ? contentLines : summaryLines).join('\n\n').trim()
  if (!text) return []
  return [
    {
      id: item.id,
      role: 'system',
      text,
      messageType: 'reasoning',
      rawPayload: toRawPayload(item),
    },
  ]
}

const FILE_ATTACHMENT_LINE = /^##\s+(.+?):\s+(.+?)\s*$/
const FILES_MENTIONED_MARKER = /^#\s*files mentioned by the user\s*:?\s*$/i

function extractFileAttachments(value: string): UiFileAttachment[] {
  const markerIdx = value.split('\n').findIndex((line) => FILES_MENTIONED_MARKER.test(line.trim()))
  if (markerIdx < 0) return []
  const lines = value.split('\n').slice(markerIdx + 1)
  const attachments: UiFileAttachment[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(FILE_ATTACHMENT_LINE)
    if (!m) break
    const label = m[1]?.trim()
    const path = m[2]?.trim().replace(/\s+\((?:lines?\s+\d+(?:-\d+)?)\)\s*$/, '')
    if (label && path) attachments.push({ label, path })
  }
  return attachments
}

function extractCodexUserRequestText(value: string): string {
  const markerRegex = /(?:^|\n)\s{0,3}#{0,6}\s*my request for codex\s*:?\s*/giu
  const matches = Array.from(value.matchAll(markerRegex))
  if (matches.length === 0) {
    return value.trim()
  }

  const lastMatch = matches.at(-1)
  if (!lastMatch || typeof lastMatch.index !== 'number') {
    return value.trim()
  }

  const markerOffset = lastMatch.index + lastMatch[0].length
  return value.slice(markerOffset).trim()
}

function parseUserMessageContent(
  itemId: string,
  content: UserInput[] | undefined,
): { text: string; images: string[]; fileAttachments: UiFileAttachment[]; rawBlocks: UiMessage[] } {
  if (!Array.isArray(content)) return { text: '', images: [], fileAttachments: [], rawBlocks: [] }

  const textChunks: string[] = []
  const images: string[] = []
  const rawBlocks: UiMessage[] = []

  for (const [index, block] of content.entries()) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      textChunks.push(block.text)
    }
    if (block.type === 'image' && typeof block.url === 'string' && block.url.trim().length > 0) {
      images.push(block.url.trim())
    }

    if (block.type !== 'text' && block.type !== 'image') {
      rawBlocks.push({
        id: `${itemId}:user-content:${index}`,
        role: 'user',
        text: '',
        messageType: `userContent.${block.type}`,
        rawPayload: toRawPayload(block),
        isUnhandled: true,
      })
    }
  }

  const fullText = textChunks.join('\n')
  const fileAttachments = extractFileAttachments(fullText)

  return {
    text: extractCodexUserRequestText(fullText),
    images,
    fileAttachments,
    rawBlocks,
  }
}

function toUiMessages(item: ThreadItem): UiMessage[] {
  if (item.type === 'agentMessage') {
    return [
      {
        id: item.id,
        role: 'assistant',
        text: item.text,
        messageType: item.type,
      },
    ]
  }

  if (item.type === 'userMessage') {
    const parsed = parseUserMessageContent(item.id, item.content as UserInput[] | undefined)
    const messages: UiMessage[] = []
    const hasRenderableUserContent = parsed.text.length > 0 || parsed.images.length > 0 || parsed.fileAttachments.length > 0

    if (hasRenderableUserContent) {
      messages.push({
        id: item.id,
        role: 'user',
        text: parsed.text,
        images: parsed.images,
        fileAttachments: parsed.fileAttachments.length > 0 ? parsed.fileAttachments : undefined,
        messageType: item.type,
      })
    }

    messages.push(...parsed.rawBlocks)
    if (messages.length === 0) {
      return []
    }

    return messages
  }

  if (item.type === 'reasoning') {
    return buildReasoningMessage(item)
  }

  if (item.type === 'commandExecution') {
    const raw = item as Record<string, unknown>
    const status = normalizeCommandStatus(raw.status)
    const cmd = typeof raw.command === 'string' ? raw.command : ''
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : null
    const aggregatedOutput = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : ''
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : null
    return [
      {
        id: item.id,
        role: 'system' as const,
        text: cmd,
        messageType: 'commandExecution',
        commandExecution: { command: cmd, cwd, status, aggregatedOutput, exitCode },
      },
    ]
  }

  if (item.type === 'mcpToolCall') {
    const raw = item as Record<string, unknown>
    const server = typeof raw.server === 'string' ? raw.server : 'mcp'
    const tool = typeof raw.tool === 'string' ? raw.tool : 'tool'
    const status = formatStatus(raw.status)
    const error = raw.error && typeof raw.error === 'object' ? (raw.error as Record<string, unknown>).message : ''
    const result = raw.result && typeof raw.result === 'object' ? summarizeJsonValue(raw.result) : ''
    const input = raw.arguments !== undefined ? summarizeJsonValue(raw.arguments) : ''
    return buildSystemMessage(item.id, 'toolInvocation', [
      `Tool: ${server}.${tool}`,
      `Status: ${status}`,
      input ? `Input: ${input}` : '',
      error && typeof error === 'string' ? `Error: ${error}` : '',
      result ? `Result: ${result}` : '',
    ], item)
  }

  if (item.type === 'collabAgentToolCall') {
    const raw = item as Record<string, unknown>
    const tool = typeof raw.tool === 'string' ? raw.tool : 'agent_tool'
    const status = formatStatus(raw.status)
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    const receivers = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.length : 0
    return buildSystemMessage(item.id, 'toolInvocation', [
      `Tool: ${tool}`,
      `Status: ${status}`,
      receivers > 0 ? `Agents: ${String(receivers)}` : '',
      prompt ? `Prompt: ${prompt}` : '',
    ], item)
  }

  if (item.type === 'webSearch') {
    const raw = item as Record<string, unknown>
    const action = raw.action && typeof raw.action === 'object' ? raw.action as Record<string, unknown> : null
    const actionType = typeof action?.type === 'string' ? action.type : 'other'
    const query = typeof raw.query === 'string' ? raw.query : ''
    const url = typeof action?.url === 'string' ? action.url : ''
    const pattern = typeof action?.pattern === 'string' ? action.pattern : ''
    return buildSystemMessage(item.id, 'toolInvocation', [
      'Tool: web.search',
      `Action: ${actionType}`,
      query ? `Query: ${query}` : '',
      url ? `URL: ${url}` : '',
      pattern ? `Find: ${pattern}` : '',
    ], item)
  }

  if (item.type === 'imageView') {
    const raw = item as Record<string, unknown>
    const path = typeof raw.path === 'string' ? raw.path : ''
    return buildSystemMessage(item.id, 'toolInvocation', [
      'Tool: view_image',
      path ? `Path: ${path}` : '',
    ], item)
  }

  if (item.type === 'fileChange') {
    const raw = item as Record<string, unknown>
    return buildSystemMessage(item.id, 'toolInvocation', [
      'Tool: apply_patch',
      `Status: ${formatStatus(raw.status)}`,
    ], item)
  }

  return []
}

function normalizeCommandStatus(value: unknown): CommandExecutionData['status'] {
  if (value === 'completed' || value === 'failed' || value === 'declined' || value === 'interrupted') return value
  if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
  return 'completed'
}

function pickThreadName(summary: Thread): string {
  const direct = [summary.preview]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return ''
}

function toThreadTitle(summary: Thread): string {
  const named = pickThreadName(summary)
  return named.length > 0 ? named : 'Untitled thread'
}

function isTurnInProgress(turn: Turn | null | undefined): boolean {
  return turn?.status === 'inProgress'
}

function readThreadInProgress(summary: Thread): boolean {
  const rawSummary = summary as Record<string, unknown>
  if (rawSummary.inProgress === true) return true
  if (rawSummary.status === 'inProgress' || rawSummary.turnStatus === 'inProgress') return true

  const turns = Array.isArray(summary.turns) ? summary.turns : []
  const lastTurn = turns.at(-1)
  return isTurnInProgress(lastTurn)
}

function toUiThread(summary: Thread): UiThread {
  const rawSummary = summary as Record<string, unknown>
  const cwd = typeof rawSummary.cwd === 'string' ? rawSummary.cwd : summary.cwd
  const hasWorktree =
    rawSummary.isWorktree === true ||
    rawSummary.worktree === true ||
    rawSummary.worktreeId !== undefined ||
    rawSummary.worktreePath !== undefined ||
    cwd.includes('/.codex/worktrees/') ||
    cwd.includes('/.git/worktrees/')

  return {
    id: summary.id,
    title: toThreadTitle(summary),
    projectName: toProjectName(summary.cwd),
    cwd: summary.cwd,
    hasWorktree,
    createdAtIso: toIso(summary.createdAt),
    updatedAtIso: toIso(summary.updatedAt),
    preview: summary.preview,
    unread: false,
    inProgress: readThreadInProgress(summary),
  }
}

function groupThreadsByProject(threads: UiThread[]): UiProjectGroup[] {
  const grouped = new Map<string, UiThread[]>()
  for (const thread of threads) {
    const rows = grouped.get(thread.projectName)
    if (rows) rows.push(thread)
    else grouped.set(thread.projectName, [thread])
  }

  return Array.from(grouped.entries())
    .map(([projectName, projectThreads]) => ({
      projectName,
      threads: projectThreads.sort(
        (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLast = new Date(a.threads[0]?.updatedAtIso ?? 0).getTime()
      const bLast = new Date(b.threads[0]?.updatedAtIso ?? 0).getTime()
      return bLast - aLast
    })
}

export function normalizeThreadGroupsV2(payload: ThreadListResponse): UiProjectGroup[] {
  const uiThreads = payload.data.map(toUiThread)
  return groupThreadsByProject(uiThreads)
}

export function normalizeThreadMessagesV2(payload: ThreadReadResponse): UiMessage[] {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const messages: UiMessage[] = []
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const item of items) {
      for (const msg of toUiMessages(item)) {
        messages.push({ ...msg, turnIndex })
      }
    }
  }
  return messages
}

export function readThreadInProgressFromResponse(payload: ThreadReadResponse): boolean {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  return isTurnInProgress(turns.at(-1))
}
