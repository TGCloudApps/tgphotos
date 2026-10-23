import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Boot, Spinner } from "@tgcloud/ui/ui/Boot";
import { invoke } from "@tgcloud/ui/core/server";
import { queryClient } from "./core/data";

const MobileApp = lazy(() => import("./mobile/MobileApp"));
const DesktopApp = lazy(() => import("./desktop/DesktopApp"));

export default function App() {
  return (
    <Boot
      // New vault: nothing from the previous one may linger in the query cache.
      onEnter={() => {
        queryClient.clear();
        // Videos without duration/dimensions: Rust re-reads just the video index (off the open path).
        setTimeout(() => void invoke("video_repair").catch(() => {}), 15_000);
      }}
      main={(session, shell) => (
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={<Spinner />}>{shell === "mobile" ? <MobileApp session={session} /> : <DesktopApp session={session} />}</Suspense>
        </QueryClientProvider>
      )}
    />
  );
}
