"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Spinner } from "@/components/ui";

type Point = { lat: number; lng: number };

/** Ola key is optional — a set key swaps the free OSM raster for Ola vector tiles. */
const OLA_KEY = process.env.NEXT_PUBLIC_OLA_MAPS_KEY;

/** Keyless OpenStreetMap raster style — no token, adequate for low volume (§11). */
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const olaStyleUrl = (key: string): string =>
  `https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json?api_key=${key}`;

/* Marker tints — teal store, ink destination, accent driver (matches the design tokens). */
const STORE_COLOR = "#0D9488";
const DEST_COLOR = "#1F2937";
const DRIVER_COLOR = "#F59E0B";

/** store → (driver) → destination as a GeoJSON line feature. */
function routeFeature(store: Point, destination: Point, driver: Point | null) {
  const coordinates = driver
    ? [
        [store.lng, store.lat],
        [driver.lng, driver.lat],
        [destination.lng, destination.lat],
      ]
    : [
        [store.lng, store.lat],
        [destination.lng, destination.lat],
      ];
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates },
  };
}

/**
 * Live tracking map (MapLibre GL). Renders the store, destination and (when
 * present) the moving driver, plus a thin route line between them. Fits the
 * bounds on first paint, then eases to follow the driver. SSR-unsafe — the page
 * mounts it via `next/dynamic` with `ssr:false`, and we still guard `window`.
 */
export function TrackMap({
  store,
  destination,
  driver,
}: {
  store: Point;
  destination: Point;
  driver: Point | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const storeMarker = useRef<maplibregl.Marker | null>(null);
  const destMarker = useRef<maplibregl.Marker | null>(null);
  const driverMarker = useRef<maplibregl.Marker | null>(null);
  const didFit = useRef(false);
  const [loaded, setLoaded] = useState(false);

  // Create the map exactly once; tear it down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (typeof window === "undefined" || !container) return;
    const map = new maplibregl.Map({
      container,
      style: OLA_KEY ? olaStyleUrl(OLA_KEY) : OSM_STYLE,
      center: [store.lng, store.lat],
      zoom: 12,
    });
    mapRef.current = map;
    const onLoad = () => setLoaded(true);
    map.on("load", onLoad);
    return () => {
      map.remove();
      mapRef.current = null;
      storeMarker.current = null;
      destMarker.current = null;
      driverMarker.current = null;
      didFit.current = false;
      setLoaded(false);
    };
    // Init-once: initial center comes from the first `store`; later updates flow
    // through the sync effect below.
  }, []);

  // Sync markers, route and camera whenever coordinates change (post style-load).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    if (!storeMarker.current) {
      storeMarker.current = new maplibregl.Marker({ color: STORE_COLOR })
        .setLngLat([store.lng, store.lat])
        .addTo(map);
    } else {
      storeMarker.current.setLngLat([store.lng, store.lat]);
    }

    if (!destMarker.current) {
      destMarker.current = new maplibregl.Marker({ color: DEST_COLOR })
        .setLngLat([destination.lng, destination.lat])
        .addTo(map);
    } else {
      destMarker.current.setLngLat([destination.lng, destination.lat]);
    }

    if (driver) {
      if (!driverMarker.current) {
        driverMarker.current = new maplibregl.Marker({ color: DRIVER_COLOR })
          .setLngLat([driver.lng, driver.lat])
          .addTo(map);
      } else {
        driverMarker.current.setLngLat([driver.lng, driver.lat]);
      }
    } else if (driverMarker.current) {
      driverMarker.current.remove();
      driverMarker.current = null;
    }

    const data = routeFeature(store, destination, driver);
    const existing = map.getSource<maplibregl.GeoJSONSource>("route");
    if (existing) {
      existing.setData(data);
    } else {
      map.addSource("route", { type: "geojson", data });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": STORE_COLOR, "line-width": 3, "line-opacity": 0.55 },
      });
    }

    if (!didFit.current) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([store.lng, store.lat]);
      bounds.extend([destination.lng, destination.lat]);
      if (driver) bounds.extend([driver.lng, driver.lat]);
      map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
      didFit.current = true;
    } else if (driver) {
      // Keep the moving driver comfortably in view without a jarring jump.
      map.easeTo({ center: [driver.lng, driver.lat], duration: 800 });
    }
  }, [loaded, store.lat, store.lng, destination.lat, destination.lng, driver?.lat, driver?.lng]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      )}
    </div>
  );
}
