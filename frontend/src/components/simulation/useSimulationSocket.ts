"use client";

import { useEffect, useRef } from "react";
import type { SimulationFrame } from "@/lib/types";

export type SimSocketStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error"
  | "reconnecting";

type UseSimulationSocketOptions = {
  url: string | null;
  enabled: boolean;
  onFrame: (frame: SimulationFrame) => void;
  onStatus: (status: SimSocketStatus, detail?: string) => void;
  /** Fired when the server sends `{ event: "end", status }` after the last frame. */
  onEnd?: (status?: string) => void;
};

/**
 * Connects to the simulation WebSocket and parses SimulationFrame JSON messages.
 * Attempts a single automatic reconnect after unexpected close.
 */
export function useSimulationSocket({
  url,
  enabled,
  onFrame,
  onStatus,
  onEnd,
}: UseSimulationSocketOptions): void {
  const onFrameRef = useRef(onFrame);
  const onStatusRef = useRef(onStatus);
  const onEndRef = useRef(onEnd);
  onFrameRef.current = onFrame;
  onStatusRef.current = onStatus;
  onEndRef.current = onEnd;

  useEffect(() => {
    if (!enabled || !url) return;

    let ws: WebSocket | null = null;
    let closedIntentionally = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let didReconnect = false;

    const connect = (isReconnect: boolean) => {
      onStatusRef.current(isReconnect ? "reconnecting" : "connecting");
      try {
        ws = new WebSocket(url);
      } catch {
        onStatusRef.current("error", "Failed to open WebSocket");
        return;
      }

      ws.onopen = () => {
        onStatusRef.current("open");
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(String(ev.data)) as
            | SimulationFrame
            | { event?: string; status?: string };
          if (
            data &&
            typeof data === "object" &&
            "event" in data &&
            data.event === "end"
          ) {
            onEndRef.current?.(
              typeof data.status === "string" ? data.status : undefined
            );
            return;
          }
          const frame = data as SimulationFrame;
          if (typeof frame.t === "number" && typeof frame.v === "number") {
            onFrameRef.current(frame);
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onerror = () => {
        onStatusRef.current("error", "WebSocket error");
      };

      ws.onclose = () => {
        if (closedIntentionally) {
          onStatusRef.current("closed");
          return;
        }
        onStatusRef.current(
          "closed",
          "Connection lost — attempting reconnect…"
        );
        if (!didReconnect) {
          didReconnect = true;
          reconnectTimer = setTimeout(() => connect(true), 1200);
        } else {
          onStatusRef.current(
            "error",
            "WebSocket disconnected. Stop & consolidate, or restart simulation."
          );
          // Prefer consolidating whatever the server already computed
          // rather than leaving the UI stuck on a partial live series.
          onEndRef.current?.("disconnected");
        }
      };
    };

    connect(false);

    return () => {
      closedIntentionally = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [url, enabled]);
}
