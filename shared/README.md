# Shared board contracts

These framework-independent TypeScript modules are the single source for the board
model, rich-text sanitization, document validation and schema migrations. Both the
Angular build and API build compile these sources directly; no separate package
installation or generated checked-in JavaScript is needed.

Existing browser import paths re-export these modules so editor callers remain
unchanged. Keep Angular, Node-only APIs and runtime side effects out of this
directory. The API's Node tests verify the contracts work without a DOM.
