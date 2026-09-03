import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

export type I18nKey = keyof typeof translations;

/**
 * Translation object for `common.name`.
 *
 * @param key I18n key
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Translation object for a `common.name` that carries a running number, e.g.
 * `Segment 3`. The plain {@link tName} cannot do it, and a template string
 * would hard-code English into the object tree — which is what the segment
 * channels did until 2.29.0 and what the state-role gate flags.
 *
 * Exactly ONE placeholder: adapter-core restarts from the untouched source
 * text for every argument, so a second `%s` would see the first substitution
 * overwritten. The substitution also only runs when the ENGLISH text carries
 * the placeholder — that is the trigger condition in adapter-core.
 *
 * @param key I18n key whose English text contains exactly one `%s`
 * @param arg The value to substitute
 */
export function tNameWith(key: I18nKey, arg: string | number): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key, arg);
}

/**
 * Translation object for `common.desc`.
 *
 * @param key I18n key
 */
export function tDesc(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Plain-string label in system language — for `common.states` VALUES and
 * user-facing messages (wizard / mqttAuth responses). Optional positional
 * args fill `%s` placeholders via adapter-core's I18n.translate.
 *
 * @param key I18n key
 * @param args Positional values substituted into `%s` placeholders, in order
 */
export function resolveLabel(key: I18nKey, ...args: (string | number)[]): string {
  return I18n.translate(key, ...args);
}
