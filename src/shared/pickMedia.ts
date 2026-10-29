import { canUseVault } from "@tgcloud/ui/core/vaultPermissions";
/** Native media picker shared by platform shells. */
import { transfers } from "@tgcloud/ui/core/transfers";
import { openFiles } from "@tgcloud/ui/core/fileDialog";
import { t } from "../i18n";

/** Extensions accepted in the native picker. */
const MEDIA_EXT = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "dng", "raw", "cr2", "nef", "arw", "mp4", "mov", "m4v", "3gp", "mkv", "webm", "avi"];

export async function pickNative(directory: boolean, album: number) {
  if (!canUseVault("write")) return;
  const picked = await openFiles({
    multiple: !directory,
    directory,
    title: directory ? t("desktop.pickFolder") : t("desktop.pickMedia"),
    filters: directory ? undefined : [{ name: t("desktop.mediaFilter"), extensions: MEDIA_EXT }],
  });
  if (!picked) return;
  void transfers.uploadPaths(Array.isArray(picked) ? picked : [picked], album);
}
