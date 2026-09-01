import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, api } from '../lib/api'
import { MOBILE_TERMINAL_STATUSES } from '../lib/types'
import type { MobileExecutionStatus, MobileStepResult } from '../lib/types'

/**
 * Live feed for ONE mobile execution.
 *
 * Deliberately not built on `useExecutionSocket`. That hook speaks Socket.IO to
 * the Node worker; the mobile engine exposes a plain FastAPI WebSocket at
 * `/api/v1/mobile/executions/{id}/ws` with a completely different message
 * vocabulary (IMPLEMENTATION.md §9). Sharing one hook would mean a protocol
 * switch inside every branch, so they stay separate.
 *
 * Auth: a WebSocket upgrade never passes through Express middleware, and the
 * browser's WebSocket constructor cannot set an Authorization header. The token
 * therefore travels as a query parameter, which backend-node's upgrade handler
 * verifies before proxying (see backend-node/src/routes/mobile.ts).
 *
 * The server replays recent history on connect, so a tab opened mid-run still
 * sees what already happened.
 */

export type MobileLiveStatus = 'idle' | 'connecting' | 'live' | 'disconnected' | 'error'

/** Event names the engine emits. `frame` is handled separately — it is high
 *  volume and must not enter the log feed. */
export type MobileLiveEventType =
  | 'status'
  | 'step_started'
  | 'step_completed'
  | 'healing_started'
  | 'healing_result'
  | 'evidence'
  | 'failure'
  | 'video_ready'
  | 'execution_completed'
  | 'log'

export type MobileLiveEvent = {
  id: number
  type: MobileLiveEventType
  message: string
  time: Date
  raw: Record<string, unknown>
}

/** Bounded so a long suite cannot grow this array without limit. */
const MAX_EVENTS = 300

function describe(type: MobileLiveEventType, p: Record<string, unknown>): string {
  switch (type) {
    case 'status':
      return `Status: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`
    case 'step_started':
      return `Step ${p.step_index}: ${p.action} started`
    case 'step_completed':
      return `Step ${p.step_index}: ${p.action} ${p.status}${
        p.duration_ms ? ` (${p.duration_ms}ms)` : ''
      }${p.error ? ` — ${p.error}` : ''}`
    case 'healing_started':
      return `AutoHeal started on step ${p.step_index}`
    case 'healing_result':
      return `AutoHeal ${p.healed ? 'succeeded' : 'failed'} on step ${p.step_index} (${p.status})`
    case 'evidence':
      return `Captured ${p.artifact_type}${p.step_index != null ? ` at step ${p.step_index}` : ''}`
    case 'failure':
      return `Failure at step ${p.step_index}: ${p.category ?? ''} ${p.message ?? ''}`.trim()
    case 'video_ready':
      return 'Recording saved'
    case 'execution_completed':
      return `Execution ${p.status}${p.duration_ms ? ` in ${p.duration_ms}ms` : ''}`
    case 'log':
      return String(p.message ?? '')
    default:
      return JSON.stringify(p)
  }
}

export function useMobileExecutionSocket(executionId: number | null) {
  const [connectionStatus, setConnectionStatus] = useState<MobileLiveStatus>('idle')
  const [events, setEvents] = useState<MobileLiveEvent[]>([])
  /** Latest device screenshot as a data: URL, ~1.4 fps while RUNNING. */
  const [frame, setFrame] = useState<string | null>(null)
  const [status, setStatus] = useState<MobileExecutionStatus | null>(null)
  const [steps, setSteps] = useState<MobileStepResult[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const eventId = useRef(0)

  useEffect(() => {
    if (executionId == null) {
      setConnectionStatus('idle')
      return
    }

    setEvents([])
    setFrame(null)
    setSteps([])
    setVideoUrl(null)
    setStatus(null)
    setConnectionStatus('connecting')

    const token = api.getToken()
    const wsBase = API_BASE.replace(/^http/i, 'ws')
    const url =
      `${wsBase}/api/v1/mobile/executions/${executionId}/ws` +
      (token ? `?token=${encodeURIComponent(token)}` : '')

    let closed = false
    const ws = new WebSocket(url)
    wsRef.current = ws

    const push = (type: MobileLiveEventType, raw: Record<string, unknown>) => {
      setEvents((prev) =>
        [{ id: eventId.current++, type, message: describe(type, raw), time: new Date(), raw }, ...prev].slice(
          0,
          MAX_EVENTS,
        ),
      )
    }

    ws.onopen = () => setConnectionStatus('live')

    ws.onmessage = (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.data as string)
      } catch {
        return
      }
      const type = msg.event as MobileLiveEventType | 'frame'

      // Frames are high frequency; they update the preview only and are kept
      // out of the event log entirely.
      if (type === 'frame') {
        const b64 = msg.frame_b64 as string | undefined
        if (b64) setFrame(`data:${(msg.mime_type as string) || 'image/png'};base64,${b64}`)
        return
      }

      push(type, msg)

      if (type === 'status' && msg.status) {
        setStatus(msg.status as MobileExecutionStatus)
      }
      if (type === 'step_completed') {
        // Replace by index rather than append — a step can be re-reported after
        // a heal, and duplicating it would misrepresent the run.
        setSteps((prev) => {
          const next = prev.filter((s) => s.step_index !== msg.step_index)
          next.push({
            step_index: msg.step_index as number,
            action: String(msg.action ?? ''),
            status: msg.status as MobileStepResult['status'],
            locator: null,
            resolved_locator: null,
            actual: (msg.actual as string) ?? null,
            duration_ms: (msg.duration_ms as number) ?? null,
            failure_id: null,
            healing_id: null,
          })
          return next.sort((a, b) => a.step_index - b.step_index)
        })
      }
      if (type === 'video_ready' && msg.url) {
        setVideoUrl(api.mobile.artifactUrl(msg.url as string))
      }
      if (type === 'execution_completed') {
        setStatus(msg.status as MobileExecutionStatus)
        setConnectionStatus('disconnected')
      }
    }

    ws.onerror = () => {
      if (!closed) setConnectionStatus('error')
    }
    ws.onclose = () => {
      if (!closed) setConnectionStatus((s) => (s === 'error' ? 'error' : 'disconnected'))
    }

    /**
     * A short run can finish before this socket connects, so its terminal event
     * is never delivered. Reconcile against REST rather than spinning forever.
     */
    api.mobile
      .getExecution(executionId)
      .then((exec) => {
        if (closed || !exec) return
        setStatus((current) => current ?? exec.status)
        if (exec.step_results?.length) {
          setSteps((prev) => (prev.length ? prev : exec.step_results!))
        }
      })
      .catch(() => {
        /* the socket remains the primary source of truth */
      })

    return () => {
      closed = true
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      // 1000 = normal closure; anything else shows up as an error server-side.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000)
      wsRef.current = null
    }
  }, [executionId])

  const isTerminal = status != null && MOBILE_TERMINAL_STATUSES.includes(status)

  const disconnect = useCallback(() => {
    wsRef.current?.close(1000)
    wsRef.current = null
    setConnectionStatus('idle')
  }, [])

  return { connectionStatus, events, frame, status, steps, videoUrl, isTerminal, disconnect }
}
