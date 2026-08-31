---
'@shopify/cli-kit': minor
'@shopify/store': minor
---

Add `details` to JSON fatal errors, so a raising site can attach machine-readable data instead of serializing it into a message written for a human. `store execute` uses it to carry the GraphQL `errors` array.
