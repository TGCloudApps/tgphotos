import type { Translation } from "@tgcloud/ui/i18n";
import type src from "./pt-BR";
import base from "./parts/base.en";
import mobile from "./parts/mobile.en";
import desktop from "./parts/desktop.en";
import media from "./parts/media.en";

export default { ...base, ...mobile, ...desktop, ...media } satisfies Translation<typeof src>;
