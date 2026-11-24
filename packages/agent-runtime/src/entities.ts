// Structured extraction of business entities from what customers write, in English, Hindi and Hinglish:
// names, phone numbers, addresses and PIN codes, order ids, dates, times, amounts (lakh, crore, ₹),
// GSTIN, IFSC, UPI ids, payment methods. Deterministic: regular expressions, no model.
//
// `region` is the business's operational locale (from the employee's settings), never a guess about the
// customer: with "IN", a bare 10-digit mobile number gets +91 and an amount without a currency is rupees.
import { governmentIds, type EntityType } from "@workforce/shared";

export type ExtractedEntity = { type: EntityType; text: string; value: string; details?: Record<string, string> };
export type ExtractContext = { region?: string | null; timezone?: string; now?: Date };

/** The business's operating region from its own settings: India for Indian time zones or Indian language variants. */
export const regionOf = (employee: { language: string; workingHours: { timezone: string } }) =>
  ["Asia/Kolkata", "Asia/Calcutta"].includes(employee.workingHours.timezone) || ["en-IN", "hi-en"].includes(employee.language) ? "IN" : null;

/** Devanagari, Bengali, Gujarati... digits to 0-9 (every Indic digit block starts at a code point ending in 6). */
export const asciiDigits = (text: string) =>
  text.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (c) =>
    String((c.charCodeAt(0) & 0xf) - 6),
  );

// From U+0904: a class range starting at a combining sign (U+0900-0903) trips no-misleading-character-class.
const DEVANAGARI = "\\u0904-\\u097F";
/** Word edges that also work next to Devanagari, which `\b` does not. */
const START = `(?<![a-z${DEVANAGARI}])`;
const END = `(?![a-z${DEVANAGARI}])`;

// ---- amounts ----

const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const UNIT = String.raw`lakhs?|lacs?|crores?|cr|k|thousand|hazaa?r|million|mn|हज़ार|हजार|लाख|करोड़|करोड`;
const PRE = String.raw`₹|rs\.?|inr|\$|usd|€|eur`;
const POST = String.raw`rupees?|rupaye|rupay|rupiya|rs\.?|inr|₹|रुपये|रुपए|रुपया|dollars?|usd|bucks|euros?`;
const MARKED_AMOUNT = new RegExp(
  `(?:(?<![a-z])(${PRE})\\s?)?(${NUM})(?:\\s?(${UNIT})${END})?(?:\\s?(${POST})${END})?`,
  "gi",
);
const CUED_AMOUNT = new RegExp(`${START}(?:budget|price|cost|amount|paid|pay|refund|charges?|fees?|keemat|kimat|daam|total|emi|salary)${END}[^\\d\\n]{0,20}?(${NUM})`, "gi");

const MULTIPLIERS: [RegExp, number][] = [
  [/^(lakhs?|lacs?|लाख)$/i, 1e5],
  [/^(crores?|cr|करोड़|करोड)$/i, 1e7],
  [/^(k|thousand|hazaa?r|हज़ार|हजार)$/i, 1e3],
  [/^(million|mn)$/i, 1e6],
];
const currencyOf = (marker: string) =>
  /₹|rs|inr|rup|रुप/i.test(marker) ? "INR" : /\$|usd|dollar|bucks/i.test(marker) ? "USD" : /€|eur/i.test(marker) ? "EUR" : "";

const amountOf = (num: string, unit?: string) => {
  const multiplier = unit ? (MULTIPLIERS.find(([re]) => re.test(unit))?.[1] ?? 1) : 1;
  return Math.round(Number(num.replace(/,/g, "")) * multiplier * 100) / 100;
};

/** The first amount in a text, lakh and crore included ("5 lakh" -> 500000, "₹1,50,000" -> 150000); null without one. */
export function parseAmount(text: string): number | null {
  const t = asciiDigits(text);
  const m = new RegExp(`(${NUM})(?:\\s?(${UNIT})${END})?`, "i").exec(t);
  return m ? amountOf(m[1]!, m[2]) : null;
}

// ---- dates and times ----

