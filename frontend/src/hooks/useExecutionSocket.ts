import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { API_BASE, api } from '../lib/api'
import type { ExecutionStatus } from '../lib/types'

/**
 * Live telemetry for one or more running executions.
 *
 * The worker emits over Socket.IO on the same origin as the REST API. A client
 * joins a room per execution id by emitting `subscribe`, then receives:
 *   queued | running | browser_log | agent_progress | telemetry |
 *   screenshot_uploaded | live_frame | execution_completed
 */

export type LiveConnectionStatus = 'idle' | 'connecting' | 'live' | 'disconnected' | 'error'

export type LiveEventType =
  | 'queued'
  | 'running'
  | 'browser_log'
  | 'agent_progress'
  | 'telemetry'
  | 'screenshot_uploaded'
  | 'execution_completed'

export type LiveEvent = {
  id: number
  type: LiveEventType
  message: string
  time: Date
}

export type LiveRunState = {
  executionId: string
  status: ExecutionStatus | 'QUEUED'
  durationMs: number
  videoUrl?: string
}

export type LiveSummary = {
  total: number
  passed: number
  failed: number
  durationMs: number
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'PASSED',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'Completed With Warnings',
])

function isSuccess(status: string): boolean {
  return status === 'PASSED' || status === 'COMPLETED' || status === 'Completed With Warnings'
}

function isFailure(status: string): boolean {
  return status === 'FAILED' || status === 'BLOCKED'
}

/** Keeps the socket feed bounded; the full log is persisted on the execution row. */
const MAX_EVENTS = 200

export function useExecutionSocket(executionIds: string[]) {
  // Compared by value so a caller passing a fresh array literal each render
  // does not tear down and rebuild the socket on every commit.
  const idsKey = executionIds.join(',')
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])

  const [connectionStatus, setConnectionStatus] = useState<LiveConnectionStatus>('idle')
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [frames, setFrames] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, LiveRunState>>({})
  const [running, setRunning] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const eventId = useRef(0)
  // Guards against double-counting a run that both reports `execution_completed`
  // and is found already-finished by the reconciliation fetch below.
  const settled = useRef(new Set<string>())

  useEffect(() => {
    if (ids.length === 0) {
      setConnectionStatus('idle')
      return
    }

    settled.current = new Set()
    setEvents([])
    setFrames({})
    setRuns(
      Object.fromEntries(
        ids.map((id) => [id, { executionId: id, status: 'QUEUED' as const, durationMs: 0 }]),
      ),
    )
    setRunning(true)
    setConnectionStatus('connecting')

    const socket = io(API_BASE)
    socketRef.current = socket

    const pushEvent = (type: LiveEventType, payload: unknown) => {
      const message =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message: unknown }).message)
          : JSON.stringify(payload)
      setEvents((prev) =>
        [{ id: eventId.current++, type, message, time: new Date() }, ...prev].slice(0, MAX_EVENTS),
      )
    }

    const settle = (id: string, status: string, durationMs: number) => {
      if (settled.current.has(id)) return
      settled.current.add(id)
      setRuns((prev) => ({
        ...prev,
        [id]: { ...prev[id], executionId: id, status: status as ExecutionStatus, durationMs },
      }))
      if (settled.current.size >= ids.length) setRunning(false)
    }

    /**
     * A short run can finish before this socket even connects, so its
     * `execution_completed` is never delivered. Reconcile against the REST
     * state on connect rather than leaving the UI spinning forever.
     */
    const reconcile = (id: string) => {
      api
        .getRunDetails(id)
        .then((run) => {
          if (!run) return
          if (run.videos?.length) {
            setFrames((prev) => ({ ...prev, [id]: run.videos[0].url }))
          }
          if (TERMINAL_STATUSES.has(run.status)) {
            settle(id, run.status, run.durationMs ?? 0)
          } else {
            setRuns((prev) => ({
              ...prev,
              [id]: { ...prev[id], executionId: id, status: run.status, durationMs: run.durationMs ?? 0 },
            }))
          }
        })
        .catch(() => {
          /* transient; the socket remains the primary source of truth */
        })
    }

    socket.on('connect', () => {
      setConnectionStatus('live')
      for (const id of ids) {
        socket.emit('subscribe', id)
        reconcile(id)
      }
    })

    socket.on('disconnect', () => setConnectionStatus('disconnected'))
    socket.on('connect_error', () => {
      setConnectionStatus('error')
      setRunning(false)
    })

    const passthrough: LiveEventType[] = [
      'queued',
      'running',
      'browser_log',
      'agent_progress',
      'telemetry',
    ]
    for (const type of passthrough) {
      socket.on(type, (payload: unknown) => pushEvent(type, payload))
    }

    socket.on('screenshot_uploaded', (payload: { executionId?: string; url?: string }) => {
      pushEvent('screenshot_uploaded', payload)
      if (payload?.url && payload.executionId) {
        setFrames((prev) => ({ ...prev, [payload.executionId as string]: payload.url as string }))
      }
    })

    socket.on('live_frame', (payload: { executionId?: string; frame?: string }) => {
      // Screencast frames arrive as raw base64 JPEG, several per second, and are
      // deliberately not pushed into the event feed.
      if (payload?.frame && payload.executionId) {
        setFrames((prev) => ({
          ...prev,
          [payload.executionId as string]: `data:image/jpeg;base64,${payload.frame}`,
        }))
      }
    })

    socket.on(
      'execution_completed',
      (payload: { executionId?: string; status?: string; durationMs?: number }) => {
        pushEvent('execution_completed', payload)
        const id = payload?.executionId
        if (!id) return
        settle(id, payload.status ?? 'FAILED', payload.durationMs ?? 0)
        // The video is uploaded after the event fires, so fetch the row again
        // to pick up its URL.
        api
          .getRunDetails(id)
          .then((run) => {
            if (run?.videos?.length) {
              setFrames((prev) => ({ ...prev, [id]: run.videos[0].url }))
            }
          })
          .catch(() => {})
      },
    )

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [ids])

  const summary = useMemo<LiveSummary>(() => {
    const values = Object.values(runs)
    return {
      total: ids.length,
      passed: values.filter((run) => isSuccess(run.status)).length,
      failed: values.filter((run) => isFailure(run.status)).length,
      durationMs: values.reduce((total, run) => total + (run.durationMs || 0), 0),
    }
  }, [runs, ids.length])

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect()
    socketRef.current = null
    setConnectionStatus('idle')
    setRunning(false)
  }, [])

  return {
    connectionStatus,
    events,
    frames,
    runs: useMemo(() => Object.values(runs), [runs]),
    summary,
    running,
    disconnect,
  }
}
