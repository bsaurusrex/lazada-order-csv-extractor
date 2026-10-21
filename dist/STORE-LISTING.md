# Chrome Web Store listing — copy & answers

Paste these into the Developer Dashboard. Everything here is factual; do not
embellish it, because reviewers check claims against the code.

## Name (45 char max)
Order History to CSV

## Short description (132 char max)
Export your Lazada order history to a CSV file. Every item, price, status and shop.
Runs locally — your data never leaves the browser.

## Detailed description

Lazada gives you no way to export your purchase history. If you want it in a
spreadsheet, you are left paging through your order list by hand.

This extension does it for you. Open My Orders, click once, and get a CSV of every
item you have ever bought.

What you get, one row per item:
• Item title, variation, quantity and price
• Order status, plus line-level states such as "Refund issued"
• Shop name and seller
• Links back to the order and the product
• Other fields Lazada returns that carry data, kept as extra columns (never your email, phone or address)

Optionally, a second pass adds the date each order was placed. Lazada's order list
does not include dates, so this reads each order individually — slower, and entirely
up to you whether to run it.

The file is UTF-8 with a BOM, so Thai text and ฿ open correctly in Excel, Numbers and
Google Sheets.

Privacy: there is no server, no account, no analytics. The extension only talks to
Lazada, using your existing signed-in session, and writes the CSV to your computer.
Nothing is transmitted anywhere else. Source code is public.

Not affiliated with, endorsed by, or connected to Lazada.

## Category
Workflow & Planning

## Single purpose (required field)
Export the signed-in user's own Lazada order history to a CSV file.

## Permission justifications

host_permissions (Lazada domains):
Required to read the user's order list page and to call the same order APIs that
Lazada's own page calls. Limited to the six Lazada country domains; no other sites.

scripting:
Required to attach the extension to a Lazada tab that is already open, so the user
does not have to reload the page before exporting.

storage / unlimitedStorage:
Required to hold the in-progress export locally so it survives page navigation and
reloads. A large order history exceeds the default storage quota.

## Are you using remote code?

**No, I am not using remote code.**

Verified against the source: no `eval()`, no `new Function()`, no `importScripts`, no
`<script>` with an external `src`, and no hardcoded external URLs. The only two `fetch()`
calls target a URL captured from Lazada's own page, and the capture handler rejects any
record whose origin differs from the page's. `report.html` contains an inline script but
ships inside the package. Product images load from Lazada's CDN — images are not code.

## unlimitedStorage justification

The extension keeps the in-progress export in local extension storage so a large order
history survives page navigation and reloads — without it, clicking into an order to
enable the date step would discard the whole run. A full export on an active account is
several thousand item rows carrying product titles, variations, prices, shop names and
links, which exceeds the 5 MB default quota of chrome.storage.local. The data is written
to the user's own machine, is never transmitted anywhere, and is removed when the
extension is uninstalled.

## Data usage — what to tick

Tick these three:

- **Personally identifiable information** — Lazada returns the account's email address
  inside its own order data, so it can appear in the exported file.
- **Financial and payment information** — the export is purchase history: order totals,
  item prices, and payment method where Lazada provides it.
- **Website content** — product titles, images and links are read from the page and from
  Lazada's order API.

Leave unticked: Health information, Authentication information, Personal communications,
Location, Web history, User activity.

On **User activity** specifically: the extension does wrap `fetch`/`XMLHttpRequest` on
Lazada pages to capture the order API request. That is a mechanism, not a data category —
what it collects is order data, already declared above. There is no behavioural telemetry,
no clicks, scroll or keystrokes, and no monitoring outside Lazada domains. The
interception is described in the privacy policy. If you would rather be maximally
conservative, ticking it is defensible; it is not, in my reading, required.

## Certify all three disclosures

Tick all three — each is true:
- Does not sell or transfer user data to third parties.
- Does not use or transfer user data for anything unrelated to the single purpose.
- Does not use user data for creditworthiness or lending.

## Privacy policy URL
https://github.com/ezbz/lazada-order-csv-extractor/blob/main/PRIVACY.md

## Graphic assets — ready in `store/`

| Form field | File | Notes |
|---|---|---|
| Store icon (128x128) | `store/icon-128.png` | The extension's own mark |
| Screenshots (1280x800) | `store/screenshot-1-1280x800.png` | The extension mid-export on a real order list |
| | `store/screenshot-2-1280x800.png` | What the exported CSV contains |
| Small promo tile (440x280) | `store/tile-small-440x280.png` | |
| Marquee promo tile (1400x560) | `store/tile-marquee-1400x560.png` | |
| Global promo video | — | Optional, skip |

Screenshots and tiles are 24-bit RGB with no alpha, as the form requires.

Screenshot 1 is a real capture, redacted: other extensions removed from the toolbar
(which ones you run is fingerprintable), account name replaced, `spm` tracking token
stripped from the URL. Screenshot 2 is rendered from the real exported data.

## Before submitting

- [ ] Decide whether your own purchases should appear on a public store page.
      Screenshot 2 shows real product names and prices from this account.
- [ ] A $5 one-time Chrome Web Store developer registration fee.
