# PayCo SDK 2.0.0 — 2026-11-09

## ⚠ Breaking: Charges API → Payments API

| before (1.x) | after (2.0) |
|---|---|
| `payco.charges.create(amount, { currency, customer, description })` | `payco.payments.create({ amount_minor, currency, customer, description })` |
| `payco.charges.retrieve(id)` | `payco.payments.retrieve(id)` |
| `charge.status` | `payment.state` |

- `amount` (float, major units) → `amount_minor` (integer, minor units). `19.99` dollars becomes `1999`.
- `currency` is now **required**.
- `status` is renamed to `state`. Values are unchanged.
