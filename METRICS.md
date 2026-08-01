# Metrics

`product_events` stores no search text.

- `visited`: first page interaction in a session
- `searched`: a search returned at least one entry
- `no_result`: a search returned no entry
- `entry_opened`: a dictionary entry page was opened
- `saved`: an entry was placed in the browser's word-card stack
- `copied`: a spelling or reading was copied
- `returned`: the browser returned on a later JST date

`session_hash` is SHA-256 of the random browser ID. `entry_id` is optional and is not user-authored content. `is_qa=1` separates automated checks. Rows expire after 35 days.
