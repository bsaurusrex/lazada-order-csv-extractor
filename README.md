# Order History to CSV

Lazada has no export. This gets your entire purchase history into a CSV — every item,
price, status and shop — instead of clicking through a hundred-plus pages by hand.

Runs entirely in your own signed-in browser session. No server, no account, no analytics;
nothing leaves the tab. [Privacy policy](PRIVACY.md) · [Changelog](CHANGELOG.md) · [MIT licensed](LICENSE)

**→ [Quick start guide](QUICKSTART.md)** — install and first export, about five minutes.

Not affiliated with, endorsed by, or connected to Lazada.

## Use the extension

1. Install **[Order History to CSV from the Chrome Web Store](https://chromewebstore.google.com/detail/order-history-to-csv/pkdjoffoinojcgeggfnodgilakeclecg)**.
2. Pin it: puzzle-piece icon in the toolbar → pin **Order History to CSV**.
3. Open Lazada → **My Orders** → click the icon.

Working on the code? See [Development](#development).

### Step 1 — Export all orders to CSV

Every item you have ordered: title, variation, quantity, price, status, shop, links.
About two minutes for ~120 pages. This is the whole job for most people.

It does **not** include order dates. That is not an omission — Lazada's list API returns
`createdAt` as `null` on every row (verified across all 2,721 rows of a real export).

### Step 2 — Fetch purchase dates *(optional)*

Adds `purchasedAt`, plus totals and payment method where the detail response carries them.
Dates exist only on the order detail page, so this costs **one request per order** — roughly
10 minutes per 1,000 orders, against ~2 minutes for step 1.

It needs one sample of a detail request to replay. If none has been recorded, it loads one of
your orders in a hidden frame on the list page to record it; if that fails, open any single
order yourself and click again. Only orders without a date are read, so re-running it is cheap.
Measured on a real account: **100% of orders dated.**

### Later runs — update

Once an export exists, the main button becomes **Update with new orders**. Pages are newest
first, so it reads from page 1 and stops at the first page with nothing new, usually in a few
seconds. New rows go on top, re-read rows get their current status, and every row keeps the
dates already fetched. If you added dates before, new orders are dated too. If the last export
stopped part way, the update reads every page once instead, still keeping dates. **Start over**
(under *Details*) discards the saved export and reads everything fresh.

**Skip step 2 if** you only need what you bought, what it cost, or its current status.
**Run it if** you need spending over time, or anything ordered chronologically by date.
Without it, sort by `orderId` ascending — it is a near-perfect chronological proxy
(see *Ordering without dates*).

## Development

To run your working copy instead of the store build:

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `extension/`.
2. After editing, click the reload arrow on the extension's card, then **reload every
   marketplace tab** (Lazada, Shopee, AliExpress, Amazon). A tab opened before the reload
   keeps running the previous build's page script (`interceptor.js`) until it is reloaded,
   and errors it raises are still reported against the old line numbers.
3. Run the tests: `npm install` once, then `npm test`. Each test loads `extension/` into a
   simulated page with recorded API responses, so no browser or account is needed.
   `npm test -- amazon` runs only the tests whose file name contains "amazon".
4. Before a release, run `tools/check.sh`: syntax, popup ids against the HTML, manifest files.

An unpacked copy gets its own extension id, so it does not see exports saved by the store
build. Disable one of the two while testing, or both will attach to the same page.

### Tests and real data

Test fixtures are synthetic: order ids like `100000000000101`, order numbers like
`240501EXAMPLE3`, `example.com` addresses, and "account 1" / "account 2" for people. Shapes
can follow a real response, but never copy real order ids, order numbers, tracking numbers,
names, addresses, emails, shop names or product titles into a test, the changelog or a
commit. Your own exports (`*.csv`, `*.json`) are ignored by git; keep debugging dumps in
`debug/`, which is ignored too.

## Console alternative

`console/lazada-orders.js` does the same list export with no install: paste it into DevTools on
the order list page (type `allow pasting` first if Chrome blocks it). Verified on a real account:
**2,721 item rows across 1,224 orders, 123 pages, in about two minutes.** It has no date pass —
use the extension for that.

`console/diagnose.js` is the troubleshooting tool — it reports page structure, pager behaviour,
and records the order API, printing key *names* and counts rather than order contents.

## How it works

Lazada's order list is client-rendered, so fetching `?page=N` as HTML returns an empty shell.
The real source is:

    POST /customer/api/async/order-list        (Alibaba Ultron async protocol)

The extension records one genuine request, finds the page field by **deep** search — it sits at
`lifecycle.pageNum`, nested inside the POST body, where a top-level scan misses it — and replays
that request per page with only that field changed. `module.lifecycle.totalPageNum` gives the
true page count. If no request can be recorded, it falls back to reading the rendered DOM.

### Response shape

`module.data` is a flat entity map, not an array:

    module.lifecycle                  pageNum, pageSize, totalPageNum
    module.data.orderItem_<lineId>    title, sku.skuText, quantity, price, itemUrl, orderDetailUrl
    module.data.order_<orderId>       tradeOrderId, sequence
    module.data.orderShop_<...>       name, shopId, status, tradeOrderLineIds

One CSV row per order item. Shop data joins to items via the shop's **`tradeOrderLineIds`**, not
`tradeOrderId` — item and shop entities carry different ids in this payload, so joining on order
id silently mismatches shop names. Each row records how it joined in `_shopMatch`
(`lineId` / `orderId` / `none`); the real export came back 100% `lineId`.

### Two field traps

- **`delivery.status` is a colour token** (`success`, `info`), not a status. The human-readable
  status is `orderShop.*.status` (Delivered, Cancelled, Paid, Closed, Partially Delivered…).
- **`status` on the item** is a separate, sparser field carrying line-level states like
  *Refund issued* / *Refund completed*. It is exported as `itemStatus`.

### Dates

The list endpoint returns **no dates**. `createdAt`, `paidAt`, `paymentDes` and `orderDetailPrice`
exist as schema keys but are empty on every row — verified across all 2,615 rows of a real export.
Dates live only on the order detail page, which is client-rendered like the list, so fetching its
HTML gets you a shell.

So the detail pass uses the same record-and-replay trick, one level down:

1. You open any single order. The extension records that page's order-detail request.
2. It locates the order id inside that request by **value** — searching the body for a leaf equal
   to an id it already has — so it works without knowing the endpoint's schema.
3. It replays the request once per order with that leaf swapped, and harvests any value under a
   date-like key (`gmtCreate`, `createTime`, `payTime`, …) wherever it sits in the response.

That is one request per order (~1,200 here, a few minutes). It gives up after 8 consecutive
responses with no dates rather than grinding through a thousand failing requests. Adds
`purchasedAt`, `paidAt`, and fills `orderTotal` / `paymentMethod` where the detail response has
them. Your list export is untouched either way.

**No manual click needed:** the recorder only sees requests made in a page it is attached to, so
when no detail request has been recorded the extension loads one order's detail page in an
off-screen, same-origin frame on the list page. The interceptor runs in that one frame (it is
recognised by name; every other embedded frame is ignored) and hands the request over through
storage, just as a separately opened order tab does. No background tabs are opened. If the frame
records nothing within 20 seconds, the pass stops and asks you to open an order yourself.

### Ordering without dates

If you skip the detail pass, `orderId` is still a usable chronological proxy: on a real export,
Spearman correlation between page position and mean order id was **−0.9998** across 123 pages
(ids also widen 15→16 digits partway through, cleanly). Sorting by `orderId` ascending gives
oldest-to-newest. It gives you sequence, not calendar dates.

## Repairing an older export

`tools/clean-export.py` fixes a CSV exported before the status mapping was corrected, without
re-scraping — the right value is already in the `shop.status` passthrough column:

    python3 tools/clean-export.py output/lazada-orders-*.csv

It rewrites `status`, adds `itemStatus`, and drops always-empty columns.

## Only orders from a chosen year

The year box under the export button skips orders placed before that year, on every
marketplace, and leaves them out of every file. Blank means all years. Orders already saved
are kept, so lowering the year brings them back without reading them again.

## Columns

One row per order **item**. An order with three products is three rows sharing an `orderId`.
Every marketplace (Lazada, Shopee, AliExpress, Amazon) exports the same core columns, in the
same order and with the same meaning; a column a marketplace cannot fill is left blank.

| Column | |
|---|---|
| `marketplace` | The site the order came from: `lazada.sg`, `shopee.sg`, `aliexpress.com`, `amazon.com`, … |
| `accountId` | The marketplace's own ID for the signed-in buyer (numeric; Amazon's customer ID). Never an email, name or phone |
| `orderId`, `orderSn`, `lineId` | Order, the order number shown to the buyer where it differs (Shopee), and the line within the order |
| `purchasedAt` … `cancelledAt` | `YYYY-MM-DD HH:MM:SS` in the site's local time (`YYYY-MM-DD` where the site shows no time). Blank when unknown |
| `status`, `statusDetail` | `pending`, `paid`, `processing`, `shipped`, `delivered`, `completed`, `cancelled` or `refunded`; the site's own wording in `statusDetail` when it says more |
| `title`, `variation`, `itemId`, `skuId`, `quantity` | The item |
| `price`, `lineTotal` | Unit **list price** and `price × quantity`, as plain numbers (a free gift is `0.00`) |
| `currency`, `itemCurrency` | ISO code of the order's money columns; `itemCurrency` only when item prices are in another currency |
| `subtotal`, `shippingFee`, `tax`, `otherFees`, `discount`, `giftCardAmount`, `orderTotal` | The order's money, repeated on each of its rows: subtotal + shippingFee + tax + otherFees − discount − giftCardAmount = orderTotal (what was charged) |
| `amountPaid`, `paymentCurrency`, `exchangeRate` | What reached the card, when the site states it separately |
| `cashback`, `refundAmount` | Cashback earned, and refunds listed in the breakdown |
| `totalsCheck` | `ok` when the line above adds up to the cent, `mismatch` when it does not, blank for cancelled orders or when a figure is missing |
| `paymentMethod`, `shopName`, `sellerId`, `carrier`, `trackingNumber` | |
| `orderDetailUrl`, `itemUrl`, `picUrl` | Links back to the site |
| `charges` | Every breakdown line verbatim, `Label=Value` separated by `\|` |
| others | Fields the marketplace returned that carry data. Page-styling flags, constant or repeated copies, and anything personal (email, phone, address, names) are not exported |

### Item prices are not what you paid

`price` is the line's list price. The amount charged differs — shipping is added and
vouchers deducted at checkout. On a real account the gap was a median of ฿50 and as much
as ฿288 per order, and **summed line prices matched the charged total on none of them**.

For anything money-related, use `orderTotal` and the breakdown columns, not `sum(price)`.
On Lazada, `subtotal` is the items at list price and `discount` everything taken off between
that and the charged total (Lazada's own breakdown sometimes omits a discount or counts one twice).
Those come from the detail pass; without it you have list prices only.

### Refunds

Lazada refunds to the Lazada Wallet, so a refunded order still looks like spend unless you
account for it. Two columns carry this: `refunded` flags lines whose status is a refund
state, and `refundAmount` holds the amount when the order's breakdown lists one. Net spend
is `orderTotal - refundAmount`; the extractor does not compute it for you, because a
partial refund on a multi-item order cannot be split across lines reliably.

## Notes

- Requests are throttled (600 ms + jitter). 124 pages takes roughly two minutes.
- The extension needs no tab reload: the popup injects its scripts on demand via
  `chrome.scripting`. Only the *content-script-at-page-load* path needs a reload, and it is not
  relied on.
- If an export comes back empty, run `console/diagnose.js` and check `step4_fetch.verdict` and
  the `lzxReport()` output.
