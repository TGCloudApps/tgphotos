import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Boot, Spinner } from "@tgcloud/ui/ui/Boot";
import { queryClient } from "./core/data";

const MobileApp = lazy(() => import("./mobile/MobileApp"));
const DesktopApp = lazy(() => import("./desktop/DesktopApp"));

export default function App() {
  return (
    <Boot
      // Vault novo: nada do anterior pode sobrar no cache das consultas.
      onEnter={() => queryClient.clear()}
      main={(session, shell) => (
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={<Spinner />}>{shell === "mobile" ? <MobileApp session={session} /> : <DesktopApp session={session} />}</Suspense>
        </QueryClientProvider>
      )}
    />
  );
}
