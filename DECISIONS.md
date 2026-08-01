# Decisions

## Product boundary

瞬辞 is a fast Japanese–English word lookup and local word-card tool. It is not a Japanese monolingual dictionary, sentence translator, professional translation service, or source of legal/medical interpretation.

## Dictionary ownership

JMdict provides a legally reusable, maintained source. Derived database records remain CC BY-SA 4.0, are attributed in the product, and can be regenerated with the public build script. Application code remains MIT.

## Privacy

Search text uses POST JSON so it does not enter URLs or access logs. No query text is persisted. Word cards stay in localStorage. Product metrics contain only an irreversible session hash, an action name, an optional dictionary entry ID, QA status, and timestamp; rows expire after 35 days.

## Interface

The interface is a compact dictionary card and a stack of saved index cards. It avoids giant headings, gradients, decorative photography, and explanations about product research. Better Auth is unnecessary.
