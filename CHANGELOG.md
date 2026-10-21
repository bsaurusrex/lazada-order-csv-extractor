# Changelog

Every release of Order History to CSV (named Lazada Order CSV Extractor up to 2.2.2).
Newest first.

## Development — 2026-10-21

- Tests in `tests/` (`npm install`, then `npm test`): 18 end-to-end tests that run
  `extension/` against recorded, synthetic API responses for Lazada, Shopee, AliExpress and
  Amazon. `tools/check.sh` syntax-checks them too.
- README: development steps for four marketplaces, the stale-tab note, and the rule that
  fixtures stay synthetic.

## 2.9.0 — 2026-10-21

**Added: "Only orders from" a chosen year**
- A year box under the export button. Orders placed before that year are skipped and left
  out of every file (CSV, JSON, browsable page). Blank means all years. One setting for
  every marketplace; it is remembered until changed.
- Amazon does not list the earlier years at all, so they cost no time. AliExpress and
  Shopee list newest first and stop at the first page whose orders are all older. Lazada's
  list has no dates, so it still reads every page; older orders are left out once dated,
  and the date pass does not read orders already known to be older.
- Rows already saved are kept, only left out of the files, so lowering the year brings them
  back. An export that stopped at the cutoff counts as complete for that year and later;
  choosing an earlier year reads the missing pages on the next update.
- Orders with no date yet are never left out. The popup shows how many orders are left out.

## 2.8.2 — 2026-10-21

**Fixed: AliExpress totals**
- Discounts with other wording, such as "Spend & save", were missed, so `discount` came out
  too low. Every negative line in the breakdown now counts as a discount.
- AliExpress lists a shipping line it hides from the buyer and does not charge (S$0.01 or
  S$0.02, with a total of subtotal + tax). When the shipping fee is exactly what stops an
  order adding up, `shippingFee` is 0. Breakdown lines AliExpress hides are marked
  "(not shown)" in `charges`.
- Both are applied when the CSV is written, so exports saved by earlier versions are fixed
  without re-reading.
- `totalsCheck` allows one cent, because AliExpress rounds tax per item and its own lines can
  differ from its total by S$0.01.

## 2.8.1 — 2026-10-21

**Fixed**
- chrome://extensions reported errors at `interceptor.js` on Amazon order pages. They were
  Amazon's own failed requests (blocked trackers, aborted calls), blamed on the extension
  because it wrapped every page request. Amazon is read from its order pages directly, so
  nothing recorded there was ever used: the interceptor now leaves Amazon's fetch and XHR
  alone. Lazada, Shopee and AliExpress are unchanged.

## 2.8.0 — 2026-10-21

