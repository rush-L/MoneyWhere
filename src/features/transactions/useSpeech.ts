import { useCallback, useRef, useState } from 'react'

// The DOM lib has no SpeechRecognition types; only what we use.
interface Rec {
  lang: string
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
const Ctor = (): (new () => Rec) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

const MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the browser site settings, or type the transaction.',
  'service-not-allowed': 'Microphone access was blocked. Allow it in the browser site settings, or type the transaction.',
  network: 'Voice entry needs an internet connection. Type the transaction instead.',
  'no-speech': 'Did not hear anything. Tap Speak and try again.',
}

/** One-shot dictation. Audio is handled by the browser's recognizer (Chrome sends it to Google), so it needs a connection. */
export function useSpeech(onText: (text: string) => void) {
  const supported = typeof window !== 'undefined' && !!Ctor()
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Rec | null>(null)

  const start = useCallback(
    (lang: string) => {
      const R = Ctor()
      if (!R) return
      rec.current?.stop()
      const r = new R()
      r.lang = lang
      r.interimResults = false
      r.onresult = (e) => { const t = e.results[0]?.[0]?.transcript; if (t) onText(t) }
      r.onerror = (e) => setError(MESSAGES[e.error] ?? 'Voice entry failed. Type the transaction instead.')
      r.onend = () => setListening(false)
      setError(null)
      try {
        r.start() // may throw/err if the browser wants a tap first; the Speak button is the fallback
        rec.current = r
        setListening(true)
      } catch {
        setError('Tap Speak to start the microphone.')
      }
    },
    [onText],
  )
  const stop = useCallback(() => rec.current?.stop(), [])
  return { supported, listening, error, start, stop }
}