const MONTHS: Record<string, number> = {};
[
  ["january jan जनवरी", 1], ["february feb फ़रवरी फरवरी", 2], ["march mar मार्च", 3], ["april apr अप्रैल", 4], ["may मई", 5],
  ["june jun जून", 6], ["july jul जुलाई", 7], ["august aug अगस्त", 8], ["september sept sep सितंबर सितम्बर", 9],
  ["october oct अक्टूबर अक्तूबर", 10], ["november nov नवंबर नवम्बर", 11], ["december dec दिसंबर दिसम्बर", 12],
].forEach(([names, n]) => (names as string).split(" ").forEach((name) => (MONTHS[name] = n as number)));
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const WEEKDAYS: Record<string, number> = {};
[
  ["sunday ravivar raviwar itvar itwar रविवार इतवार", 0], ["monday mon somvar somwar सोमवार", 1], ["tuesday tue mangalvar mangalwar मंगलवार", 2],
  ["wednesday wed budhvar budhwar बुधवार", 3], ["thursday thu guruvar guruwar brihaspativar गुरुवार बृहस्पतिवार", 4],
  ["friday fri shukravar shukrawar शुक्रवार", 5], ["saturday shanivar shaniwar शनिवार", 6],
].forEach(([names, n]) => (names as string).split(" ").forEach((name) => (WEEKDAYS[name] = n as number)));
const WEEKDAY = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");

// "kal" and "parso" mean tomorrow / the day after, or yesterday / the day before: the tense decides.
const PAST = new RegExp(
  `${START}(?:tha|thi|hua|hui|hue|gaya|gayi|gaye|gya|kiya|kiye|aaya|aayi|mila|mili|was|were|did|ordered|received|yesterday|last)${END}|था|थी|थे|हुआ|हुई|गया|गई|किया|आया|मिला`,
  "i",
);
const RELATIVE = new RegExp(`${START}(day after tomorrow|day before yesterday|today|tonight|tomorrow|yesterday|aaj|kal|parso|parson|आज|कल|परसों)${END}`, "gi");

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---- the extractor ----

const NAME_STOP = new Set(
  "and from here speaking calling i my the aur se bol baat hai h he hoon hun ji sir madam maam ma'am".split(" "),
);
const NOT_A_NAME = new Set(
  "fine good ok okay looking interested calling trying not very so just sorry happy glad waiting going regarding writing having facing unable still also a an the".split(" "),
);
const TITLES = /^(mr|mrs|ms|miss|dr|shri|sri|smt|shrimati|kumari)\.?$/i;

const cleanName = (raw: string) => {
  const words: string[] = [];
  for (const w of raw.trim().split(/\s+/)) {
    const lower = w.toLowerCase().replace(/[.,!?]+$/, "");
    if (NAME_STOP.has(lower) || /[0-9]/.test(lower)) break;
    if (words.length === 0 && TITLES.test(lower)) continue;
    words.push(w.replace(/[.,!?]+$/, ""));
    // A name ends at punctuation ("Rahul Sharma. My order...") or after four words.
    if (words.length === 4 || /[.,!?]$/.test(w)) break;
  }
  if (words.length === 0 || NOT_A_NAME.has(words[0]!.toLowerCase())) return null;
  // Keep Devanagari as written; Latin in title case ("rahul sharma" -> "Rahul Sharma").
  return words.map((w) => (/^[a-z]/i.test(w) ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");
};

const NAME_PATTERNS = [
  /\bmy name(?:'s| is)\s+([a-z][a-z.' ]{1,60})/gi,
  /(?:\b[Ii] am|\bI'm|\b[Tt]his is|\b[Mm]yself)\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,3})/g,
  /\b(?:mera|meraa)\s+naam\s+(?:hai\s+)?([a-z][a-z ]{1,60}?)(?:\s+(?:hai|h|he)\b|[,.!?]|$)/gim,
  /\b(?:main|mai|mein)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:bol|baat kar)\s*(?:raha|rahi|rha|rhi)\b/gi,
  /मेरा नाम\s+([ऀ-ॿ]+(?:\s+[ऀ-ॿ]+)?)\s+है/g,
  /मैं\s+([ऀ-ॿ]+(?:\s+[ऀ-ॿ]+)?)\s+बोल\s+(?:रहा|रही)/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:here|speaking)\b/g,
];