**Changed: one export layout for every marketplace**
- Every CSV starts with the same core columns in the same order (`marketplace`, `accountId`,
  `orderId`, `orderSn`, `lineId`, the six dates, `status`, item columns, `currency`, the
  order's money, `totalsCheck`, payment, shop, tracking, links, `charges`), blank where a
  marketplace has no such data. Other columns follow only when they carry data.
- Money columns are plain numbers: Lazada's `price` was `$3.25` (and `FREE` for gifts), now
  `3.25` (`0.00`). Two decimals, none for IDR, VND, JPY and KRW.
- `lineTotal` (price × quantity) on Lazada too.
- Dates: `1970-01-01 08:00:00` (Lazada's "never paid") is now blank.
- `status` uses one vocabulary everywhere: `pending`, `paid`, `processing`, `shipped`,
  `delivered`, `completed`, `cancelled`, `refunded`. The site's own wording moves to
  `statusDetail` when it says more than that.
- New `marketplace` column (`lazada.sg`, `shopee.sg`, `amazon.com`, …) so exports can be
  combined.
- New `totalsCheck`: `ok` when subtotal + shippingFee + tax + otherFees − discount −
  giftCardAmount = orderTotal to the cent, `mismatch` when not, blank for cancelled orders.
- Saved exports are normalized when written, so exports saved by earlier versions come out
  in the new layout without re-reading.

**Removed**
- Personal data: `raw.buyerEmail` and `raw.delivery.email` (Lazada) are no longer exported,
  nor any other column named for an email, phone, address or name.
- Raw columns with no order data: always-blank columns, page-styling flags (colours, icons,
  link and banner settings), constants, and raw copies of a core column (`raw.price`,
  `raw.title`, `shop.status`, …). On Lazada that is about 85 of 145 columns.
- The JSON export (the raw responses) drops every email, phone, address and name field at
  any depth, and blanks any email address found inside other text.

**Added: Lazada `accountId`**
- The buyer's numeric Lazada user ID, from the `lzd_uid` cookie (the only cookie read,
  digits only). Lazada order and item numbers end in the same five digits as this ID, so it
  is used only for orders whose number ends in them; a row can never get another account's
  ID. Older saved exports get it the same way.

**Fixed: Lazada totals**
- `subtotal` is now the items at list price. Lazada's own subtotal sometimes already had the
  item discount taken off and sometimes not, so the discount was counted twice.
- `discount` is everything taken off between that subtotal (plus shipping) and the charged
  total. Lazada lists the shipping discount twice ("Shipping Fee Voucher" and "Shipping Fee
  Promotion") and on some orders omits a discount altogether.
- Wallet money spent on an order ("Cashback Balance") is `giftCardAmount`, not a discount.
- Orders from 2018-19 show shipping discounts 100 times too large, which made `orderTotal`
  negative; the package's own total is used for those.
- Multi-package orders: `shippingFee` and `orderTotal` come from Lazada's order-level
  summary, which covers every package. The package lines kept only the first package's
  shipping. Lazada details are now version 4, so "Add purchase dates" re-reads each order
  once. The summary is kept in a new `orderSummary` column.

## 2.7.2 — 2026-10-20

**Fixed: Amazon currency and charge summary**
- `currency` on Amazon rows is now the currency the order was charged in, read from the
  charge summary's own symbol (`S$` SGD, `$`/`US$` USD), not the site. An amazon.com
  order can be charged in SGD while its item prices are shown in USD.
- Labels without a colon (`Free Shipping -$5.00`, `Deals and Discounts`) are read.
  Free-shipping lines count as `discount`.
- Promo credits (for example "Amazon Move Promo") count as `discount`.

**Known limit**
- Amazon hides tax on orders older than 10 years, so those orders' totals exceed
  subtotal + shipping by the hidden tax. `tax` stays blank rather than guessed.

**Added** (Amazon)
- `itemCurrency`: set only when the item prices are in a different currency from the
  order (for example USD items on an SGD-charged order), so `price` and `lineTotal`
  are in `itemCurrency` and the order columns are in `currency`.
- `exchangeRate`: the rate the summary shows, as `1.3500 USD->SGD`.
- `otherFees`: exchange-rate guarantee fees, import fee deposits, customs and duty.
  The order reconciles as subtotal + shippingFee + tax + otherFees - discount -
  giftCardAmount = orderTotal.
- `amountPaid` and `paymentCurrency` from "Payment Grand Total" when the page shows it.

## 2.7.1 — 2026-10-20

**Added**
- `currency` (ISO 4217 code) on every row, for every marketplace. Lazada and Shopee rows
  had none.
  - Lazada and Shopee: from the site's country domain (`.sg` SGD, `.com.my` MYR, `.co.th`
    THB, `.co.id` IDR, `.ph`/`.com.ph` PHP, `.vn` VND, `.tw` TWD, `.com.br` BRL).
  - AliExpress: the order's own `currencyCode` (an account can hold orders in more than
    one currency), with the site currency as a fallback.
  - Amazon: amazon.sg SGD, amazon.com USD.
  - Saved exports from earlier versions get the site's currency when restored. The
    browsable page also carries the column.

## 2.7.0 — 2026-10-20

**Added: Amazon** (amazon.sg, amazon.com)
- Amazon has no order API. On the order-history pages the card contents are encrypted
  and only decrypted by page script, but each card names its order number in plain HTML
  (`data-csa-c-slot-id="amzn1.yourorders.order-card.<order number>"`). Export collects
  order numbers from every year the page offers (`timeFilter=year-YYYY`, 10 per page),
  then reads each order's detail page (`/your-orders/order-details`, plain HTML). That
  page gives the order date, items (title, ASIN, unit price, quantity, seller) and the
  charge summary: items subtotal, delivery, GST/tax, promotions, gift card and grand
  total. There is no separate list-only step; "Add purchase dates" only re-reads orders
  whose detail page failed.
- `accountId` for Amazon is the customer ID (`"customerID"` in the page config, `A`
  plus 8–20 upper-case letters or digits). Amazon has no numeric user ID; the customer
  ID carries no personal data and was chosen deliberately for Amazon only. amazon.sg and
  amazon.com keep separate saved exports and account IDs.
- Amazon Fresh orders use a different detail layout ("ufpo"): order date from "Ordered
  on …", items from the `<ASIN>-item-total-price` rows (line total and quantity), and
  charge lines that may lack a colon ("Deals and Discounts"). Items credited as out of
  stock ("OOS (n)") are still listed; their credit goes to `refundAmount`. These orders
  are marked `statusDetail` = "Amazon Fresh".
