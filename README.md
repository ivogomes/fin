# Finance

A personal finance tracker to replace Buxfer: accounts in EUR or USD (converted at the daily ECB rate), credit cards and investments, rule-based categories, transfers, stock and ETF holdings with live prices, and CSV import and export. Served at `/tools/finance/`.

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

## Categories

Two levels, like Buxfer: a category is top-level or sits under one, and is shown as "Parent / Child". A transaction can have several categories (chips you add and remove in the table or the edit form). Rules add one category when a transaction has none. Settings → Categories lists the tree with how many transactions use each one; deleting a category removes it from those transactions (they stay), deletes rules that set it, and moves its subcategories to the top level. Imports read several categories separated by commas, each possibly a path; Buxfer's `tags.csv` builds the whole tree.

## Insights

**Insights** in the header covers all accounts (archived ones included); each account also has an Insights tab. Pick a period (this or last week, month or year, the last 30 or 90 days, the last 12 months, all time, or a custom range). It shows income, spending, net and the share of income saved, a chart of income against spending by day, week, month or year (with a table view), and spending and income per top-level category, each opening onto its subcategories.

What counts: transfers between your accounts and opening balances don't. A transaction counts after its IOU entries, so a loan or its repayment counts as nothing and a shared bill counts only your share. A refund (a transaction of kind "refund", marked ↩) lowers spending in its category instead of counting as income. Amounts are in EUR at each transaction's own rate. A transaction with several categories counts under its first one, so the categories add up to the total.

## Holdings and their buys and sells

A holding can have lots: its buys and sells, each with a date, units, price and fees. With lots, its units come from them, and the holdings table shows what it cost (and the average price) and the gain. Open a holding's **Lots** to see them, add a buy or sell, or delete one.

Settings → **Import holdings (FT.com)** reads an FT.com portfolio transactions export (`Date,Name,Symbol,Type,Quantity,Price,…`, symbols like `VWCE:FRA:EUR`). Pick the investment account it belongs to; holdings are matched by ticker or created, the preview compares the units with what the holdings have now, and importing the same file again adds nothing. Dividend rows are skipped. Importing from Buxfer leaves the units of holdings with lots alone.

## Insights for investment accounts

An investment account's Insights tab shows its value against the money invested over the period (same presets), the gain, the change in value, and each holding's units, value, cost, gain and share today. "Invested" is the cost of the units held when every holding has buys and sells, otherwise the money moved into the account. Past values follow the same rules as net worth below.

## Net worth

Click the net-worth card in the side panel. It shows net worth and the investments part over the chosen period (same presets as Insights), the change over the period, debts, and today's split by account type. Closed (archived) accounts count until their last transaction, then as nothing. Investment accounts are at market value today; on earlier dates they use the daily `snapshots` the app records (once a day, when you open it). Before the first snapshot, holdings with buys and sells are valued as the units held then times the latest trade price by then; holdings without them at what was put in, because there's no price history.

## Exchange rates

Each transaction keeps the EUR rate of its own date. Today's rate per currency is saved in your settings row (`settings.fx`) and fetched at most once a day, on the first visit; until then the saved one is used on every device.

## IOUs

Money you lent or borrowed, per person. Each entry is positive when they owe you more and negative when they owe you less (or you owe them). An entry has a type, like Buxfer's: Loan, Settlement, Paid for friend or Shared bill. Adding one can also move the money in an EUR account, as a transaction linked to the entry; that transaction shows its type and person ("Loan · Name") instead of categories, except a shared bill, which keeps its categories. Deleting the transaction deletes its IOU entries. Buxfer's IOU column ("Name: 9.000,00; Other: 2,50") is imported: money out of your account means they owe you, money in means they owe you less.

## Scheduled transactions

A schedule repeats every N days, weeks, months or years. Monthly and yearly ones keep their day of the month (the 31st falls back to the month's last day and returns to the 31st). Nothing is added by itself: when a date is due it shows on the account under "Next 30 days" with **Enter** (adds the transaction with that date) and **Skip**. Each account with schedules also shows a 30-day forecast. Create them under **Scheduled**, with **Repeat** in the single-transaction form, or by importing Buxfer's `reminders.csv`.

## Import and export

Settings → **Import transactions (CSV)** reads any CSV with a date, a description and an amount. Columns are matched by name (English and Portuguese) and can be changed; you choose the date order and decimal separator, and see a preview before anything is saved. Account and category names that don't exist yet are created. Rows already in your data (same account, date, amount and description) are skipped, so importing the same file twice is safe. A Type column with "expense" or "income" sets the sign of unsigned amounts.

Settings → **Import from Buxfer** takes Buxfer's export files together (accounts, transactions, investments, reminders). Accounts keep their type and currency; accounts only in the transactions file are Buxfer's archived ones and come in archived. Transfer rows sharing an ID are linked. Investment accounts are valued by their holdings, as in Buxfer. Before importing, a table compares every account with its Buxfer balance; where the transactions don't add up (history before the export), an "Opening balance" transaction makes up the difference. Running it again adds nothing new. In reminders, the STOP DATE column is ignored: Buxfer fills it with dates that aren't end dates.

Settings → **Export (CSV)** downloads transactions, accounts, holdings and category rules. The transactions file imports back unchanged.

## Market data

- **Exchange rates:** Frankfurter (ECB reference rates), no key. Each transaction keeps the rate of its own date.
- **Search and US prices:** Twelve Data, free key. Its free plan doesn't include Xetra and most other non-US exchanges.
- **Non-US prices:** Alpha Vantage, free key, 25 lookups a day. Xetra, London and Toronto suffixes are documented; Frankfurt, Paris and Amsterdam are unconfirmed.
- **By hand:** any holding without a live price can have its price typed in.

API keys are saved in your settings row in the database, so they follow you between devices.
