import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ClientToServerEvents,
  DriverLocationPing,
  ServerToClientEvents,
} from "@medrush/contracts";
import { API_BASE_URL } from "./env";
import { api } from "./api";
import { useAuth } from "./auth";
import { qk, useActiveDelivery } from "./queries";

/**
 * Real-time dispatch layer (§7.3). One socket, opened while signed in:
 *  - `offer:new`       → buzz + sound cue + refresh the offers list (Home surfaces it)
 *  - `offer:cancelled` → refresh offers (another driver won / it expired)
 *  - `order:status`    → refresh the active delivery
 *
 * The server auto-joins a DRIVER connection to its own `driver:{profileId}`
 * room, so no client-side join is needed. While a delivery is active, the app
 * streams GPS: `location:update` over the socket, with an HTTP batch fallback.
 */

interface DispatchState {
  connected: boolean;
  /** Bumped each time an offer arrives — screens can react (e.g. auto-navigate). */
  offerPing: number;
}

const DispatchContext = createContext<DispatchState>({ connected: false, offerPing: 0 });

/** Strong, repeated buzz so an offer is felt with the phone in a pocket/mount. */
function alertOffer(): void {
  Vibration.vibrate([0, 400, 200, 400, 200, 400], false);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}

export function DispatchProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const client = useQueryClient();
  const { data: active } = useActiveDelivery(!!token);
  const [connected, setConnected] = useState(false);
  const [offerPing, setOfferPing] = useState(0);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  // ── socket lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(API_BASE_URL, {
      auth: { token },
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));

    socket.on("offer:new", () => {
      alertOffer();
      setOfferPing((n) => n + 1);
      void client.invalidateQueries({ queryKey: qk.offers });
    });
    socket.on("offer:cancelled", () => {
      void client.invalidateQueries({ queryKey: qk.offers });
    });
    socket.on("order:status", () => {
      void client.invalidateQueries({ queryKey: qk.active });
    });

    return () => {
      socket.off();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [token, client]);

  // ── GPS streaming while a delivery is active (foreground) ──────────────────
  useEffect(() => {
    if (!active) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5_000, distanceInterval: 20 },
        (pos) => {
          const ping: DriverLocationPing = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            ts: new Date(pos.timestamp).toISOString(),
          };
          const socket = socketRef.current;
          if (socket?.connected) {
            socket.emit("location:update", { lat: ping.lat, lng: ping.lng, ts: ping.ts });
          } else {
            // Socket down — HTTP batch fallback (held in memory server-side, §11).
            void api.post("/v1/driver/location", { points: [ping] }).catch(() => undefined);
          }
        },
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active]);

  // ── refresh active on app foreground (missed socket events while backgrounded)
  useEffect(() => {
    const listener = AppState.addEventListener("change", (s) => {
      if (s === "active") void client.invalidateQueries({ queryKey: qk.active });
    });
    return () => listener.remove();
  }, [client]);

  return (
    <DispatchContext.Provider value={{ connected, offerPing }}>{children}</DispatchContext.Provider>
  );
}

export function useDispatch(): DispatchState {
  return useContext(DispatchContext);
}
