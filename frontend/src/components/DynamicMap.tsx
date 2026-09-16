"use client";

import dynamic from "next/dynamic";
import type { MapViewProps } from "./MapView";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-100 text-sm text-slate-500">
      Loading map…
    </div>
  ),
});

export default function DynamicMap(props: MapViewProps) {
  return <MapView {...props} />;
}
