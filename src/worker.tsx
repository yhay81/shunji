import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  cleanQuery,
  ftsExpression,
  isJapaneseQuery,
  parseEntry,
  rerankEnglish,
  type EntryRow,
  type EntryView,
} from "./domain/dictionary";

export type Bindings = { ASSETS: Fetcher; DB: D1Database };
type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 413 | 415 | 503,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://shunji.yhay81.com";
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const telemetryNames = new Set(["visited", "entry_opened", "saved", "copied", "returned"]);
const sitemapPageSize = 40_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) throw new ApiError("cross_site_request", 403);
};
const parseJson = async (c: AppContext, maximumBytes = 2048) => {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};
const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};
const numericId = (value: string) => {
  if (!/^\d{6,8}$/u.test(value)) throw new ApiError("not_found", 404);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ApiError("not_found", 404);
  return id;
};
const optionalEntryId = (value: unknown) => {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99_999_999) {
    throw new ApiError("invalid_entry", 400);
  }
  return value as number;
};
const recordEvent = async (c: AppContext, name: string, entryId = 0) => {
  const session = (c.req.header("x-shunji-session") ?? "").toLowerCase();
  if (!sessionPattern.test(session)) return;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO product_events (session_hash,event_name,entry_id,is_qa,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      await sha256(session),
      name,
      entryId,
      c.req.header("x-shunji-qa") === "1" ? 1 : 0,
      nowSeconds(),
    )
    .run();
};

const getEntry = async (database: D1Database, id: number) => {
  const row = await database
    .prepare("SELECT id,headword,score,payload FROM entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  if (!row) throw new ApiError("not_found", 404);
  return parseEntry(row);
};

const searchJapanese = async (database: D1Database, query: string) => {
  const result = await database
    .prepare(
      `SELECT e.id,e.headword,e.score,e.payload
       FROM entries e
       JOIN (
         SELECT entry_id,
                MIN(CASE WHEN term = ? THEN 0 ELSE 1 END) AS exact_rank,
                MIN(score) AS term_score
         FROM terms
         WHERE term >= ? AND term < ?
         GROUP BY entry_id
       ) matched ON matched.entry_id = e.id
       ORDER BY matched.exact_rank, matched.term_score, e.score, e.id
       LIMIT 20`,
    )
    .bind(query, query, query + "\uffff")
    .all<EntryRow>();
  return result.results.map(parseEntry);
};

const searchEnglish = async (database: D1Database, query: string) => {
  const expression = ftsExpression(query);
  if (!expression) return [];
  const result = await database
    .prepare(
      `SELECT e.id,e.headword,e.score,e.payload
       FROM entry_fts
       JOIN entries e ON e.id = entry_fts.rowid
       WHERE entry_fts MATCH ?
       ORDER BY bm25(entry_fts), e.score, e.id
       LIMIT 80`,
    )
    .bind(expression)
    .all<EntryRow>();
  return rerankEnglish(result.results.map(parseEntry), query);
};

const searchDictionary = (database: D1Database, query: string) =>
  isJapaneseQuery(query) ? searchJapanese(database, query) : searchEnglish(database, query);

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width,initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      {noindex ? <meta content="noindex,nofollow" name="robots" /> : null}
      <link href={canonical} rel="canonical" />
      <meta content="website" property="og:type" />
      <meta content="瞬辞" property="og:site_name" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={canonicalOrigin + "/og.svg"} property="og:image" />
      <meta content="summary_large_image" name="twitter:card" />
      <meta content="#f2efe7" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      <script defer src="/app.js" />
    </head>
    <body>
      <a class="skip-link" href="#main">
        本文へ
      </a>
      <header class="site-header">
        <a class="wordmark" href="/" aria-label="瞬辞 ホーム">
          <span class="wordmark-leaf">瞬</span>
          <span>辞</span>
        </a>
        <nav aria-label="サイト案内">
          <a href="/guide">使い方</a>
          <a href="/source">辞書の出典</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer class="site-footer">
        <span>瞬辞</span>
        <span>JMdict English / CC BY-SA 4.0</span>
        <a href="https://github.com/yhay81/shunji">GitHub</a>
      </footer>
    </body>
  </html>
);

