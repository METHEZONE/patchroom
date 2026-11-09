// PayCo SDK v2.0.0 (vendored). In-memory sandbox: no network calls.
// BREAKING: `charges` was replaced by `payments`. Amounts are integer minor units.
// `status` was renamed to `state`. `currency` is required.

const VERSION = '2.0.0';

export function createClient({ apiKey } = {}) {
  if (!apiKey) throw new Error('PayCo: apiKey is required');
  const store = new Map();
  let seq = 0;

  const payments = {
    /**
     * @param {{amount_minor: number, currency: string, customer?: string, description?: string}} params
     */
    async create(params) {
      if (params === null || typeof params !== 'object') {
        throw new TypeError('PayCo 2.0: payments.create expects a params object ({ amount_minor, currency })');
      }
      const { amount_minor, currency, customer = null, description = null } = params;
      if (!Number.isInteger(amount_minor) || amount_minor <= 0) {
        throw new TypeError('PayCo 2.0: amount_minor must be a positive integer (minor units, e.g. cents)');
      }
      if (typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) {
        throw new TypeError('PayCo 2.0: currency is required (lowercase ISO 4217, e.g. "usd")');
      }
      const payment = {
        id: `pay_${++seq}`,
        object: 'payment',
        amount_minor,
        currency,
        customer,
        description,
        state: 'succeeded',
      };
      store.set(payment.id, payment);
      return payment;
    },
    async retrieve(id) {
      const p = store.get(id);
      if (!p) throw new Error(`PayCo: no such payment ${id}`);
      return p;
    },
  };

  return { VERSION, payments };
}
