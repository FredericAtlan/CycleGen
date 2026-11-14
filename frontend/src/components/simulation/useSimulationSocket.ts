"use client";

import { useEffect, useRef } from "react";
import type { SimulationFrame } from "@/lib/types";
import { emitApiActivity } from "@/lib/apiActivity";

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
  /** Fired before a reconnect attempt so callers can clear duplicated live frames. */
  onReconnect?: () => void;
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
  onReconnect,
}: UseSimulationSocketOptions): void {
  const onFrameRef = useRef(onFrame);
  const onStatusRef = useRef(onStatus);
  const onEndRef = useRef(onEnd);
  const onReconnectRef = useRef(onReconnect);
  onFrameRef.current = onFrame;
  onStatusRef.current = onStatus;
  onEndRef.current = onEnd;
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    if (!enabled || !url) return;

    let ws: WebSocket | null = null;
    let closedIntentionally = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let didReconnect = false;
    let frameCount = 0;
    let lastFrameLog = 0;

    const connect = (isReconnect: boolean) => {
      if (isReconnect) {
        onReconnectRef.current?.();
      }
      onStatusRef.current(isReconnect ? "reconnecting" : "connecting");
      emitApiActivity({
        level: "ws",
        label: isReconnect
          ? "WebSocket · reconnexion…"
          : "WebSocket · ouverture…",
        detail: url,
      });
      try {
        ws = new WebSocket(url);
      } catch {
        onStatusRef.current("error", "Failed to open WebSocket");
        emitApiActivity({
          level: "error",
          label: "WebSocket · échec d’ouverture",
          detail: url,
        });
        return;
      }

      ws.onopen = () => {
        onStatusRef.current("open");
        frameCount = 0;
        lastFrameLog = 0;
        emitApiActivity({
          level: "ws",
          label: "WebSocket · connecté",
          status: "OPEN",
          detail: url,
        });
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
            emitApiActivity({
              level: "ws",
              label: "WebSocket · fin de flux",
              status: typeof data.status === "string" ? data.status : "end",
              bytesHint: `${frameCount} frames`,
            });
            onEndRef.current?.(
              typeof data.status === "string" ? data.status : undefined
            );
            return;
          }
          const frame = data as SimulationFrame;
          if (typeof frame.t === "number" && typeof frame.v === "number") {
            frameCount += 1;
            if (frameCount === 1) {
              emitApiActivity({
                level: "ws",
                label: "WebSocket · 1ʳᵉ frame reçue",
                bytesHint: `t=${frame.t.toFixed(1)} s · v=${(frame.v * 3.6).toFixed(1)} km/h`,
              });
              lastFrameLog = frameCount;
            } else if (frameCount - lastFrameLog >= 50) {
              emitApiActivity({
                level: "ws",
                label: "WebSocket · flux",
                bytesHint: `${frameCount} frames · t=${frame.t.toFixed(0)} s`,
              });
              lastFrameLog = frameCount;
            }
            onFrameRef.current(frame);
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onerror = () => {
        onStatusRef.current("error", "WebSocket error");
        emitApiActivity({
          level: "error",
          label: "WebSocket · erreur",
          detail: url,
        });
      };

      ws.onclose = () => {
        if (closedIntentionally) {
          onStatusRef.current("closed");
          emitApiActivity({
            level: "ws",
            label: "WebSocket · fermé",
            status: "CLOSED",
            bytesHint: frameCount ? `${frameCount} frames` : undefined,
          });
          return;
        }
        onStatusRef.current(
          "closed",
          "Connection lost — attempting reconnect…"
        );
        emitApiActivity({
          level: "warn",
          label: "WebSocket · coupure — reconnexion…",
          detail: url,
        });
        if (!didReconnect) {
          didReconnect = true;
          reconnectTimer = setTimeout(() => connect(true), 1200);
        } else {
          onStatusRef.current(
            "error",
            "WebSocket disconnected. Stop & consolidate, or restart simulation."
          );
          emitApiActivity({
            level: "error",
            label: "WebSocket · déconnecté",
            detail: "Reconnexion échouée — consolider ou relancer",
          });
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
