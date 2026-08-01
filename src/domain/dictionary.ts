export type SourceWriting = { i?: string[]; p?: string[]; t: string };
export type SourceReading = { i?: string[]; k?: string[]; n?: 1; p?: string[]; t: string };
export type SourceSense = {
  a?: string[];
  d?: string[];
  f?: string[];
  g: string[];
  i?: string[];
  k?: string[];
  m?: string[];
  p?: string[];
  r?: string[];
  x?: string[];
};
export type SourcePayload = { r: SourceReading[]; s: SourceSense[]; w: SourceWriting[] };

export type EntryView = {
  alternatives: string[];
  headword: string;
  id: number;
  readings: string[];
  score: number;
  senses: Array<{
    glosses: string[];
    info: string[];
    parts: string[];
  }>;
};

export type EntryRow = { headword: string; id: number; payload: string; score: number };

const japanesePattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const englishTokenPattern = /[\p{L}\p{N}'-]+/gu;

const partLabels = new Map<string, string>([
  ["noun (common) (futsuumeishi)", "名詞"],
  ["proper noun", "固有名詞"],
  ["adverb (fukushi)", "副詞"],
  ["adverb taking the 'to' particle", "副詞（と）"],
  ["adjective (keiyoushi)", "い形容詞"],
  ["adjectival nouns or quasi-adjectives (keiyodoshi)", "形容動詞"],
  ["pre-noun adjectival (rentaishi)", "連体詞"],
  ["interjection (kandoushi)", "感動詞"],
  ["conjunction", "接続詞"],
  ["particle", "助詞"],
  ["auxiliary verb", "助動詞"],
  ["auxiliary adjective", "補助形容詞"],
  ["Ichidan verb", "一段動詞"],
  ["Godan verb with 'u' ending", "五段動詞（う）"],
  ["Godan verb with 'ku' ending", "五段動詞（く）"],
  ["Godan verb with 'gu' ending", "五段動詞（ぐ）"],
  ["Godan verb with 'su' ending", "五段動詞（す）"],
  ["Godan verb with 'tsu' ending", "五段動詞（つ）"],
  ["Godan verb with 'nu' ending", "五段動詞（ぬ）"],
  ["Godan verb with 'bu' ending", "五段動詞（ぶ）"],
  ["Godan verb with 'mu' ending", "五段動詞（む）"],
  ["Godan verb with 'ru' ending", "五段動詞（る）"],
  ["intransitive verb", "自動詞"],
  ["transitive verb", "他動詞"],
  ["suru verb - irregular", "サ変動詞"],
  ["kuru verb - special class", "カ変動詞"],
  ["expression (phrases, clauses, etc.)", "表現"],
  ["prefix", "接頭語"],
  ["suffix", "接尾語"],
  ["counter", "助数詞"],
  ["pronoun", "代名詞"],
]);

export const cleanQuery = (value: unknown) => {
  if (typeof value !== "string") return null;
  const query = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!query || query.length > 80 || new TextEncoder().encode(query).byteLength > 256) return null;
  for (const character of query) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 32 || point === 127) return null;
  }
  return query;
};

export const isJapaneseQuery = (query: string) => japanesePattern.test(query);

export const ftsExpression = (query: string) => {
  const tokens = query.match(englishTokenPattern) ?? [];
  if (!tokens.length || tokens.length > 8) return null;
  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"*`).join(" AND ");
};

export const parseEntry = (row: EntryRow): EntryView => {
  const payload = JSON.parse(row.payload) as SourcePayload;
  const writings = payload.w.map((writing) => writing.t);
  const readings = payload.r.map((reading) => reading.t);
  const alternatives = [...new Set([...writings, ...readings])].filter(
    (value) => value !== row.headword,
  );
  return {
    alternatives,
    headword: row.headword,
    id: row.id,
    readings: [...new Set(readings)],
    score: row.score,
    senses: payload.s.map((sense) => ({
      glosses: sense.g,
      info: [...(sense.i ?? []), ...(sense.m ?? []), ...(sense.f ?? []), ...(sense.d ?? [])],
      parts: [...new Set((sense.p ?? []).map((part) => partLabels.get(part) ?? part))],
    })),
  };
};

const glossRank = (entry: EntryView, normalizedQuery: string) => {
  const glosses = entry.senses.flatMap((sense) =>
    sense.glosses.map((gloss) => gloss.toLowerCase()),
  );
  if (glosses.some((gloss) => gloss === normalizedQuery)) return 0;
  if (glosses.some((gloss) => gloss.startsWith(normalizedQuery))) return 1;
  if (glosses.some((gloss) => gloss.includes(normalizedQuery))) return 2;
  return 3;
};

export const rerankEnglish = (entries: EntryView[], query: string, limit = 20) => {
  const normalized = query.toLocaleLowerCase("en");
  return entries
    .map((entry, originalIndex) => ({
      entry,
      gloss: glossRank(entry, normalized),
      originalIndex,
    }))
    .sort(
      (left, right) =>
        left.gloss - right.gloss ||
        left.entry.score - right.entry.score ||
        left.originalIndex - right.originalIndex,
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
};
