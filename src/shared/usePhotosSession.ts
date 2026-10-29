/** Photo session services: backups, device library, refresh and selection. */
import { useTransfers } from "@tgcloud/ui/core/transfers";
import { useUploads } from "@tgcloud/ui/core/uploads";
import { useEffect } from "react";
import { api } from "../core/api";
import { startBackup } from "../core/backup";
import { refreshSoon } from "../core/data";
import { startDevice } from "../core/deviceTrash";
import { loadLibrary, startLibrary } from "../core/library";
import { useRoute } from "../core/nav";
import { useSelection } from "../core/select";

export function usePhotosSession() {
  const route = useRoute();
  useEffect(() => {
    useUploads.setState({ onDone: refreshSoon });
    // Trash older than 30 days is deleted for good.
    api.housekeep().then((n) => n && refreshSoon()).catch(() => { });
    startBackup();
    startLibrary();
    startDevice();
  }, []);

  // The upload queue moved: what was uploaded leaves the local gallery (becomes vault media).
  const transfersList = useTransfers((s) => s.list);
  useEffect(() => {
    const t = setTimeout(() => void loadLibrary(), 1500);
    return () => clearTimeout(t);
  }, [transfersList]);

  // Changing screens clears the selection.
  useEffect(() => useSelection.getState().clear(), [route.dest, route.album]);

}
