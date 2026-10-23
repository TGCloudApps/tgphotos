import type { Translation } from "@tgcloud/ui/i18n";
import type src from "./pt-BR";
import base from "./parts/base.es";
import mobile from "./parts/mobile.es";
import desktop from "./parts/desktop.es";
import media from "./parts/media.es";

export default { ...base, ...mobile, ...desktop, ...media } satisfies Translation<typeof src>;
