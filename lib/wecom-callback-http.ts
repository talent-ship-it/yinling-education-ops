import { createWeComCallbackCrypto, type WeComCallbackCrypto } from "./wecom-callback-crypto";

export const WECOM_CALLBACK_MAX_BODY_BYTES = 6 * 1024 * 1024;

export type WecomCallbackHttpConfiguration = Readonly<{
  ready: boolean;
  invalid: boolean;
  missing: readonly (
    | "WECOM_CALLBACK_TOKEN"
    | "WECOM_CALLBACK_ENCODING_AES_KEY"
    | "WECOM_CORP_ID"
  )[];
  crypto: WeComCallbackCrypto | null;
}>;

export function wecomCallbackHttpConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WecomCallbackHttpConfiguration {
  const token = env.WECOM_CALLBACK_TOKEN?.trim() ?? "";
  const encodingAESKey = env.WECOM_CALLBACK_ENCODING_AES_KEY?.trim() ?? "";
  const receiveId = env.WECOM_CORP_ID?.trim() ?? "";
  const missing: WecomCallbackHttpConfiguration["missing"][number][] = [];
  if (!token) missing.push("WECOM_CALLBACK_TOKEN");
  if (!encodingAESKey) missing.push("WECOM_CALLBACK_ENCODING_AES_KEY");
  if (!receiveId) missing.push("WECOM_CORP_ID");
  if (missing.length) return Object.freeze({ ready: false, invalid: false, missing: Object.freeze(missing), crypto: null });
  try {
    return Object.freeze({
      ready: true,
      invalid: false,
      missing: Object.freeze([]),
      crypto: createWeComCallbackCrypto({ token, encodingAESKey, receiveId }),
    });
  } catch {
    return Object.freeze({ ready: false, invalid: true, missing: Object.freeze(missing), crypto: null });
  }
}

/** Extract only the standard encrypted callback field; decrypted XML is never evaluated. */
export function encryptedWecomXmlField(xml: string) {
  if (!xml || Buffer.byteLength(xml, "utf8") > WECOM_CALLBACK_MAX_BODY_BYTES) return null;
  const matches = [...xml.matchAll(/<Encrypt>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/Encrypt>/gu)];
  if (matches.length !== 1) return null;
  const encrypted = (matches[0]?.[1] ?? matches[0]?.[2] ?? "").trim();
  return encrypted || null;
}
