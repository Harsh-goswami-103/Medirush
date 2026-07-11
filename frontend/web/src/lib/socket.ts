"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { orderRoom, type ServerToClientEvents } from "@medrush/contracts";
import { API_BASE_URL } from "./env";
import { useAuth } from "./auth";

/**
 * Live tracking for one order (§7.3). Connects with the bearer token and joins
 * the `order:{id}` room on demand (server ownership-checks the join); on
 * `order:status` it invalidates the order + track queries so the UI reflects the
 * new state. Polling is the fallback while disconnected.
 */
export function useOrderLive(orderId: string | undefined): { connected: boolean } {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token || !orderId) return;
    const socket: Socket<ServerToClientEvents> = io(API_BASE_URL, {
      auth: { token },
      transports: ["websocket"],
    });
    const invalidateOrder = () => {
      void qc.invalidateQueries({ queryKey: ["order", orderId] });
      void qc.invalidateQueries({ queryKey: ["order-track", orderId] });
    };
    // A status transition also writes a notification server-side — refresh the
    // bell badge + center immediately rather than waiting on the 30s poll.
    const onStatus = () => {
      invalidateOrder();
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    };
    socket.on("connect", () => {
      setConnected(true);
      // `join` is a raw server listener, not part of the typed client contract.
      (socket as unknown as { emit: (ev: string, room: string) => void }).emit(
        "join",
        orderRoom(orderId),
      );
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("order:status", onStatus);
    socket.on("driver:location", invalidateOrder);

    return () => {
      socket.off();
      socket.disconnect();
      setConnected(false);
    };
  }, [token, orderId, qc]);

  return { connected };
}
