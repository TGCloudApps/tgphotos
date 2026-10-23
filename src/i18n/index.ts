/** `t` for the TGPhotos texts; the common vocabulary (common.*) comes from tg-ui as `tc`. */
import { defineMessages } from "@tgcloud/ui/i18n";
import src from "./pt-BR";
import en from "./en";
import es from "./es";

export const { t, rich } = defineMessages(src, { en, es });
export { t as tc } from "@tgcloud/ui/i18n/ui";