const DictionaryGlyph = () => (
  <div aria-hidden="true" class="dictionary-glyph">
    <div class="glyph-spine" />
    <div class="glyph-page left-page">
      <i />
      <i />
      <i />
      <i />
    </div>
    <div class="glyph-page right-page">
      <b>余白</b>
      <small>よはく</small>
      <i />
      <i />
    </div>
    <div class="glyph-tab tab-one" />
    <div class="glyph-tab tab-two" />
  </div>
);

const SearchForm = () => (
  <form class="search-form" id="search-form" novalidate>
    <label for="query">日本語・英語</label>
    <div class="search-slot">
      <input
        autocomplete="off"
        id="query"
        maxlength={80}
        name="q"
        placeholder="例：余白 / margin"
        required
        type="search"
      />
      <button type="submit">
        <span>引く</span>
        <i aria-hidden="true" />
      </button>
    </div>
    <p class="search-status" id="search-status" role="status">
      語形・読み・英語の意味から探せます
    </p>
  </form>
);

const SampleCard = () => (
  <article aria-hidden="true" class="entry-card sample-card">
    <div class="entry-card-index">余</div>
    <div class="entry-card-body">
      <p class="reading-line">よはく</p>
      <h2>余白</h2>
      <ol class="sense-list">
        <li>blank space; margin</li>
        <li>room; leeway</li>
      </ol>
    </div>
    <div class="card-notch" />
  </article>
);

const SavedPreview = () => (
  <div aria-hidden="true" class="saved-preview">
    <div class="saved-card back">
      <span>間</span>
    </div>
    <div class="saved-card middle">
      <span>余</span>
    </div>
    <div class="saved-card front">
      <span>白</span>
      <i />
      <i />
    </div>
  </div>
);

const Home = () => (
  <Layout
    canonical={canonicalOrigin + "/"}
    description="広告なしで日本語・英語をすぐ引ける辞書。見つけた語は端末内の単語札へ残せます。"
    title="瞬辞｜すぐ引ける日本語・英語辞書"
  >
    <main id="main">
      <section class="workbench">
        <div class="search-panel">
          <p class="eyebrow">JAPANESE ↔ ENGLISH</p>
          <h1>ことばを、待たせない。</h1>
          <SearchForm />
        </div>
        <div class="dictionary-stage">
          <DictionaryGlyph />
          <SampleCard />
          <SavedPreview />
        </div>
      </section>
      <section aria-live="polite" class="results-section" hidden id="results-section">
        <div class="section-heading">
          <div>
            <p class="eyebrow">MATCHED CARDS</p>
            <h2 id="results-title">見つかった語</h2>
          </div>
          <span id="results-count" />
        </div>
        <div class="results-grid" id="results" />
      </section>
      <section class="deck-section" id="deck-section">
        <div class="deck-rail">
          <SavedPreview />
          <div>
            <p class="eyebrow">ON THIS DEVICE</p>
            <h2>単語札</h2>
            <p>気になる語を一枚ずつ。この端末の中だけに残ります。</p>
          </div>
          <button class="quiet-button" hidden id="clear-deck" type="button">
            すべて外す
          </button>
        </div>
        <div class="empty-deck" id="empty-deck">
          検索結果の「札へ残す」から始められます。
        </div>
        <div class="deck-grid" id="deck" />
      </section>
      <section class="boundary-strip">
        <div>
          <i class="signal fast" />
          <b>全件を即検索</b>
          <span>語形・読み・英語の意味</span>
        </div>
        <div>
          <i class="signal private" />
          <b>検索語を残さない</b>
          <span>URLにも記録にも含めません</span>
        </div>
        <div>
          <i class="signal local" />
          <b>単語札は端末内</b>
          <span>登録も同期もありません</span>
        </div>
      </section>
    </main>
  </Layout>
);

