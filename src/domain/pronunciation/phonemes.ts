/**
 * Azure Pronunciation Assessment reports phonemes either as IPA (when PhonemeAlphabet=IPA is
 * supported for the locale) or in the SAPI phone set. Everything downstream works in IPA.
 */
const SAPI_TO_IPA: Record<string, string> = {
  aa: 'ɑ', ae: 'æ', ah: 'ʌ', ao: 'ɔ', aw: 'aʊ', ax: 'ə', ay: 'aɪ', b: 'b', ch: 'tʃ', d: 'd',
  dh: 'ð', eh: 'ɛ', er: 'ɝ', ey: 'eɪ', f: 'f', g: 'ɡ', h: 'h', hh: 'h', ih: 'ɪ', iy: 'i',
  jh: 'dʒ', k: 'k', l: 'l', m: 'm', n: 'n', ng: 'ŋ', ow: 'oʊ', oy: 'ɔɪ', p: 'p', r: 'r',
  s: 's', sh: 'ʃ', t: 't', th: 'θ', uh: 'ʊ', uw: 'u', v: 'v', w: 'w', y: 'j', z: 'z', zh: 'ʒ',
};

/** Canonicalise IPA variants the service may emit (length marks, rhotic vowels, ASCII g). */
const IPA_CANON: Record<string, string> = {
  'iː': 'i', 'uː': 'u', 'ɑː': 'ɑ', 'ɔː': 'ɔ', 'ɜː': 'ɝ', 'ɜ': 'ɝ', 'ɚ': 'ɝ', g: 'ɡ', 'ɹ': 'r', 'ɾ': 'r',
};

export function toIpa(phone: string): string {
  const p = phone.trim().toLowerCase();
  const fromSapi = SAPI_TO_IPA[p];
  if (fromSapi) return fromSapi;
  return IPA_CANON[phone.trim()] ?? phone.trim();
}

const VOWELS = new Set(['ɑ', 'æ', 'ʌ', 'ɔ', 'aʊ', 'ə', 'aɪ', 'ɛ', 'ɝ', 'eɪ', 'ɪ', 'i', 'oʊ', 'ɔɪ', 'ʊ', 'u']);

export function isVowel(ipa: string): boolean {
  return VOWELS.has(ipa);
}