- Quantity above 1 is read from the image badge (`.od-item-view-qty`) when the quantity
  field is empty. "Estimated GST" counts as tax.
- Some Amazon item prices include GST while "Item(s) Subtotal" excludes it. Line totals
  are reported as shown, so they can exceed the subtotal by up to the GST; order totals
  still reconcile.
- Not read: payment method (filled in by page script), tracking, and the shipping
  address. New column: `giftCardAmount`.

## 2.6.1 — 2026-10-20

**Added**
- New column `accountId` on every row: the marketplace's own numeric user ID for the
  signed-in buyer, so a ledger can key orders to an account across separate exports.
  - Shopee: `data.userid` from `/api/v4/account/basic/get_account_info` (the request the
    order page makes itself), with the numeric `SPC_U` session cookie as a fallback.
  - AliExpress: `x_alimid` from the `aep_usuc_f` cookie. The order APIs carry no buyer
    ID. Only this one numeric field is read; the neighbouring `xman_*` cookies hold
    personal values and are never touched.
  - Lazada: a numeric buyer-ID field on the order list (`buyerId`, `buyerUserId`,
    `userId`, `memberId` or `customerId`) if present, else blank.
  - Numeric IDs only. Email, name, username, phone and address are never used for this;
    when no numeric ID is available the column is blank.

**Changed**
- Account switches are detected by `accountId` (falling back to Lazada's existing
  check). An update signed in as account 2 never merges account 1's saved rows. Requests
  recorded while account 1 was signed in are discarded once account 2 is detected, so
  they are never replayed for it.
- An export without an `accountId` (made before this version) is not merged into a
  Shopee or AliExpress update. The update starts fresh and keeps fetched dates for orders
  the signed-in account's list returns again.
- "Add purchase dates" refuses to run when the export belongs to a different account than
  the one signed in, or when the signed-in account cannot be confirmed.
- "Reset everything" also clears the stored account ID.
- The popup shows the account as `ID …` plus the last three digits when a numeric ID is
  known.

## 2.6.0 — 2026-10-20

**Added: AliExpress** (aliexpress.com, aliexpress.us)
- The order list (`mtop.aliexpress.trade.buyer.order.list`) is read through the page's own
  signed mtop client, via a new allowlisted `mtop` command in `interceptor.js` (v3). These
  calls are JSONP and signed per request, so they cannot be recorded and replayed. Pages
  chain: each "load more" POST repeats the list body with the next `pageIndex` and the
  previous response's linkage. Duplicate orders repeated at page edges are dropped.
- "Add purchase dates" makes two calls per order: `…order.detail` (paid / shipped /
  completed dates, payment method, subtotal / shipping / tax / total) and
  `mtop.ae.ld.querydetail` (tracking number, carrier, delivered time, and the exact
  order-placed time). Address and phone are never read into the export.
- Cancelled and expired orders put the close date in `cancelledAt`. New columns:
  `currency`, `tax`, `shopUrl`.

## 2.5.10 — 2026-10-20

**Fixed**
- Shopee `deliveredAt` kept 2.5.8's wrong value (the ship time) on orders with no
  "Delivered" tracking event. Shopee keeps only an "Order placed" event for older
  orders. Detail fields are now rewritten, blanks included, whenever an order is
  re-read, so these show blank instead of a wrong time.

## 2.5.9 — 2026-10-20

**Fixed**
- Shopee `shippedAt` was the shipment-arranged time (seconds after payment), and
  `deliveredAt` was the ship time. The extension's detail request carries the desktop
  page's `x-api-source: pc`, so Shopee answers with the `pc_` layout. There,
  `delivery_time` is when the parcel shipped out (verified against `label_odp_ship_time`
  on the same order). `shippedAt` now uses it, and `deliveredAt` is the "Delivered" event
  in the tracking history.
- `coinsEarned` was scaled by 100,000 (e.g. 100000000 → 1000).

## 2.5.8 — 2026-10-20

**Added (Shopee, from the dates pass)**
- `shippedAt`, `deliveredAt`, `completedAt`, `cancelledAt`, `cancelReason`, `carrier`,
  `trackingNumber`, `parcels`, `amountPaid`, `coinsEarned`. Both detail layouts are read:
  newer `processing_info.info_rows` / `shipping`, and older `pc_processing_info` /
  `pc_shipping`. The columns sit beside the dates. Shopee orders are offered once more to
  fill them (details version 7).

## 2.5.7 — 2026-10-20

