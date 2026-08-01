# Security

脆弱性を見つけた場合は、公開Issueでは詳細を開示せず、GitHubのPrivate vulnerability reportingを利用してください。

- 検索は同一オリジンのJSON POSTだけを受け付け、検索語をURLへ載せません。
- 出力はHono JSXまたはDOM APIで組み立て、辞書本文をHTMLとして解釈しません。
- 外部スクリプト、広告、トラッカー、Cookie、アカウント認証を使いません。
- CSP、frame拒否、MIME sniffing拒否、権限ポリシーを応答へ付けます。