const EntryCard = ({ entry, standalone = false }: { entry: EntryView; standalone?: boolean }) => {
  const stored = JSON.stringify(entry);
  return (
    <article class={standalone ? "entry-card entry-detail" : "entry-card"} data-entry-card>
      <div class="entry-card-index">{entry.headword.slice(0, 1)}</div>
      <div class="entry-card-body">
        <p class="reading-line">{entry.readings.join("・")}</p>
        <h1>{entry.headword}</h1>
        {entry.alternatives.length ? (
          <p class="alternative-line">表記・読み：{entry.alternatives.slice(0, 8).join("・")}</p>
        ) : null}
        <ol class="sense-list">
          {entry.senses.map((sense, index) => (
            <li>
              <span class="sense-number">{index + 1}</span>
              <div>
                <p>{sense.glosses.join("; ")}</p>
                {sense.parts.length || sense.info.length ? (
                  <div class="sense-tags">
                    {sense.parts.slice(0, 4).map((part) => (
                      <span>{part}</span>
                    ))}
                    {sense.info.slice(0, 3).map((info) => (
                      <span>{info}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div class="card-actions">
        <button class="save-entry" data-entry={stored} type="button">
          札へ残す
        </button>
        <button class="copy-entry" data-copy={entry.headword} type="button">
          語をコピー
        </button>
        {!standalone ? <a href={`/entry/${entry.id}`}>一枚で開く</a> : null}
      </div>
      <div class="card-notch" />
    </article>
  );
};

const EntryPage = ({ entry }: { entry: EntryView }) => {
  const gloss = entry.senses
    .flatMap((sense) => sense.glosses)
    .slice(0, 3)
    .join("; ");
  return (
    <Layout
      canonical={`${canonicalOrigin}/entry/${entry.id}`}
      description={`${entry.headword}（${entry.readings.slice(0, 2).join("・")}）: ${gloss}`.slice(
        0,
        155,
      )}
      title={`${entry.headword}の意味・読み｜瞬辞`}
    >
      <main class="entry-page" data-open-entry={entry.id} id="main">
        <div class="entry-page-rail">
          <a href="/">← 別の語を引く</a>
          <span>JMdict {entry.id}</span>
        </div>
        <EntryCard entry={entry} standalone />
        <aside class="entry-source-note">
          <DictionaryGlyph />
          <div>
            <h2>辞書データ</h2>
            <p>JMdict Englishを読みやすいカードへ整形しています。語義は英語です。</p>
            <a href="/source">出典とライセンス</a>
          </div>
        </aside>
      </main>
    </Layout>
  );
};

const Guide = () => (
  <Layout
    canonical={canonicalOrigin + "/guide"}
    description="瞬辞で日本語・英語を検索し、単語札へ残して見返す方法。"
    title="使い方｜瞬辞"
  >
    <main class="info-page" id="main">
      <section class="info-heading">
        <DictionaryGlyph />
        <div>
          <p class="eyebrow">THREE MOVES</p>
          <h1>打つ。ひらく。残す。</h1>
          <p>辞書を引く流れを、三つの動きに絞りました。</p>
        </div>
      </section>
      <ol class="guide-grid">
        <li>
          <span>01</span>
          <div>
            <h2>日本語か英語を打つ</h2>
            <p>漢字、かな、カタカナ、英単語や短い英語句から探せます。</p>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h2>辞書カードを読む</h2>
            <p>読み、別表記、英語の意味、主な品詞を一枚にまとめます。</p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h2>単語札へ残す</h2>
            <p>札はこのブラウザー内だけに保存。登録や同期はありません。</p>
          </div>
        </li>
      </ol>
      <section class="limit-card">
        <h2>できないこと</h2>
        <p>国語辞典の語釈、文章翻訳、発音音声、例文検索、専門判断の保証には対応していません。</p>
      </section>
    </main>
  </Layout>
);

const Source = () => (
  <Layout
    canonical={canonicalOrigin + "/source"}
    description="瞬辞が利用するJMdict Englishの出典、更新方法、CC BY-SA 4.0ライセンス。"
    title="辞書の出典｜瞬辞"
  >
    <main class="info-page" id="main">
      <section class="source-heading">
        <div class="source-stamp">
          <span>JM</span>
          <b>DICT</b>
          <i>CC</i>
        </div>
        <div>
          <p class="eyebrow">OPEN DICTIONARY</p>
          <h1>出典をたどれる辞書。</h1>
          <p>公開された原典から、検索用データを再生成しています。</p>
        </div>
      </section>
      <section class="source-grid">
        <article>
          <h2>原典</h2>
          <p>Electronic Dictionary Research and Development Group（EDRDG）のJMdict Englishです。</p>
          <a
            href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
            rel="external"
          >
            JMdictプロジェクト
          </a>
        </article>
        <article>
          <h2>ライセンス</h2>
          <p>
            辞書データとその変換物はCreative Commons Attribution-ShareAlike 4.0 Internationalです。
          </p>
          <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="external license">
            CC BY-SA 4.0
          </a>
        </article>
        <article>
          <h2>瞬辞での変更</h2>
          <p>
            XMLを語・読みの索引、英語全文索引、表示用JSONへ変換しています。独自の語義は加えていません。
          </p>
          <a
            href="https://github.com/yhay81/shunji/blob/main/scripts/build_jmdict.py"
            rel="external"
          >
            変換コード
          </a>
        </article>
      </section>
    </main>
  </Layout>
);

const Privacy = () => (
  <Layout
    canonical={canonicalOrigin + "/privacy"}
    description="瞬辞が保存しない検索語、端末内だけの単語札、35日で消える匿名利用集計。"
    title="データ｜瞬辞"
  >
    <main class="info-page" id="main">
      <section class="privacy-heading">
        <div class="privacy-slot">
          <i />
          <i />
          <i />
          <span>LOCAL</span>
        </div>
        <div>
          <p class="eyebrow">QUERY STAYS UNRECORDED</p>
          <h1>引いた語は、記録しない。</h1>
          <p>単語札もサーバーへ送りません。</p>
        </div>
      </section>
      <section class="privacy-grid">
        <article class="kept">
          <h2>端末内だけ</h2>
          <ul>
            <li>単語札に残した語</li>
            <li>再訪を数えるランダム識別子</li>
            <li>最後に使った日</li>
          </ul>
        </article>
        <article class="absent">
          <h2>保存しない</h2>
          <ul>
            <li>検索した日本語・英語</li>
            <li>氏名、メール、電話番号</li>
            <li>広告ID、他サイトの閲覧情報</li>
          </ul>
        </article>
        <article class="short">
          <h2>35日で削除</h2>
          <ul>
            <li>検索成功／該当なしの別</li>
            <li>単語札保存、コピー、再訪</li>
            <li>識別子を一方向変換した値</li>
          </ul>
        </article>
      </section>
      <p class="retention-note">
        Cookie、外部広告、外部アクセス解析、利用者アカウントは使いません。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", (c) => c.html(<Home />));
app.get("/guide", (c) => c.html(<Guide />));
app.get("/source", (c) => c.html(<Source />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/entry/:id", async (c) => {
  const entry = await getEntry(c.env.DB, numericId(c.req.param("id")));
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.html(<EntryPage entry={entry} />);
});

app.post("/api/search", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== undefined && payload.website !== "")
    throw new ApiError("invalid_request", 400);
  const query = cleanQuery(payload.query);
  if (!query) throw new ApiError("invalid_query", 400);
  const entries = await searchDictionary(c.env.DB, query);
  await recordEvent(c, entries.length ? "searched" : "no_result");
  c.header("Cache-Control", "no-store");
  return c.json({ entries });
});

app.post("/api/telemetry", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c));
  const name = payload.name;
  if (typeof name !== "string" || !telemetryNames.has(name)) {
    throw new ApiError("invalid_event", 400);
  }
  await recordEvent(c, name, optionalEntryId(payload.entryId));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true }, 202);
});

app.get("/health", async (c) => {
  const meta = await c.env.DB.prepare(
    "SELECT value FROM dictionary_meta WHERE key = 'entry_count'",
  ).first<{ value: string }>();
  return c.json({
    dictionaryEntries: Number(meta?.value ?? 0),
    ok: Boolean(meta),
    service: "shunji",
  });
});

app.get("/sitemap.xml", async (c) => {
  const meta = await c.env.DB.prepare(
    "SELECT value FROM dictionary_meta WHERE key = 'entry_count'",
  ).first<{ value: string }>();
  const pageCount = Math.ceil(Number(meta?.value ?? 0) / sitemapPageSize);
  const locations = [
    "/sitemaps/static.xml",
    ...Array.from({ length: pageCount }, (_, index) => `/sitemaps/entries-${index}.xml`),
  ];
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((path) => `<sitemap><loc>${canonicalOrigin}${path}</loc></sitemap>`).join("")}</sitemapindex>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.get("/sitemaps/static.xml", (c) => {
  const locations = ["/", "/guide", "/source", "/privacy"];
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((path) => `<url><loc>${canonicalOrigin}${path}</loc></url>`).join("")}</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.get("/sitemaps/entries-*", async (c) => {
  const match = /^\/sitemaps\/entries-(\d{1,2})\.xml$/u.exec(c.req.path);
  if (!match?.[1]) throw new ApiError("not_found", 404);
  const page = Number(match[1]);
  const meta = await c.env.DB.prepare(
    "SELECT value FROM dictionary_meta WHERE key = 'entry_count'",
  ).first<{ value: string }>();
  const pageCount = Math.ceil(Number(meta?.value ?? 0) / sitemapPageSize);
  if (page >= pageCount) throw new ApiError("not_found", 404);
  const ids = await c.env.DB.prepare("SELECT id FROM entries ORDER BY id LIMIT ? OFFSET ?")
    .bind(sitemapPageSize, page * sitemapPageSize)
    .all<{ id: number }>();
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.text(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ids.results.map(({ id }) => `<url><loc>${canonicalOrigin}/entry/${id}</loc></url>`).join("")}</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
    }
    return c.html(
      <Layout
        canonical={canonicalOrigin + c.req.path}
        description="ページが見つかりません。"
        noindex
        title="見つかりません｜瞬辞"
      >
        <main class="not-found" id="main">
          <DictionaryGlyph />
          <h1>その札は見つかりません</h1>
          <a class="primary" href="/">
            別の語を引く
          </a>
        </main>
      </Layout>,
      error.status,
    );
  }
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "unknown",
      requestId: c.get("requestId"),
    }),
  );
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status !== 404) return response;
  return c.html(
    <Layout
      canonical={canonicalOrigin + c.req.path}
      description="ページが見つかりません。"
      noindex
      title="見つかりません｜瞬辞"
    >
      <main class="not-found" id="main">
        <DictionaryGlyph />
        <h1>その札は見つかりません</h1>
        <a class="primary" href="/">
          別の語を引く
        </a>
      </main>
    </Layout>,
    404,
  );
});

export const scheduled = async (
  _controller: ScheduledEvent,
  env: Bindings,
  _context: ExecutionContext,
) => {
  await env.DB.prepare("DELETE FROM product_events WHERE created_at < ?")
    .bind(nowSeconds() - 35 * 86400)
    .run();
};

export { app };
export default { fetch: app.fetch, scheduled };