**Fixed**
- Shopee `orderSn` (the order number shown in the app) was always empty. It is not in
  the order list; the dates pass now reads it from the detail response
  (`processing_info.order_sn` / `pc_processing_info.order_sn`). Shopee orders are offered
  once more to fill it (details version 6), and it carries over on updates.

## 2.5.6 — 2026-10-20

**Fixed**
- The browsable page saved from Shopee was titled "My Lazada purchases" and showed no
  currency. The page now takes the marketplace name and, for Shopee's plain-number
  prices, the currency symbol from the export (`$`, `RM`, `₱`, `฿`, `Rp`, `₫`, `NT$`,
  `R$`). Pages saved by older builds still read as Lazada.
- `debug/` is git-ignored: exports dropped there (including the HTML page, which
  `*.json`/`*.csv` did not cover) hold real order data.

## 2.5.5 — 2026-10-20

**Fixed**
- Shopee `subtotal` showed the order total. The list's `info_card.subtotal` equals
  `final_total` (shipping included), so it is no longer used. The merchandise subtotal
  comes from the order-detail breakdown. Shopee orders are offered once more to
  correct it (details version 5), so "Add purchase dates" is enabled again.
- Shopee prices and totals are written with two decimals (`79.00`, not `79`).
- Rating prompts ("completed enabled buyer has not rated") no longer fill `statusDetail`.

## 2.5.4 — 2026-10-20

**Fixed**
- Shopee export fell back to reading the page even after the signing fix, and missed
  orders. Requests are only replayed if recorded since the content script attached.
  After an extension reload the tab's order-list call predates that, and scrolling to
  record a fresh one fires nothing once every order is already on screen. Shopee now
  makes the first `get_all_order_and_checkout_list?limit=20&offset=0` request itself,
  through the page so it is signed, and uses it once verified. The list is a GET whose
  only state is the session cookie, so this is safe for the account in use.

## 2.5.3 — 2026-10-20

**Added**
- Shopee dates pass also reads the price breakdown from `get_order_detail`
  (`info_card.parcel_cards[].payment_info.info_rows`: merchandise subtotal, shipping,
  vouchers, coins). It fills `subtotal`, `shippingFee`, `discount` and `charges`.
  Shopee orders dated by 2.5.0–2.5.2 are offered once more to pick this up
  (Shopee details version 4; Lazada stays at 3).

**Fixed**
- After an export that fell back to reading the page, the next API export or update
  replaces those page rows instead of adding a duplicate of every item. Purchase dates
  and payment methods already fetched carry over by order id.

## 2.5.2 — 2026-10-20

**Fixed**
- Shopee export and "Add purchase dates" timed out ("Detail fetch failed: timed out")
  after reloading the extension without reloading the Shopee tab. The previous build's
  interceptor stayed in the page; it answered the handshake but could not serve signed
  replays, and the new one stepped aside because of its "already installed" flag. The
  guard is now versioned: a newer interceptor installs its replay port next to an older
  one, without wrapping fetch/XHR a second time. Content uses only a v2 port for
  replays, and if none exists it stops at once with "reload the page" instead of waiting
  30 s per order.

## 2.5.1 — 2026-10-20

**Fixed**
- Shopee export failed with "Shopee refused the request (error 90309999)". Shopee's
  security SDK wraps the page's `fetch` and signs every API call (`x-sap-*` headers);
  the content script's own `fetch` is the unwrapped original, so replays went out
  unsigned. Shopee replays (list pages and order details) now run in the page through
  `interceptor.js` over the private MessagePort, same-origin only. Recorded one-time
  signature headers are dropped so fresh ones are added. Lazada is unchanged.
- If Shopee still refuses the API, the export falls back to reading the page
  (scrolling to the end) instead of stopping.

## 2.5.0 — 2026-10-20

**Added: Shopee** (shopee.sg, .com.my, .ph, .co.th, .co.id, .vn, .tw, .com.br)
- API export reads `/api/v4/order/get_all_order_and_checkout_list`
  (`new_data.order_or_checkout_data[].order_list_detail`), plus the older
  `data.details_list` shapes. Money arrives scaled by 100,000 and is converted.
- Offset pagination: page N is replayed as `offset=(N-1)*limit`. Shopee gives no page
  count, so the run reads until `next_offset` is -1 or a page comes back empty.
- New Shopee columns: `statusDetail` (e.g. "cancelled by system"), `unitPricePaid`
  (`order_price`), `lineTotal`, `priceBeforeDiscount`; `subtotal` and `orderTotal` from
  the list.
- DOM fallback: tries `[class*="OrderShopSection"]` etc. first, then a structural reader
  anchored on order links, the "Order Shop/Item List Section" screen-reader headings,
  `x1` quantity markers and price leaves. The live site's classes are hashed.
  It scrolls to the end first so every order is on the page.