const ADDRESS_WORD = new RegExp(
  `${START}(?:house|h\\.?\\s?no|flat|plot|building|bldg|apartments?|apt|tower|floor|sector|block|phase|road|rd|marg|street|lane|gali|nagar|colony|society|layout|enclave|vihar|puram|chowk|bazaa?r|market|near|opp|opposite|behind|village|vill|tehsil|taluka|district|dist|landmark|cross|mohalla)${END}|मकान|फ्लैट|गली|नगर|कॉलोनी|रोड|मार्ग|सेक्टर|गांव|गाँव|जिला|मोहल्ला|के पास|के सामने`,
  "gi",
);
const ADDRESS_CUE = new RegExp(
  `${START}(?:(?:my |delivery |shipping )?address(?: is)?|pata(?: hai)?|deliver (?:it )?(?:to|at)|(?:i )?(?:live|stay) (?:at|in))${END}\\s*[:-]?\\s*|पता\\s*(?:है)?\\s*[:-]?\\s*`,
  "i",
);
const PINCODE = /(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/g;

const PAYMENT_METHODS: [RegExp, string][] = [
  [/google pay|gpay/i, "Google Pay"], [/phone ?pe/i, "PhonePe"], [/paytm/i, "Paytm"], [/bhim/i, "BHIM UPI"], [/upi/i, "UPI"],
  [/cod|cash on delivery/i, "Cash on delivery"], [/net ?banking/i, "Net banking"], [/neft/i, "NEFT"], [/imps/i, "IMPS"], [/rtgs/i, "RTGS"],
  [/emi/i, "EMI"], [/credit card/i, "Credit card"], [/debit card/i, "Debit card"], [/cheque/i, "Cheque"], [/cash/i, "Cash"],
];
const PAYMENT = /(?<![a-z])(google pay|gpay|phone ?pe|paytm|bhim|upi|cod|cash on delivery|net ?banking|neft|imps|rtgs|emi|credit card|debit card|cheque|cash)(?![a-z])/gi;

/** Every entity in one message. Spans are claimed in order, so a phone number is not also an amount or an order id. */
export function extractEntities(text: string, ctx: ExtractContext = {}): ExtractedEntity[] {
  const t = asciiDigits(text);
  const found: ExtractedEntity[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([s, e]) => end <= s || start >= e);
  const claim = (type: EntityType, start: number, raw: string, value: string, details?: Record<string, string>) => {
    if (!free(start, start + raw.length)) return false;
    taken.push([start, start + raw.length]);
    found.push({ type, text: text.slice(start, start + raw.length), value, ...(details && { details }) });
    return true;
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of t.matchAll(re)) fn(m as RegExpExecArray);
  };

  each(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => claim("email", m.index, m[0], m[0].toLowerCase()));
  each(/(?<![\w.])[\w.-]{2,}@[a-z]{2,}(?![\w.@])/gi, (m) => claim("upi_id", m.index, m[0], m[0].toLowerCase()));
  each(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, (m) => claim("gstin", m.index, m[0], m[0].toUpperCase()));
  // Aadhaar and PAN are recognised so they are never shown or counted unmasked.
  for (const id of governmentIds(t)) {
    if (!free(id.index, id.index + id.text.length)) continue;
    taken.push([id.index, id.index + id.text.length]);
    found.push({ type: "government_id", text: id.masked, value: id.masked, details: { kind: id.kind } });
  }
  each(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, (m) => claim("ifsc", m.index, m[0], m[0]));

  // Order and reference ids: after a keyword, after "#", or a code like OD4312345678.
  each(
    /\b(order|booking|ticket|complaint|awb|tracking|ref(?:erence)?|invoice|pnr|transaction|txn|consignment)(?:\s*(?:id|no\.?|number|num))?\s*(?:is|hai|:|-|#)?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})(?![A-Za-z0-9-])/dgi,
    (m) => {
      const id = m[2]!;
      if ((id.match(/\d/g)?.length ?? 0) >= 3) claim("order_id", m.indices![2]![0], id, id.toUpperCase(), { label: m[1]!.toLowerCase() });
    },
  );
  each(/#\s?(\d{4,})/g, (m) => claim("order_id", m.index, m[0], m[1]!));
  each(/(?<![A-Za-z0-9-])[A-Z][A-Z0-9-]{5,19}(?![A-Za-z0-9-])/g, (m) => {
    if ((m[0].match(/\d/g)?.length ?? 0) >= 3) claim("order_id", m.index, m[0], m[0]);
  });

  // Phone numbers: toll-free, other countries, Indian mobiles (+91 / 0 / bare), Indian landlines (0 + STD code).
  each(/(?<!\d)1800[\s-]?\d{3}[\s-]?\d{3,4}(?!\d)/g, (m) => claim("phone", m.index, m[0], m[0].replace(/\D/g, ""), { kind: "toll_free" }));
  each(/(?<![\w+])\+(?!91)\d[\d\s-]{6,16}\d(?!\d)/g, (m) => {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) claim("phone", m.index, m[0], `+${digits}`, { kind: "international" });
  });
  each(/(?<![\w+])(?:((?:\+|00)91|91)[\s-]?|(0))?([6-9](?:[\s-]?\d){9})(?!\d)/g, (m) => {
    const digits = m[3]!.replace(/\D/g, "");
    const prefixed = Boolean(m[1] || m[2]);
    claim("phone", m.index, m[0], prefixed || ctx.region === "IN" ? `+91${digits}` : digits, { kind: "mobile" });
  });
  each(/(?<![\w+])(?:\+91[\s-]?|0)([1-5]\d{1,3})[\s-]?(\d{3,4})[\s-]?(\d{3,4})(?!\d)/g, (m) => {
    const national = `${m[1]}${m[2]}${m[3]}`;
    if (national.length === 10) claim("phone", m.index, m[0], `+91${national}`, { kind: "landline" });
  });

  // Dates: day first (25/12/2026), month names in English or Hindi, today/kal/parso, weekdays.
  const now = ctx.now ?? new Date();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: ctx.timezone ?? "UTC", dateStyle: "short" }).format(now);
  const year = Number(today.slice(0, 4));
  const past = PAST.test(t);
  each(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/.-])/g, (m) => {
    let [d, mo] = [Number(m[1]), Number(m[3])];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    const y = m[4]!.length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
    const iso = isoDay(y, mo, d);
    if (iso) claim("date", m.index, m[0], iso);
  });
  each(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH})${END}\\.?(?:,?\\s*(\\d{4}))?`, "gi"), (m) => {
    const iso = isoDay(m[3] ? Number(m[3]) : year, MONTHS[m[2]!.toLowerCase()]!, Number(m[1]));
    if (iso) claim("date", m.index, m[0], iso);
  });
  each(new RegExp(`${START}(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?`, "gi"), (m) => {
    const iso = isoDay(m[3] ? Number(m[3]) : year, MONTHS[m[1]!.toLowerCase()]!, Number(m[2]));
    if (iso) claim("date", m.index, m[0], iso);
  });
  each(RELATIVE, (m) => {
    const word = m[1]!.toLowerCase();
    const offset: Record<string, number> = { today: 0, tonight: 0, aaj: 0, आज: 0, tomorrow: 1, yesterday: -1, "day after tomorrow": 2, "day before yesterday": -2 };
    const n = offset[word] ?? (["kal", "कल"].includes(word) ? (past ? -1 : 1) : past ? -2 : 2);
    claim("date", m.index, m[0], addDays(today, n), { relative: word });
  });
  each(new RegExp(`${START}(?:(next|agle|this|is|last|pichle)\\s+)?(${WEEKDAY})${END}`, "gi"), (m) => {
    const target = WEEKDAYS[m[2]!.toLowerCase()]!;
    const current = new Date(`${today}T00:00:00Z`).getUTCDay();
    const back = /last|pichle/i.test(m[1] ?? "") || (past && !m[1]);
    const n = back ? -(((current - target + 6) % 7) + 1) : ((target - current + 6) % 7) + 1;
    claim("date", m.index, m[0], addDays(today, n), { weekday: m[2]!.toLowerCase() });
  });

  // Times: 3 PM, 15:30, "shaam 5 baje" (5 in the evening), "saade 3 baje" (half past 3).
  const time = (h: number, min: number) => (h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null);
  each(/(?<![\d:])(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi, (m) => {
    let h = Number(m[1]);
    const pm = /^p/i.test(m[3]!);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    const v = Number(m[1]) <= 12 ? time(h, Number(m[2] ?? 0)) : null;
    if (v) claim("time", m.index, m[0], v);
  });
  each(
    /(?:(subah|savere|morning|dopahar|dopehar|afternoon|shaam|sham|evening|raat|night|सुबह|दोपहर|शाम|रात)\s+)?(?:(saade|sadhe|साढ़े)\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:baje|bje|बजे)/gi,
    (m) => {
      let h = Number(m[3]);
      const period = (m[1] ?? "").toLowerCase();
      if (/dop|after|दोपहर|shaam|sham|even|शाम/.test(period) && h < 12) h += 12;
      if (/raat|night|रात/.test(period) && h >= 6 && h < 12) h += 12;
      if (/subah|savere|morning|सुबह|raat|night|रात/.test(period) && h === 12) h = 0;
      const v = time(h, m[2] ? 30 : Number(m[4] ?? 0));
      if (v) claim("time", m.index, m[0], v, period ? { period } : undefined);
    },
  );
  each(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (m) => claim("time", m.index, m[0], `${pad(Number(m[1]))}:${m[2]}`));

  // Amounts: a currency or a lakh/crore/thousand unit makes a number an amount; so does a word like "budget" before it.
  each(MARKED_AMOUNT, (m) => {
    const [raw, pre, num, unit, post] = m;
    if (!pre && !unit && !post) return;
    const marker = `${pre ?? ""}${post ?? ""}`;
    const currency = currencyOf(marker) || (unit && /lakh|lac|crore|cr|hazaa?r|लाख|करोड|हज/i.test(unit) ? "INR" : ctx.region === "IN" ? "INR" : "");
    claim("amount", m.index, raw.trim(), String(amountOf(num!, unit)), currency ? { currency } : undefined);
  });
  each(CUED_AMOUNT, (m) => {
    const num = m[1]!;
    const start = m.index + m[0].length - num.length;
    claim("amount", start, num, String(amountOf(num)), ctx.region === "IN" ? { currency: "INR" } : undefined);
  });

  // Addresses: a line with a PIN code and an address word, two address words and a number, or "address is ...".
  for (const s of t.matchAll(/[^\n?!|]+/g)) {
    const [segment] = s;
    const pinAt = (p: RegExpExecArray | RegExpMatchArray) => s.index + p.index!;
    const cue = ADDRESS_CUE.exec(segment);
    const words = segment.match(ADDRESS_WORD)?.length ?? 0;
    const pin = [...segment.matchAll(PINCODE)].find((p) => free(pinAt(p), pinAt(p) + p[0].length));
    if (!((pin && words >= 1) || (words >= 2 && /\d/.test(segment)) || (cue && words >= 1))) continue;
    const from = cue ? cue.index + cue[0].length : 0;
    const rest = segment.slice(from);
    // Ends at the PIN code (it closes an Indian address), else at the end of the sentence.
    const to = pin && pin.index >= from ? pin.index + pin[0].length : from + (rest.search(/\.\s+[A-Z]/) + 1 || rest.length);
    const address = segment.slice(from, to).replace(/\s+/g, " ").replace(/^[\s,:-]+|[\s,.-]+$/g, "").slice(0, 200);
    if (address.length < 8) continue;
    const landmark = /(?:near|opp(?:osite)?\.?|behind|landmark)\s+([^,.\n]{3,40})/i.exec(address)?.[1]?.trim();
    found.push({ type: "address", text: address, value: address, details: { ...(pin && { pincode: `${pin[1]}${pin[2]}` }), ...(landmark && { landmark }) } });
    if (pin) taken.push([pinAt(pin), pinAt(pin) + pin[0].length]);
  }
  each(PINCODE, (m) => {
    // A six-digit number is a PIN code only with the word next to it.
    if (/(pin|pincode|pin code|postal code|zip)\W{0,3}$/i.test(t.slice(Math.max(0, m.index - 14), m.index)))
      claim("pincode", m.index, m[0], `${m[1]}${m[2]}`);
  });

  for (const pattern of NAME_PATTERNS)
    each(pattern, (m) => {
      const name = cleanName(m[1]!);
      if (name && !found.some((e) => e.type === "person_name" && e.value === name)) found.push({ type: "person_name", text: name, value: name });
    });

  each(PAYMENT, (m) => {
    const value = PAYMENT_METHODS.find(([re]) => re.test(m[1]!))![1];
    if (!found.some((e) => e.type === "payment_method" && e.value === value)) found.push({ type: "payment_method", text: m[1]!, value });
  });
  return found;
}
