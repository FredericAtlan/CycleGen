import { Suspense } from "react";
import StudioHome from "@/components/StudioHome";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          Chargement…
        </div>
      }
    >
      <StudioHome />
    </Suspense>
  );
}
