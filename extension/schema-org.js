// The export as schema.org Orders (JSON-LD). Loaded before content.js in the
// page, and by tools/csv-to-jsonld.js in Node, so a saved CSV converts the same
// way the extension saves. Takes the normalized rows (the CSV's columns).
//
// Standard schema.org properties carry what they can describe: one Order per
// order, an OrderItem (product, quantity, status) and an Offer (price) per line.
// Every column is also kept as text under the `ohc:` prefix (README "Columns"),
// on the Order when the order's rows agree on it and on the OrderItem when they
// don't, so a reader can rebuild the CSV's rows exactly.
(function (root) {
  const OHC = 'https://github.com/ezbz/lazada-order-csv-extractor#';
  const MARKETS = [[/^lazada\./, 'Lazada'], [/^shopee\./, 'Shopee'], [/^aliexpress\./, 'AliExpress'], [/^amazon\./, 'Amazon']];
  // The export's normalized status words, as schema.org OrderStatus values.
  const ORDER_STATUS = {
    pending: 'OrderPaymentDue', processing: 'OrderProcessing', paid: 'OrderProcessing',
    shipped: 'OrderInTransit', delivered: 'OrderDelivered', completed: 'OrderDelivered',
    cancelled: 'OrderCancelled', refunded: 'OrderReturned',
  };

  const filled = (v) => v !== undefined && v !== null && v !== '';
  const number = (v) => {
    if (!filled(v)) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const dateTime = (v) => (filled(v) ? String(v).replace(' ', 'T') : undefined);
  const status = (v) => (ORDER_STATUS[String(v || '').toLowerCase()]
    ? `https://schema.org/${ORDER_STATUS[String(v).toLowerCase()]}` : undefined);
  const link = (v, origin) => {
    if (!filled(v)) return undefined;
    try { return new URL(String(v), origin).toString(); } catch (_) { return undefined; }
  };
  // Drop the properties with no value, so the file only says what is known.
  const tidy = (o) => {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  };
  const money = (price, currency) => (price === undefined ? undefined
    : tidy({ '@type': 'PriceSpecification', price, priceCurrency: currency || undefined }));

  function toSchemaOrg(rows) {
    const byOrder = new Map();
    for (const r of rows) {
      const id = String(r.orderId == null ? '' : r.orderId);
      if (!id) continue;
      if (!byOrder.has(id)) byOrder.set(id, []);
      byOrder.get(id).push(r);
    }
    const graph = [];
    for (const rs of byOrder.values()) {
      const a = rs[0];
      const columns = [];
      for (const r of rs) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
      const text = (r, k) => (r[k] == null ? '' : String(r[k]));
      const shared = columns.filter((k) => rs.every((r) => text(r, k) === text(a, k)));
      const own = columns.filter((k) => !shared.includes(k));
      const host = String(a.marketplace || '').toLowerCase();
      const origin = host ? `https://www.${host.replace(/^www\./, '')}` : undefined;
      const market = (MARKETS.find(([re]) => re.test(host)) || [])[1];
      const currency = a.currency || undefined;
      const discount = number(a.discount);

      const order = tidy({
        '@type': 'Order',
        orderNumber: String(a.orderId),
        confirmationNumber: filled(a.orderSn) ? String(a.orderSn) : undefined,
        orderDate: dateTime(a.purchasedAt),
        orderStatus: status(a.status),
        broker: market || origin ? tidy({ '@type': 'Organization', name: market, url: origin }) : undefined,
        customer: filled(a.accountId) ? { '@type': 'Person', identifier: String(a.accountId) } : undefined,
        seller: filled(a.shopName) || filled(a.sellerId)
          ? tidy({ '@type': 'Organization', name: a.shopName || undefined, identifier: filled(a.sellerId) ? String(a.sellerId) : undefined })
          : undefined,
        paymentMethod: a.paymentMethod || undefined,
        discount: discount || undefined,
        discountCurrency: discount && currency ? currency : undefined,
        partOfInvoice: filled(a.orderTotal) ? tidy({
          '@type': 'Invoice',
          totalPaymentDue: money(number(a.orderTotal), currency),
        }) : undefined,
        orderDelivery: filled(a.trackingNumber) || filled(a.carrier) ? tidy({
          '@type': 'ParcelDelivery',
          trackingNumber: a.trackingNumber || undefined,
          provider: filled(a.carrier) ? { '@type': 'Organization', name: String(a.carrier) } : undefined,
        }) : undefined,
        url: link(a.orderDetailUrl, origin),
        orderedItem: [],
        acceptedOffer: [],
      });
      for (const k of shared) if (filled(a[k])) order[`ohc:${k}`] = text(a, k);

      for (const r of rs) {
        const quantity = number(r.quantity) || 1;
        const product = tidy({
          '@type': 'Product',
          name: r.title || undefined,
          description: r.variation || undefined,
          productID: filled(r.itemId) ? String(r.itemId) : undefined,
          sku: filled(r.skuId) ? String(r.skuId) : undefined,
          url: link(r.itemUrl, origin),
          image: link(r.picUrl, origin),
        });
        const item = tidy({
          '@type': 'OrderItem',
          orderItemNumber: filled(r.lineId) ? String(r.lineId) : undefined,
          orderQuantity: quantity,
          orderItemStatus: own.includes('status') ? status(r.status) : undefined,
          orderedItem: product,
        });
        for (const k of own) if (filled(r[k])) item[`ohc:${k}`] = text(r, k);
        order.orderedItem.push(item);
        const price = number(r.price);
        if (price !== undefined) {
          order.acceptedOffer.push(tidy({
            '@type': 'Offer',
            itemOffered: product,
            price,
            priceCurrency: r.itemCurrency || currency,
            eligibleQuantity: { '@type': 'QuantitativeValue', value: quantity },
          }));
        }
      }
      graph.push(order);
    }
    return { '@context': ['https://schema.org', { ohc: OHC }], '@graph': graph };
  }

  // The CSV's rows back from a file toSchemaOrg wrote: the Order's ohc: columns
  // and each OrderItem's own. Orders without them (written by something else)
  // are skipped; read their schema.org properties instead.
  function rowsFromSchemaOrg(doc) {
    const nodes = Array.isArray(doc) ? doc : doc && Array.isArray(doc['@graph']) ? doc['@graph'] : [doc];
    const columns = (node) => Object.fromEntries(Object.entries(node || {})
      .filter(([k]) => k.startsWith('ohc:')).map(([k, v]) => [k.slice(4), v]));
    const rows = [];
    for (const order of nodes) {
      if (!order || order['@type'] !== 'Order') continue;
      const shared = columns(order);
      if (!Object.keys(shared).length) continue;
      for (const item of order.orderedItem || []) rows.push({ ...shared, ...columns(item) });
    }
    return rows;
  }

  const api = { toSchemaOrg, rowsFromSchemaOrg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__LZX_SCHEMA_ORG__ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
