import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_dictionary.sql", import.meta.url));
const appPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const ogPath = fileURLToPath(new URL("../public/og.svg", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const origin = "http://localhost";
const session = "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a";

let miniflare: Miniflare;
let bindings: Bindings;

const payload = (headword: string, reading: string, glosses: string[]) =>
  JSON.stringify({
    r: [{ t: reading }],
    s: [{ g: glosses, p: ["noun (common) (futsuumeishi)"] }],
    w: [{ t: headword }],
  });

const apiHeaders = (overrides: Record<string, string> = {}) => ({
  "content-type": "application/json",
  origin,
  "x-shunji-qa": "1",
  "x-shunji-session": session,
  ...overrides,
});

beforeAll(async () => {
  miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "",
          compatibilityDate: "2026-07-27",
          env: { DB: { type: "d1", id: "shunji-test" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: "export default { fetch() { return new Response('test') } }",
              },
            },
          },
        },
      },
    ],
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  const entries = [
    [1467640, "猫", 0, payload("猫", "ねこ", ["cat", "feline"])],
    [1467670, "猫背", 2, payload("猫背", "ねこぜ", ["bent back", "stoop"])],
    [1318970, "辞書", 0, payload("辞書", "じしょ", ["dictionary", "lexicon"])],
  ] as const;
  for (const [id, headword, score, source] of entries) {
    await database
      .prepare("INSERT INTO entries(id,headword,score,payload) VALUES(?,?,?,?)")
      .bind(id, headword, score, source)
      .run();
  }
  for (const [term, id, score, kind] of [
    ["猫", 1467640, 0, 0],
    ["ねこ", 1467640, 0, 1],
    ["猫背", 1467670, 2, 0],
    ["ねこぜ", 1467670, 2, 1],
    ["辞書", 1318970, 0, 0],
    ["じしょ", 1318970, 0, 1],
  ] as const) {
    await database
      .prepare("INSERT INTO terms(term,entry_id,score,kind) VALUES(?,?,?,?)")
      .bind(term, id, score, kind)
      .run();
  }
  for (const [id, glosses] of [
    [1467640, "cat | feline"],
    [1467670, "bent back | stoop"],
    [1318970, "dictionary | lexicon"],
  ] as const) {
    await database
      .prepare("INSERT INTO entry_fts(rowid,glosses) VALUES(?,?)")
      .bind(id, glosses)
      .run();
  }
  await database
    .prepare("INSERT INTO dictionary_meta(key,value) VALUES('entry_count','3'),('term_count','6')")
    .run();
  bindings = {
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM product_events"),
    bindings.DB.prepare("UPDATE entries SET headword = '猫' WHERE id = 1467640"),
  ]);
});

afterAll(async () => miniflare.dispose());

