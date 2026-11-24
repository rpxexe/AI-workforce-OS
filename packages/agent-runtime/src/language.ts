// Which language a message is in, without a model: Indian scripts by Unicode block, Hindi written in
// Roman script (Hinglish) by its common words. Cheap enough to run on every message and every read.
import type { DetectedLanguage } from "@workforce/shared";

const SCRIPTS: [DetectedLanguage, RegExp][] = [
  ["hi", /[ऀ-ॿ]/g], // Devanagari: Hindi (also Marathi, Nepali; counted as Hindi)
  ["bn", /[ঀ-৿]/g],
  ["pa", /[਀-੿]/g],
  ["gu", /[઀-૿]/g],
  ["or", /[଀-୿]/g],
  ["ta", /[஀-௿]/g],
  ["te", /[ఀ-౿]/g],
  ["kn", /[ಀ-೿]/g],
  ["ml", /[ഀ-ൿ]/g],
];

// Common Hindi words as people type them in Roman script. Words that are also everyday English
// (to, me, is, us, do, the, main, par, hi, ho) are left out so English is not mistaken for Hinglish.
export const ROMAN_HINDI = new Set(
  `hai hain tha thi nahi nahin nhi na kya kyu kyun kyon kaise kaisa kaisi kab kahan kahaan kaha kitna kitne kitni kaun kon
  mera meri mere mujhe mujhko humko hum hamara hamari hamare aap aapka aapki aapke aapko apna apni apne tum tumhara mai mein
  ko ka ki ke se bhi toh aur ya lekin magar ab abhi kal aaj parso parson jaldi der bahut bohot bahot thoda zyada jyada
  accha acha achha achchha theek thik sahi galat haan haanji ji bhai bhaiya didi yaar karo karna karne kariye karein karenge
  karunga karungi kar kiya kiye gaya gayi gaye gya hua hui hue hoga hogi honge raha rahi rahe rha rhi chahiye chaiye chahta
  chahti dijiye dena dedo lena lelo milega milegi mila mili bata batao bataiye bataye samajh samjha pata paisa paise rupaye
  wala wali wale waala aaya aayi aaye aayega aayegi ayega bhej bhejo bhejiye bheja sab kuch kuchh koi kisi yeh ye woh wo vo
  isko usko inka unka liye sath saath pehle baad matlab shukriya dhanyavad dhanyavaad dhanyawad namaste namaskar arre arey
  badhiya bekar bekaar ghatiya bakwas bakwaas wapas vapas naam kab tak hoon hun hu kahin nahi`.split(/\s+/),
);

// Everyday English, including words Indian customers keep in English inside Hindi sentences.
const ENGLISH = new Set(
  `the a an is are was were be been am i you he she it we they my your our their me him her us them this that these those
  what which who when where why how do does did have has had will would can could should may might not no yes and or but if
  then so because to of in on at by for with from about as into up out over please thanks thank sorry hello hi hey ok okay
  sure good bad want need get got order delivery refund payment money account address number phone product price problem
  issue booking book cancel return status today tomorrow yesterday time call help customer service still yet received sent
  paid done there here all just very much more now`.split(/\s+/),
);

export type LanguageGuess = { language: DetectedLanguage; codeSwitched: boolean };

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** The language of one message. `codeSwitched`: it mixes languages or scripts within itself. */
export function detectLanguage(text: string): LanguageGuess {
  const latin = count(text, /[a-z]/gi);
  const indic = SCRIPTS.map(([language, re]) => ({ language, letters: count(text, re) })).sort((a, b) => b.letters - a.letters)[0]!;
  const letters = count(text, /\p{L}/gu);
  if (letters === 0) return { language: "unknown", codeSwitched: false };

  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const english = words.filter((w) => ENGLISH.has(w) && !ROMAN_HINDI.has(w)).length;
  if (indic.letters > 0) {
    // A few Latin letters (an order id, "OK") do not make a message mixed; English words do.
    const mixed = latin >= 2 && (english > 0 || latin >= indic.letters / 4);
    if (!mixed) return { language: indic.language, codeSwitched: false };
    return { language: indic.language === "hi" ? "hinglish" : indic.language, codeSwitched: true };
  }
  if (latin === 0) return { language: "other", codeSwitched: false };

  const hindi = new Set(words.filter((w) => ROMAN_HINDI.has(w))).size;
  if (hindi >= 2 || (hindi === 1 && words.length <= 2)) return { language: "hinglish", codeSwitched: english > 0 || words.length > hindi * 2 };
  // shortcut: other Latin-script languages (Spanish, French...) are "other" only when no English word appears; use a real detector when employees serve them at scale
  if (english > 0 || words.length <= 2) return { language: "en", codeSwitched: false };
  return { language: "other", codeSwitched: false };
}

/** Per-message languages, how often the language changed, and the language used most (ties: the earlier one). */
export function languageProfile(texts: string[]) {
  const guesses = texts.map(detectLanguage);
  const known = guesses.filter((g) => g.language !== "unknown");
  let switches = 0;
  for (let i = 1; i < known.length; i++) if (known[i]!.language !== known[i - 1]!.language) switches++;
  const counts = new Map<DetectedLanguage, number>();
  for (const g of known) counts.set(g.language, (counts.get(g.language) ?? 0) + 1);
  const languages = [...counts].map(([language, messages]) => ({ language, messages })).sort((a, b) => b.messages - a.messages);
  return {
    guesses,
    primaryLanguage: languages[0]?.language ?? ("unknown" as DetectedLanguage),
    languages,
    switches,
    codeSwitchedMessages: guesses.filter((g) => g.codeSwitched).length,
  };
}
