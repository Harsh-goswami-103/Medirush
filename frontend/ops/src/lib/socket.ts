"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AlertEvent,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@medrush/contracts";
import { API_BASE_URL } from "./env";
import { useAuth } from "./auth";
import { useToast } from "@/components/toast";

/**
 * Live ops board (BLUEPRINT §7.3). The server auto-joins INVENTORY/ADMIN sockets
 * to the `ops` room on connect, so we just handshake with the bearer token and
 * react to room events: `order:new`/`order:update` refresh the board query,
 * `order:new` also chimes, and `alert` shows a toast. Returns the connection
 * state so the board can show a Live/Reconnecting indicator (polling is the
 * fallback while disconnected).
 */

type OpsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useOpsLiveBoard(): { connected: boolean } {
  const { token } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) return;
    const socket: OpsSocket = io(API_BASE_URL, {
      auth: { token },
      transports: ["websocket"],
    });

    const refresh = () => void qc.invalidateQueries({ queryKey: ["ops-orders"] });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("order:new", () => {
      refresh();
      chime();
    });
    socket.on("order:update", refresh);
    socket.on("alert", (e: AlertEvent) => toast.push({ type: "info", message: e.msg }));

    return () => {
      socket.off();
      socket.disconnect();
      setConnected(false);
    };
  }, [token, qc, toast]);

  return { connected };
}

/** Short synthesised chime for a new order (no audio asset shipped). */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.31);
    osc.onended = () => void ctx.close();
  } catch {
    // Audio blocked (no gesture yet) or unsupported — the visual refresh still fires.
  }
}
