---
'@loombox/web': patch
---

Fold the composer's toolbar into one row under the text

The composer had two strips: a mini-toolbar above it (paperclip, model/mode
pickers, context/cost) and a keyboard hint below the textarea. They are now one
row directly under the text, inside the field's own column, so everything about
the turn you are composing reads in one place.

The paperclip moved into that row, which means the drop zone now wraps the field
instead of sitting beside it. That fixes two things that silently did nothing
before: dropping a file on the textarea, and pasting an image into it. Only the
strip above was ever a live target.

The meter reports the context in use against its maximum (`76k / 200k`) instead
of a bare percentage, with a 3px track that tints amber at 80% and red at 95%,
and the agent's own name now stands in front of the model picker where the word
"Model" used to be. On a phone the pickers still collapse behind a "···", but
the cost and context stay on screen: the old strip hid the lot, so the first
thing to disappear was the number a user watches.

The `Enter to send` hint is screen-reader only now. It stays the textarea's
accessible description, it just no longer spends a row of pixels on a sentence
read once in a lifetime.
