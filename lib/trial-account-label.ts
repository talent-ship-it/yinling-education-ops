const GENERIC_TRIAL_ACCOUNT_LABEL = /^(?:[试视]听(?:学[员生]|账号)?|trial(?:student|account)?)([abc])(?:(?:校长号|账号|account)[\p{N}\p{M}]*|(?:year)?(?:19|20)\d{2})*$/u;

export function trialAccountLetter(value: unknown) {
  const label = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  if (/^试听学员a\(tara龙\)\s*2026$/u.test(label)) return "a";
  return label.replace(/[\s\p{P}\p{S}_]+/gu, "").match(GENERIC_TRIAL_ACCOUNT_LABEL)?.[1] ?? null;
}
