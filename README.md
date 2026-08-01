# 瞬辞

広告を挟まず、日本語・英語の語をすぐ引いて単語札へ残せる辞書です。

- 公開先: https://shunji.yhay81.com
- 実行基盤: Cloudflare Workers + Hono JSX + Vite+
- 辞書: JMdict English (EDRDG), CC BY-SA 4.0
- 保存: 検索語は送信後に保存せず、単語札はブラウザー内だけに保存

## 開発

```powershell
npm install
npm run dictionary:build
npm run check
npm test
npm run build
```

生成辞書は `data/` に置かれ、Gitには含めません。コードはMIT、JMdict由来の辞書データはCC BY-SA 4.0です。詳細は `SOURCE.md` を参照してください。
