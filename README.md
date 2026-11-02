# Fin

Fin is a personal finance tracker to replace Buxfer: accounts in EUR or USD (converted at the daily ECB rate), credit cards and investments, rule-based categories, transfers, stock and ETF holdings with live prices, and CSV import and export. Served at `/tools/finance/`.

Data is stored in a Supabase project (Postgres) and you sign in with an emailed link, so the same data is available on every device. The browser keeps only the sign-in session and a few display preferences.

| File | What it is |
| --- | --- |
| `index.html` | The page: tool header, account panel, main area, dialogs. |
| `app.js` | UI: rendering, forms, dialogs, CSV import and export, start-up and sign-in. |
| `model.js` | Pure logic: money in cents, categories by rule, balances, transfers, net worth, CSV parsing and import mapping. No DOM, no I/O. |
| `model.test.mjs` | The spec for `model.js`. |
| `store.js` | Loads the signed-in user's data and saves changes: compares with the last saved copy and sends only added, changed or removed rows. |
| `cloud.js` | Supabase over plain `fetch`: email-link sign-in and table access. No SDK. |
| `market.js` | Exchange rates (Frankfurter), symbol search and US prices (Twelve Data), non-US prices (Alpha Vantage). |
| `schema.sql` | Database tables and row-level security. |
| `config.js` | Your Supabase project URL and anon key. |
| `finance.css` | The tool's styles, on the shared tokens (see `STYLEGUIDE.md`). |

## Set up the database (once)

