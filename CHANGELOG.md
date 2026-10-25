# Changelog

Every release of Order History to CSV (named Lazada Order CSV Extractor up to 2.2.2).
Newest first.

## 2.5.0 — 2026-10-25

**Added**
- A **schema.org format** checkbox under the save buttons. Ticked, **Save schema.org JSON**
  saves the export as schema.org `Order`s (JSON-LD, `.jsonld`), one per order with its items,
  prices, currency, shop and status, so other apps can read it without knowing the CSV's
  columns. The choice is remembered.

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
