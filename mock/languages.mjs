// @ts-check

/** Mirrors the API's `STT37_LANGUAGES` (`provider_language_features.rs`): the languages that apply key terms and a prompt. */
export const STT37_LANGUAGES = [
  'af',
  'ar',
  'ca',
  'da',
  'de',
  'de_ch',
  'en',
  'en_au',
  'en_uk',
  'en_us',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'gl',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'mr',
  'nl',
  'nn',
  'no',
  'pt',
  'ro',
  'ru',
  'sv',
  'tr',
  'ur',
  'vi',
  'zh',
];

/** The rest of the API's `SOURCE_LANGUAGES`: languages the provider serves without key terms or prompt. */
export const UNIVERSAL_2_LANGUAGES = [
  'am',
  'as',
  'az',
  'ba',
  'be',
  'bg',
  'bn',
  'bo',
  'br',
  'bs',
  'cs',
  'cy',
  'el',
  'eu',
  'fo',
  'gu',
  'ha',
  'haw',
  'hr',
  'ht',
  'hu',
  'hy',
  'id',
  'is',
  'jw',
  'ka',
  'kk',
  'km',
  'kn',
  'la',
  'lb',
  'ln',
  'lo',
  'lt',
  'lv',
  'mg',
  'mi',
  'mk',
  'ml',
  'mn',
  'ms',
  'mt',
  'my',
  'ne',
  'oc',
  'pa',
  'pl',
  'ps',
  'sa',
  'sd',
  'si',
  'sk',
  'sl',
  'sn',
  'so',
  'sq',
  'sr',
  'su',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'tk',
  'tl',
  'tt',
  'uk',
  'uz',
  'yi',
  'yo',
];

/**
 * @param {unknown} value
 * @returns {string}
 */
function code(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasTerms(value) {
  return Array.isArray(value) && value.some((term) => typeof term === 'string' && term.trim() !== '');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether typed key terms or a prompt are refused for the language: an explicit source language outside
 * `STT37_LANGUAGES`, or an expected set with no STT-3.7 code. Unknown codes, saved context and blank text are not.
 * @param {Record<string, unknown>} options
 * @returns {boolean}
 */
export function refusesTypedContext(options) {
  if (!(
    hasTerms(options['keyterms_prompt']) ||
    hasTerms(options['one_off_keyterms']) ||
    hasText(options['prompt']) ||
    hasText(options['one_off_prompt'])
  )) {
    return false;
  }
  const language = code(options['language_code']);
  const expected = Array.isArray(options['expected_languages'])
    ? options['expected_languages'].map(code).filter((entry) => entry !== '')
    : [];
  const codes = language === '' ? expected : [language];
  if (codes.length === 0) return false;
  if (codes.some((entry) => !STT37_LANGUAGES.includes(entry) && !UNIVERSAL_2_LANGUAGES.includes(entry))) return false;
  return codes.every((entry) => !STT37_LANGUAGES.includes(entry));
}
