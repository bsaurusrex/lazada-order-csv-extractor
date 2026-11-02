# Privacy Policy — Order History to CSV

_Last updated: 2 November 2026_

## The short version

This extension does not collect, transmit, or sell any data. Everything happens inside
your own browser, in your own signed-in marketplace session. There is no server, no
analytics, no account, and no third party.

## What it does

When you click **Export all orders to CSV**, the extension reads your order history from
the marketplace you are on — the same requests the order pages make when you browse them
— and writes the result to a file that your browser downloads to your computer.

The optional **Add purchase dates** step does the same against your order detail pages,
to recover dates and price breakdowns the order list does not include.

## What it reads

Only your own order data, from the marketplace's own pages and order endpoints, in your
own signed-in session:

- Lazada (`lazada.co.th`, `.sg`, `.com.my`, `.co.id`, `.com.ph`, `.vn`)
- Shopee (`shopee.sg`, `.com.my`, `.ph`, `.co.th`, `.co.id`, `.vn`, `.tw`, `.com.br`)
- AliExpress (`aliexpress.com`, `aliexpress.us`)
- Amazon (`amazon.sg`, `amazon.com`)
- eBay (`ebay.com`, `ebay.com.sg`; order details on `order.ebay.com`)

That is: item names, variations, quantities, prices, order totals and their breakdown,
order status, dates, shop or seller names, tracking numbers, and order and product links.

To tell one buyer's orders from another's, each row carries the marketplace's own ID for
the signed-in account (`accountId`): a numeric user ID, Amazon's customer ID, or eBay's
public user ID. It is never your name, username, email address or phone number.

## What it never exports

Your name, username, email address, phone number, delivery address and payment details
are left out of every file the extension writes (CSV, JSON, browsable page), even where
the marketplace includes them in its own order data. On eBay, the background worker
removes the address, payment and buyer sections from each order page before the rest of
the extension sees it.

## What it stores

The extension keeps these in your browser's local extension storage:

- the most recent order request on marketplaces where pages are read by replaying it
  (Lazada, Shopee), so it can page through your history and resume after a reload;
- your most recent export per marketplace, so the results survive navigating away;
- your settings (the "only orders from" year, the schema.org option) and the account ID
  of the last export, so a different signed-in account is never mixed into it.

All of it is local to your browser and is removed when you uninstall the extension.
**Reset everything** in the popup forgets the saved export and recorded requests.

## What it never does

- It never sends your data anywhere. Its only network requests go to the marketplace you
  are exporting from, and they are the same requests that marketplace's own pages make.
- It records only responses from the marketplaces' order endpoints. Other requests the
  sites make — cart, checkout, address book — are not recorded.
- Order data is passed between the extension's own scripts over a private channel rather
  than being broadcast into the page. Anything rendered on a marketplace page is, by the
  nature of the web, already visible to scripts that site loads there; this extension
  adds nothing to that exposure.
- It never touches passwords, payment details, or your marketplace credentials.
- It contains no analytics, telemetry, tracking, or advertising code.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `host_permissions` for the marketplace domains above | To read your order pages and call the same order endpoints those pages call. |
| `scripting` | To attach to an already-open marketplace tab, so you do not have to reload it. |
| `storage`, `unlimitedStorage` | To hold your in-progress export locally. A large history exceeds the default quota. |

There is no `tabs` permission and no `<all_urls>`. The one background worker exists for
eBay only: eBay shows order details on `order.ebay.com`, which a page on `www.ebay.com`
cannot read, so the worker fetches those order pages for the extension's own eBay tab. It
accepts no other address and answers no other site.

## Contact

Questions or concerns: open an issue on the GitHub repository.
