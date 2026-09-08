/**
 * Optional cinematic narration via the browser's SpeechSynthesis API.
 *
 * Rules baked in:
 *  - never mandatory: the UI is fully legible with voice off
 *  - never crashes if SpeechSynthesis is missing
 *  - only speaks lines explicitly marked important (deduped by key)
 */

import { useCallback, useEffect, useRef, useState } from 'react';

function synth(): SpeechSynthesis | null {
  const g = globalThis as { speechSynthesis?: SpeechSynthesis };
  return g.speechSynthesis ?? null;
}
const SUPPORTED = synth() != null;

export interface Narration {
  supported: boolean;
  enabled: boolean;
  toggle: () => void;
  setEnabled: (on: boolean) => void;
  /** Speak once per unique `key`. No-op when disabled or unsupported. */
  say: (key: string, text: string) => void;
  /** Clear the spoken-key memory (call on reset). */
  reset: () => void;
}

export function useNarration(): Narration {
  const [enabled, setEnabled] = useState(false);
  const spokenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      if (SUPPORTED) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const say = useCallback(
    (key: string, text: string) => {
      const s = synth();
      if (!enabled || !s) return;
      if (spokenRef.current.has(key)) return;
      spokenRef.current.add(key);
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.02;
        u.pitch = 1;
        u.volume = 0.9;
        s.speak(u);
      } catch {
        /* a failed utterance must never break the demo */
      }
    },
    [enabled],
  );

  const reset = useCallback(() => {
    spokenRef.current.clear();
    if (SUPPORTED) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const toggle = useCallback(() => {
    setEnabled((on) => {
      if (on && SUPPORTED) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
      return !on;
    });
  }, []);

  return { supported: SUPPORTED, enabled, toggle, setEnabled, say, reset };
}