describe("public surfaces", () => {
  it.each([
    ["/", 'class="dictionary-stage"', "https://shunji.yhay81.com/"],
    ["/guide", 'class="guide-grid"', "https://shunji.yhay81.com/guide"],
    ["/source", 'class="source-grid"', "https://shunji.yhay81.com/source"],
    ["/privacy", 'class="privacy-grid"', "https://shunji.yhay81.com/privacy"],
  ])("%s is a visual product page", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("瞬辞");
    expect(html).not.toMatch(/仮説|成功条件|市場スコア|移行候補|実験/u);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves a meaningful, escaped entry page", async () => {
    await bindings.DB.prepare("UPDATE entries SET headword = ? WHERE id = 1467640")
      .bind("猫<script>")
      .run();
    const response = await app.request("/entry/1467640", undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("猫&lt;script&gt;");
    expect(html).not.toContain("猫<script>");
    expect(html).toContain('data-open-entry="1467640"');
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("publishes static and entry sitemap indexes", async () => {
    const index = await (await app.request("/sitemap.xml", undefined, bindings)).text();
    expect(index).toContain("/sitemaps/static.xml");
    expect(index).toContain("/sitemaps/entries-0.xml");
    const entries = await (
      await app.request("/sitemaps/entries-0.xml", undefined, bindings)
    ).text();
    expect(entries.match(/<loc>/gu)).toHaveLength(3);
    expect(entries).toContain("/entry/1467640");
    expect((await app.request("/sitemaps/entries-1.xml", undefined, bindings)).status).toBe(404);
    expect(await (await app.request("/health", undefined, bindings)).json()).toEqual({
      dictionaryEntries: 3,
      ok: true,
      service: "shunji",
    });
  });
});

describe("bilingual search", () => {
  it("returns exact Japanese terms before prefixes", async () => {
    const response = await app.request(
      "/api/search",
      { body: JSON.stringify({ query: "猫" }), headers: apiHeaders(), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ entries: Array<{ headword: string }> }>();
    expect(body.entries.map((entry) => entry.headword)).toEqual(["猫", "猫背"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses English full-text search and exact gloss ranking", async () => {
    const response = await app.request(
      "/api/search",
      { body: JSON.stringify({ query: "dictionary" }), headers: apiHeaders(), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json<{ entries: Array<{ headword: string }> }>()).entries[0]?.headword,
    ).toBe("辞書");
  });

  it("stores outcome but never query text", async () => {
    await app.request(
      "/api/search",
      { body: JSON.stringify({ query: "secret search" }), headers: apiHeaders(), method: "POST" },
      bindings,
    );
    const rows = await bindings.DB.prepare("SELECT * FROM product_events").all<
      Record<string, unknown>
    >();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.event_name).toBe("no_result");
    expect(JSON.stringify(rows.results)).not.toContain("secret search");
    expect(rows.results[0]?.is_qa).toBe(1);
  });

  it.each([
    [{ body: JSON.stringify({ query: "" }), headers: apiHeaders(), method: "POST" }, 400],
    [
      {
        body: JSON.stringify({ query: "猫" }),
        headers: apiHeaders({ origin: "https://evil.example" }),
        method: "POST",
      },
      403,
    ],
    [
      { body: "query=猫", headers: apiHeaders({ "content-type": "text/plain" }), method: "POST" },
      415,
    ],
  ])("rejects unsafe search request %#", async (init, status) => {
    expect((await app.request("/api/search", init, bindings)).status).toBe(status);
  });
});

describe("telemetry and retention", () => {
  it("records allowlisted actions and rejects invented ones", async () => {
    const accepted = await app.request(
      "/api/telemetry",
      {
        body: JSON.stringify({ entryId: 1467640, name: "saved" }),
        headers: apiHeaders(),
        method: "POST",
      },
      bindings,
    );
    expect(accepted.status).toBe(202);
    const rejected = await app.request(
      "/api/telemetry",
      { body: JSON.stringify({ name: "query_text" }), headers: apiHeaders(), method: "POST" },
      bindings,
    );
    expect(rejected.status).toBe(400);
  });

  it("deletes action rows after 35 days", async () => {
    await bindings.DB.prepare(
      "INSERT INTO product_events(session_hash,event_name,entry_id,is_qa,created_at) VALUES('old','visited',0,1,1)",
    ).run();
    await scheduled({} as ScheduledEvent, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare(
        "SELECT event_name FROM product_events WHERE session_hash='old'",
      ).first(),
    ).toBeNull();
  });
});

describe("release assets", () => {
  it("ships substantial code-native visuals without gradients or markup injection", async () => {
    expect((await stat(appPath)).size).toBeGreaterThan(10_000);
    expect((await stat(ogPath)).size).toBeGreaterThan(1_500);
    const appSource = await readFile(appPath, "utf8");
    const styles = await readFile(stylesPath, "utf8");
    expect(appSource).not.toMatch(/innerHTML|eval\(|new Function/iu);
    expect(styles).not.toMatch(/gradient/iu);
    expect(styles).toContain(".dictionary-glyph");
  });

  it("keeps the production domain, daily cleanup, and D1 binding configured", async () => {
    const wrangler = await readFile(wranglerPath, "utf8");
    expect(wrangler).toContain("shunji.yhay81.com");
    expect(wrangler).toContain('"crons"');
    expect(wrangler).toContain('"binding": "DB"');
  });
});
