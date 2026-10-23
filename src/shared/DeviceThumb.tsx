/** System thumbnail (Android) for a device media item, without network. */
import { useEffect, useState } from "react";
import { android } from "@tgcloud/ui/core/android";

export function DeviceThumb({ uri, size = 320, className = "" }: { uri: string; size?: number; className?: string }) {
  const [src, setSrc] = useState(() => android.deviceThumbNow(uri, size));
  useEffect(() => {
    if (src) return;
    let alive = true;
    void android.deviceThumb(uri, size).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [uri, size]);
  return src ? <img src={src} alt="" draggable={false} className={`size-full object-cover ${className}`} /> : <div className="size-full bg-s3" />;
}
