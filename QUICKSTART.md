# Quick start

From zero to a spreadsheet of everything you have ever bought on Lazada. About five
minutes, most of which is waiting.

---

## 1. Install

1. Open **[Order History to CSV on the Chrome Web Store](https://chromewebstore.google.com/detail/order-history-to-csv/pkdjoffoinojcgeggfnodgilakeclecg)**.
2. Click **Add to Chrome**, then **Add extension**.

**Pin it, or you will not find it again.** Click the puzzle-piece icon to the right of
Chrome's address bar, find *Order History to CSV*, and click the pin next to it.
The icon then sits in your toolbar. Chrome hides new extensions by default — this step is
not optional in practice.

## 2. Export your orders

1. Go to Lazada and **sign in**. The extension only ever sees what your own session sees,
   so if you are signed out it will find nothing.
2. Open **My Orders** — your account menu → *My Orders*, or
   `https://my.lazada.co.th/customer/order/index/` (swap in your country's domain).
3. Wait for your orders to appear, then click the extension icon.
4. The popup shows how many pages it found. Click **Export all orders to CSV**.

It walks every page at a polite pace — roughly two minutes for 120 pages. You can close
the popup; it keeps going. When it finishes, your browser downloads
`lazada-orders-YYYY-MM-DD.csv`.

**One row per item, not per order.** An order containing three products becomes three
rows sharing an `orderId`. That is usually what you want for analysis; group by `orderId`
to get per-order totals.

## 3. Add purchase dates — optional, and slower

Lazada's order list does not return order dates. Not "the extension misses them" — the
API returns them as empty on every single row. Dates exist only on each order's own
detail page.

So if you need dates:

1. After the export, open the popup again. **Add purchase dates** shows how many orders
   need a date and how long that will take.
2. Click it. This reads one order at a time — budget roughly ten minutes per thousand
   orders. A fresh CSV downloads when it finishes, with `purchasedAt` filled in.

Next time, **Update with new orders** adds only what you bought since, in a few seconds,
and dates the new orders too if you added dates before.

**Skip this** if you only need what you bought, what it cost, and its status.
**Run it** if you need spending over time, or anything ordered by date.

Without dates you are not stuck: sorting by `orderId` ascending gives you oldest-to-newest
almost perfectly, because Lazada issues order ids in time order.

## 4. What you get

| Column | |
|---|---|
| `marketplace`, `accountId` | The site, and the buyer account's own ID (never an email or name) |
| `orderId`, `lineId` | Order, and the specific line within it |
| `title`, `variation`, `quantity`, `price` | What you bought |
| `status` | `paid`, `shipped`, `delivered`, `completed`, `cancelled`, … (the same words on every marketplace) |
| `itemStatus` | Line-level state such as *Refund issued* — often more interesting than `status` |
| `shopName`, `shopId`, `sellerId` | Who you bought from |
| `orderDetailUrl`, `itemUrl`, `picUrl` | Links back to Lazada |
| `purchasedAt`, `paidAt` | Only after step 3, as `2026-05-31 17:34:48` |
| `subtotal` … `orderTotal`, `currency` | The order's money as plain numbers; `totalsCheck` says whether it adds up |
| others | Other fields Lazada returned that carry data (nothing personal) |

Open it in Excel, Numbers, or Google Sheets. It is UTF-8 with a BOM, so Thai text and ฿
display correctly without any import fiddling.

---

## If something goes wrong

**The popup is missing.** It is behind the puzzle-piece icon. Pin it — see step 1.

**"Add purchase dates" says it could not record an order-detail request.** Loading an order
out of sight did not work on your account. Open one order in a tab, let it settle, come back
and click again. Still stuck? Expand **Details** in the popup — it names exactly what it saw
and what was missing.

**The count stops climbing partway.** Lazada rate-limited you. Open **Details**, raise
**Pause (ms)** to 1200, and run it again — it re-reads every page and keeps what you have.

**Nothing happens at all.** You are probably not on the order list page, or not signed in.
The popup says which.

**It found far fewer orders than you expected.** Check the filter tabs on Lazada's own
order page — if the page is filtered to *To Ship* or similar, the extension exports what
the page is showing. Set it to show all orders first.
