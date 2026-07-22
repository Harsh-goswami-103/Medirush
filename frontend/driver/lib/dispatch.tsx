import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, Vibration, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ClientToServerEvents,
  DriverLocationPing,
  ServerToClientEvents,
} from "@medrush/contracts";
import { Txt } from "../components/ui";
import { API_BASE_URL } from "./env";
import { api } from "./api";
import { useAuth } from "./auth";
import {
  isBackgroundLocationAvailable,
  startBackgroundTracking,
  stopBackgroundTracking,
} from "./backgroundLocation";
import {
  getLocationSinkState,
  setBackgroundLocationSender,
  subscribeLocationSink,
  type LocationSinkState,
} from "./locationSink";
import { qk, useActiveDelivery } from "./queries";
import { colors, font, radius, space } from "./theme";

/**
 * Real-time dispatch layer (§7.3). One socket, opened while signed in:
 *  - `offer:new`       → buzz + sound cue + refresh the offers list (Home surfaces it)
 *  - `offer:cancelled` → refresh offers (another driver won / it expired)
 *  - `order:status`    → refresh the active delivery
 *
 * The server auto-joins a DRIVER connection to its own `driver:{profileId}`
 * room, so no client-side join is needed. While a delivery is active, the app
 * streams GPS: `location:update` over the socket, with an HTTP batch fallback.
 * When the build supports it (lib/backgroundLocation.ts — next EAS build), a
 * foreground-service background stream keeps tracking alive with the phone
 * pocketed; permission denied → foreground-only + a persistent warning banner.
 */

interface DispatchState {
  connected: boolean;
  /** Bumped each time an offer arrives — screens can react (e.g. auto-navigate). */
  offerPing: number;
  /** Live-location telemetry (lib/locationSink.ts) — drives the tracking banner. */
  location: LocationSinkState;
}

const DispatchContext = createContext<DispatchState>({
  connected: false,
  offerPing: 0,
  location: getLocationSinkState(),
});

/** Strong, repeated buzz so an offer is felt with the phone in a pocket/mount. */
function alertOffer(): void {
  Vibration.vibrate([0, 400, 200, 400, 200, 400], false);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}

export function DispatchProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const { data: active } = useActiveDelivery(!!token);
  const [connected, setConnected] = useState(false);
  const [offerPing, setOfferPing] = useState(0);
  /** Background permission denied → tracking works only while foregrounded. */
  const [bgDenied, setBgDenied] = useState(false);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const location = useSyncExternalStore(subscribeLocationSink, getLocationSinkState);

  /** GPS should stream: signed in AND a delivery is in progress. */
  const tracking = !!token && !!active;

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

    // Background-task batches (lib/backgroundLocation.ts) reuse this socket.
    // Disconnected socket → DROP (never buffer stale pings); the sink counts
    // the loss. The Android foreground service keeps the JS process alive so
    // the socket normally stays connected.
    setBackgroundLocationSender((points) => {
      if (!socket.connected) return false;
      for (const p of points) {
        socket.emit("location:update", { lat: p.lat, lng: p.lng, ts: p.ts });
      }
      return true;
    });

    return () => {
      setBackgroundLocationSender(null);
      socket.off();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [token, client]);

  // ── GPS streaming while a delivery is active ────────────────────────────────
  // Foreground watcher always runs (today's behavior); when this build has the
  // background APIs, we additionally start a foreground-service stream so the
  // pings keep flowing with the phone pocketed. Delivery done/unassigned or
  // sign-out → tracking flips false → everything stops.
  useEffect(() => {
    if (!tracking) {
      setBgDenied(false);
      void stopBackgroundTracking();
      return;
    }
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

      // Background upgrade — no-op in the old dev client (module absent).
      if (cancelled || !isBackgroundLocationAvailable()) return;
      const result = await startBackgroundTracking(() => cancelled);
      if (cancelled) {
        // Effect cleaned up while the permission modal was up — its cleanup's
        // stop ran before anything could start, so stop again here to make
        // sure no orphaned foreground service outlives the delivery.
        void stopBackgroundTracking();
        return;
      }
      setBgDenied(result === "denied");
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      void stopBackgroundTracking();
    };
  }, [tracking]);

  // ── refresh active on app foreground (missed socket events while backgrounded)
  useEffect(() => {
    const listener = AppState.addEventListener("change", (s) => {
      if (s === "active") void client.invalidateQueries({ queryKey: qk.active });
    });
    return () => listener.remove();
  }, [client]);

  return (
    <DispatchContext.Provider value={{ connected, offerPing, location }}>
      <View style={{ flex: 1 }}>
        {children}
        {tracking && bgDenied ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: insets.top + space.sm,
              left: space.lg,
              right: space.lg,
              backgroundColor: colors.warningBg,
              borderColor: colors.warning,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingVertical: space.sm,
              paddingHorizontal: space.md,
            }}
          >
            <Txt size={font.xs} color="warning" weight="600" align="center">
              Background location is off — keep the app open for live tracking.
            </Txt>
          </View>
        ) : null}
      </View>
    </DispatchContext.Provider>
  );
}

export function useDispatch(): DispatchState {
  return useContext(DispatchContext);
}