- Dates pass works with Shopee's GET `get_order_detail?order_id=…`: the id is swapped
  in the URL, and dates come from `processing_info.info_rows` (Unix seconds).

**Changed**
- `parseUltron` is renamed `parseLazadaAPI`; `pickCapture` routes by host.
- Shopee keeps its own saved export and captures (`lzx_*_shopee`), separate from
  Lazada's.
- Files are named `shopee-orders-…` / `lazada-orders-…`.

## 2.4.1 — 2026-09-25

**Fixed**
- Purchase and payment dates are now real, sortable timestamps (`2026-05-31 17:34:48`).
  Before, they held Lazada's display text ("Placed on 31 May 2026  17:34:48"). That text
  broke the year filter, the date column and the date sort on the browsable page.
- An in-transit order no longer gets its delivery estimate ("Get by 25 Sep") as its
  purchase date. A payment time is never used as a purchase date either.
- An export saved by 2.4.0 is converted when it loads, so you don't need to re-fetch
  dates. Orders that only had an estimate become undated, and **Add purchase dates**
  re-reads just those.

## 2.4.0 — 2026-09-24

**Added**
- **Update with new orders.** After your first export, the main button tops it up. It
  reads newest pages first and stops once it reaches orders it already has, so an update
  takes seconds instead of two minutes. Statuses of recent orders are refreshed, and dates
  already fetched are kept.
- **Stop.** While an export or the dates pass is running, the main button stops it.
  Whatever was read so far is kept and saved.
- **Start over**, under Details, throws away the saved export and reads every page again.
- New orders are dated automatically after an update, as long as your earlier export had
  dates.

**Changed**
- Add purchase dates no longer asks you to open an order first. It opens one out of sight
  to learn how to read dates.
- Add purchase dates only reads orders that don't have a date yet, and the button shows
  how many are left.

**Fixed**
- Lazada always reports one more page than it has. That empty last page is now treated
  as the end, not an error.
- Save as browsable page could save two copies.
- Opening Details looked like it did nothing, because it opened below the bottom of the
  popup.

## 2.3.2 — 2026-09-14

**Fixed**
- If the popup fails to start, it now shows the error instead of an empty box.

## 2.3.1 — 2026-09-11

**Security**
- Other scripts on the Lazada page could reach your exported order history. The download
  link is no longer placed on the page, and captured order data no longer travels over a
  channel other scripts can read.
- Only order requests are recorded. Before, cart, checkout and address-book responses
  could be recorded too.
- The debug sample no longer includes request headers, which carry session tokens.
- The browsable page only links to `http`/`https` addresses.

**Fixed**
- Prices in Indonesia and Vietnam (`Rp1.200.000`) were read as `1.2`, so every money
  column in those markets was off by about a million.
- A product title containing `$'` broke the browsable page.
- An export from one Lazada country could be restored and downloaded on another. Each
  country now keeps its own.
- An order id containing certain characters stopped the dates pass.
- Dates sent as raw timestamps showed as the year "1757".
- The dates pass reported success even when it had dated nothing.
- The browsable page showed ฿ for every country.

## 2.3.0 — 2026-09-11

**Added**
- **Save as browsable page:** a single HTML file with product photos, search, filters,
  sorting and paging. It opens offline, with nothing to install.

**Changed**
- Renamed to **Order History to CSV**.
- Charged totals are found on 1,034 of 1,224 orders, up from 37.

**Fixed**
- Shipping vouchers and delivery lines were counted as the shipping fee.
- Only the first of several discount lines was kept. All are now added up.
- Cashback was counted as a refund. It now has its own column.

## 2.2.2 — 2026-09-10

**Fixed**
- Clicking **Save a detail sample** before the popup was ready caused an error.

## 2.2.1 — 2026-09-10

**Fixed**
- The popup could freeze on "Checking this page".

## 2.2.0 — 2026-09-10

**Added**
- The amount actually charged for each order, with subtotal, shipping, discount and
  refund. Item prices are list prices, so adding them up gave the wrong spend by a median
  of ฿50 per order.
- A refund amount per order, and a refunded flag on each item.
- **Save a detail sample**, for mapping fields the extension doesn't recognise yet.

## 2.1.0 — 2026-09-10

First release.

- Exports your whole Lazada order history to CSV, one row per item, with title,
  variation, quantity, price, status and shop.
- Optional second pass to add purchase dates, which Lazada's order list does not return.
- Runs in your browser against your own signed-in session. No server, no telemetry.