1. Create a free project at [supabase.com](https://supabase.com).
2. In **SQL editor**, paste `schema.sql` and run it.
3. In **Authentication → URL configuration**, set **Site URL** to `https://ivogomes.com/tools/finance/` and add `http://localhost:4000/tools/finance/` under **Redirect URLs**.
4. In **Project settings → API**, copy the project URL (`https://<project-ref>.supabase.co`, not the dashboard address in your browser bar) and the `anon` public key into `config.js`. The anon key is meant to be public; the row-level security policies in `schema.sql` are what keep data private.
5. Open the tool, sign in with your email, and click the link.
6. Once your account exists, turn off **Authentication → Sign In / Providers → Allow new users to sign up**, so nobody else can create an account in your project.

The default email sender in Supabase is rate-limited (a few emails an hour). That's enough for signing in on your own devices.

## Run it

```bash
npm run preview        # from the repo root, serves at http://localhost:4000
# then open http://localhost:4000/tools/finance/
```

Tests: `node --test tools/finance/model.test.mjs`. On this machine the `node` shim needs a version, so use `MISE_NODE_VERSION=22.19.0 node --test …`.

### After an update that adds a table

`schema.sql` only creates what's missing, so running the whole file again is safe and keeps your data. Do this when a new feature needs a table (scheduled transactions added `schedules`); until then the app loads normally and says which feature can't save yet.

## Pages

Each section in the header (Accounts, Search, Scheduled, Insights, IOUs, Settings) and the Net worth page is its own page with its own address, e.g. `/tools/finance/?page=search`, `?page=settings&section=backup` or `?account=<id>&tab=insights`; `/tools/finance/` opens the last account. Going to another section loads that page with fresh data, so switching sections also picks up changes made on another device.

Not every page loads every transaction. Account totals (balances, counts, what's coming in the next 30 days) are worked out by the database (`account_summaries` in `schema.sql`), and a change you make shows in them at once; they're checked against the database again after each save. An account page asks the database for the 100 transactions it shows, with their running balance and filters applied (`account_transactions`), and the suggestions when adding transactions come from `description_index`. Search asks the database for one page of results with their In and Out totals (`search_transactions`), and Insights for the period's sums per day and per category (`insight_totals`, the same rules as `insightTotals` in `model.js`); the app groups those into weeks or months and parent categories. Net worth (and an investment account's Insights tab) asks for each account's running total at the end of each week or month (`balances_at`); investments are then valued from their holdings in the app. No page loads every transaction up front: the IOUs page fetches just the ones its entries are linked to, and the Settings pages that work on all of them (categories, rules, backup, imports, link transfers, export) load them when opened. A backup always has every transaction, wherever it's downloaded from. Anything waiting to be saved is sent first, and leaving with something typed but not saved asks first. Moving between accounts, account tabs and settings pages stays instant, and the address follows, so reloading or bookmarking keeps you there.

## Adding transactions from the keyboard

**Add transactions** opens a grid of rows. Typing a description suggests earlier ones (names starting with it first, then words starting with it, then ones containing it; within that, the account's own, the most used and the most recent). ↓/↑ move through them; Enter or Tab take one, filling in its category and whether it was an expense, income or refund (not the amount, which is rarely the same), then jump to the amount. A suggestion is pre-selected only when it starts with exactly what you typed, so a new description is never swapped for an old one by accident. Enter in any field goes to the next row, and there's always an empty row at the end; Ctrl+Enter (⌘+Enter on a Mac) saves them all.

A row can be a transfer: pick **⇄ Transfer** as its type and the category cell becomes the account the money goes to (the row's account is where it leaves from). Past transfers are suggested too, filling in both accounts. Between currencies the received amount is converted at that day's rate. The single-transaction form suggests descriptions the same way, and so does the inline edit form, where a suggestion fills in the description and, if the transaction has none, its categories.

## Search, filters, selecting and undo

Each account's transactions have a filter bar: text (description, memo, or an amount such as `12.99`), category (a parent includes its children; "Uncategorized" too), type, dates and amount range. **Search** in the header does the same across every account, archived ones included, with totals in and out. Rows have checkboxes (and one for the whole page); with any selected, a bar sets, adds or removes categories, or deletes them. Deletes and bulk changes show a message with **Undo** (also Ctrl/⌘+Z while it shows): account, transaction, holding, lot, IOU entry, schedule and category deletes.

When you categorize a transaction by hand and no rule would already do that, the app offers "Always put … in …?". The rule matches the whole description, goes to the top of the list (the first match wins), and can fill in the other uncategorized transactions with that description at the same time.

## On a phone

On small screens the account panel folds behind an **Accounts** button, the header tabs scroll sideways, transactions stack as cards, dialogs fill the screen, and a round **+** button opens quick entry for the account on screen. The tool installs as an app (manifest and icons in this folder; `sw.js` keeps the app's own files so it opens instantly, while data always comes from the database). The app's "Add transactions" shortcut opens `?add`.

## Categories

Two levels, like Buxfer: a category is top-level or sits under one, and is shown as "Parent / Child". A transaction can have several categories (chips you add and remove in the table or the edit form). Rules add one category when a transaction has none. Settings → Categories lists the tree with how many transactions use each one; deleting a category removes it from those transactions (they stay), deletes rules that set it, and moves its subcategories to the top level. Imports read several categories separated by commas, each possibly a path; Buxfer's `tags.csv` builds the whole tree.

## Credit cards

A credit card account can have a credit limit (Edit account). It then shows what's left to spend, the limit less what's owed, with how much of the limit is used. Its Insights tab is about spending only: no income, net or savings.

## Charts over time

Balances, net worth, investment values and holding prices are drawn as one line on one scale: the left axis gives the amount, the right axis the same gridlines as the change since the start of the period, and the line is green above where it started and red below (that level is marked). An account's Insights tab starts with its balance over the period; an investment's value has what was put in as a dashed line.

## Insights

**Insights** in the header covers all accounts (archived ones included); each account also has an Insights tab. Pick a period (this or last week, month or year, the last 30 or 90 days, the last 12 months, all time, or a custom range). It shows income, spending, net and the share of income saved, a chart of income against spending by day, week, month or year (with a table view), and spending and income per top-level category, each opening onto its subcategories.

What counts: transfers between your accounts and opening balances don't. A transaction counts after its IOU entries, so a loan or its repayment counts as nothing and a shared bill counts only your share. A refund (a transaction of kind "refund", marked ↩) is money back on an expense: it lowers spending and never counts as income. It lowers spending in its first category that is a spending one; categories that take in more than goes out across all your history (a salary, say) are skipped, as a refund tagged with one only says where the money came from. A refund with no spending category lowers spending on its own line, "Refunds with no expense category". A category can show negative spending when more came back than was spent in the period. Amounts are in EUR at each transaction's own rate. A transaction with several categories counts under its first one, so the categories add up to the total.

## Holdings and their buys and sells

A holding can have lots: its buys and sells, each with a date, units, price and fees. With lots, its units come from them, and the holdings table shows what it cost (and the average price) and the gain. Open a holding's **Lots** to see them, add a buy or sell, or delete one.

Settings → **Import holdings (FT.com)** reads an FT.com portfolio transactions export (`Date,Name,Symbol,Type,Quantity,Price,…`, symbols like `VWCE:FRA:EUR`). Pick the investment account it belongs to; holdings are matched by ticker or created, the preview compares the units with what the holdings have now, and importing the same file again adds nothing. Dividend rows are skipped. Importing from Buxfer leaves the units of holdings with lots alone.

Settings → Import holdings also reads a fund's movements list, as pension funds export it ("ListagemMovimentos.xls": tab-separated text with Data, Fundo, Operação, Nº UPs and Valor UP). Subscriptions become buys, redemptions sells; the fund becomes a holding priced by hand at its latest unit value.

Each holding has a **Chart** button: its price over time (weekly closes once its price history is loaded, plus the price of each buy and sell), and the gain or loss on the units held at each point (value less what they cost, sells at average cost), shaded green above zero and red below. Arrow keys step through the points; a table has them all.

## Insights for investment accounts

An investment account's Insights tab shows its value against the money invested over the period (same presets), the gain, the change in value, and each holding's units, value, cost, gain and share today. "Invested" is the cost of the units held when every holding has buys and sells, otherwise the money moved into the account. Past values follow the same rules as net worth below.

**Price history:** an investment account's Insights has **Load price history**: weekly closing prices per holding (Alpha Vantage for non-US exchanges, Twelve Data for US ones; one lookup each), kept in `holdings.price_history` and refreshed weekly after that. With it, past values use each week's close instead of the last trade price.

**Insights comparisons:** income and spending are compared with the period of the same length just before (this year against last year), and the **Spending on a category** card shows one category (with its children) over the period against the previous one.

## Net worth

Click the net-worth card in the side panel. It shows net worth and the investments part over the chosen period (same presets as Insights), the change over the period, debts, and today's split by account type. Closed (archived) accounts count until their last transaction, then as nothing. Investment accounts are at market value today; on earlier dates they use the daily `snapshots` the app records (once a day, when you open it). Before the first snapshot, holdings with buys and sells are valued as the units held then times the latest trade price by then; holdings without them at what was put in, because there's no price history.

## Exchange rates

Each transaction keeps the EUR rate of its own date. Today's rate per currency is saved in your settings row (`settings.fx`) and fetched at most once a day, on the first visit; until then the saved one is used on every device.

## IOUs

Money you lent or borrowed, per person. Each entry is positive when they owe you more and negative when they owe you less (or you owe them). An entry has a type, like Buxfer's: Loan, Settlement, Paid for friend or Shared bill. Adding one can also move the money in an EUR account, as a transaction linked to the entry; that transaction shows its type and person ("Loan · Name") instead of categories, except a shared bill, which keeps its categories. Deleting the transaction deletes its IOU entries. Buxfer's IOU column ("Name: 9.000,00; Other: 2,50") is imported: money out of your account means they owe you, money in means they owe you less.

## Scheduled transactions

A schedule repeats every N days, weeks, months or years. Monthly and yearly ones keep their day of the month (the 31st falls back to the month's last day and returns to the 31st). Nothing is added by itself: when a date is due it shows greyed out under "Upcoming", at the top of the account's transactions, with **Enter** (adds the transaction with that date) and **Skip**. Each account with schedules also shows a 30-day forecast. Create them under **Scheduled**, with **Schedule…** on an account, with **Repeat** in the single-transaction form, or by importing Buxfer's `reminders.csv`.

Transactions you add with a date after today don't count in the balance or net worth yet. They also wait greyed out under "Upcoming" (where you can edit or delete them), with the balance they would leave, and are part of the 30-day forecast; on their date they join the list like any other.

## Backups

Supabase's free plan keeps no backups, so the app makes them. **Settings → Backup and restore → Download backup** saves one `.zip`: `backup.json` (everything, ids and links included, for an exact restore) plus the same data as readable CSV files. API keys aren't in it. A banner reminds you when one is due (every week by default; every 2 weeks, every month or never in the same page), with "Remind me tomorrow". **Restore** reads a backup `.zip` (or its `backup.json`), shows what's in it next to what's there now, and after you type RESTORE replaces everything.

`.github/workflows/finance-keepalive.yml` pings the Supabase project every 3 days so the free plan doesn't pause it for inactivity. It uses the public URL and key from `config.js` and reads no data. GitHub turns scheduled workflows off after 60 days without commits to the repo; re-enable it from the Actions tab if that happens.

## Import and export

Settings → **Import transactions (CSV)** reads any CSV with a date, a description and an amount. Columns are matched by name (English and Portuguese) and can be changed; you choose the date order and decimal separator, and see a preview before anything is saved. Account and category names that don't exist yet are created. Rows already in your data (same account, date, amount and description) are skipped, so importing the same file twice is safe. A Type column with "expense" or "income" sets the sign of unsigned amounts.

Settings → **Import from Buxfer** takes Buxfer's export files together (accounts, transactions, investments, reminders). Accounts keep their type and currency; accounts only in the transactions file are Buxfer's archived ones and come in archived. Transfer rows sharing an ID are linked. Investment accounts are valued by their holdings, as in Buxfer. Before importing, a table compares every account with its Buxfer balance; where the transactions don't add up (history before the export), an "Opening balance" transaction makes up the difference. Running it again adds nothing new. In reminders, the STOP DATE column is ignored: Buxfer fills it with dates that aren't end dates.

Settings → **Export (CSV)** downloads transactions, accounts, holdings and category rules. The transactions file imports back unchanged.

## Market data

- **Exchange rates:** Frankfurter (ECB reference rates), no key. Each transaction keeps the rate of its own date.
- **Search and US prices:** Twelve Data, free key. Its free plan doesn't include Xetra and most other non-US exchanges.
- **Non-US prices:** Alpha Vantage, free key, 25 lookups a day. Xetra, London and Toronto suffixes are documented; Frankfurt, Paris and Amsterdam are unconfirmed.
- **Funds (by ISIN):** EODHD, free key (about 20 lookups a day). Type the fund's ISIN (e.g. LU0109981661) when adding a holding. EODHD doesn't let web pages read its answers, so the database fetches them (`fund_data` in `schema.sql`, using Postgres's `http` extension) with your key, which only that function reads.
- **By hand:** any holding without a live price can have its price typed in. Something no provider lists (a pension fund, say) can be added with **Not listed? Add it by hand** under the holdings: a name, currency and price per unit, which you update from the holdings list.

API keys are saved in your settings row in the database, so they follow you between devices.
