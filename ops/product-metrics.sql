WITH real AS (
  SELECT
    COUNT(DISTINCT CASE WHEN event_name = 'visited' THEN session_hash END) AS users,
    COUNT(DISTINCT CASE WHEN event_name = 'searched' THEN session_hash END) AS searchers,
    COUNT(DISTINCT CASE WHEN event_name = 'saved' THEN session_hash END) AS savers,
    COUNT(DISTINCT CASE WHEN event_name = 'copied' THEN session_hash END) AS copiers,
    COUNT(DISTINCT CASE WHEN event_name = 'entry_opened' THEN session_hash END) AS entry_readers,
    COUNT(DISTINCT CASE WHEN event_name = 'returned' THEN session_hash END) AS returned,
    COUNT(CASE WHEN event_name = 'searched' THEN 1 END) AS successful_searches,
    COUNT(CASE WHEN event_name = 'no_result' THEN 1 END) AS no_result_searches,
    COUNT(DISTINCT CASE WHEN event_name = 'searched' AND created_at >= unixepoch() - 604800 THEN session_hash END) AS searchers_7d,
    COUNT(DISTINCT CASE WHEN event_name = 'saved' AND created_at >= unixepoch() - 604800 THEN session_hash END) AS savers_7d
  FROM product_events
  WHERE is_qa = 0
),
qa AS (
  SELECT COUNT(*) AS qa_rows FROM product_events WHERE is_qa = 1
),
dictionary AS (
  SELECT
    CAST(MAX(CASE WHEN key = 'entry_count' THEN value END) AS INTEGER) AS entries,
    CAST(MAX(CASE WHEN key = 'term_count' THEN value END) AS INTEGER) AS terms,
    MAX(CASE WHEN key = 'source_sha256' THEN value END) AS source_sha256
  FROM dictionary_meta
)
SELECT real.*, qa.qa_rows, dictionary.entries, dictionary.terms, dictionary.source_sha256
FROM real CROSS JOIN qa CROSS JOIN dictionary;
