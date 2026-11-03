# Fin

Fin (*take care of your Finances*) is a personal finance tracker to replace Buxfer: accounts in EUR or USD (converted at the daily ECB rate), credit cards and investments, rule-based categories, transfers, stock and ETF holdings with live prices, and CSV import and export. Served at `/tools/finance/`.

Data is stored in a Supabase project (Postgres) and you sign in with Google or an emailed link, so the same data is available on every device. The browser keeps only the sign-in session and a few display preferences.

| File | What it is |
| --- | --- |
| `index.html` | The page: tool header, account panel, main area, dialogs. |
| `app.js` | The app's core and shell: what's shown (`state`, `view`, the address), `render`, sign-in and start-up, the header, the account menu and the phone tab bar. Loads the other modules. |
| `ui.js` | Building blocks every page uses: `h()` for elements, form controls, icons, preferences, money and number formatting, category names and colours. |
| `accounts.js` | An account's dialog and page, credit card statements and payments, and alerts. |
| `transactions.js` | Transaction lists: filters, selection and bulk changes, the table, editing in place, paging from the database, and Search. |
| `entry.js` | Adding transactions: the quick-entry grid, the single form, description suggestions, the category picker. |
| `holdings.js` | Holdings and their buys and sells. |
| `ious.js` | IOUs, per person. |
| `insights.js` | Insights and net worth over time. |
| `schedules.js` | Scheduled transactions and subscriptions. |
| `overview.js` | The Overview and its alerts. |
| `settings.js` | Settings pages and navigation, and category management. |
| `imports.js` | Imports (CSV, Buxfer, holdings, rules) and CSV export. |
| `backups.js` | Backups: download, restore, Google Drive. |
| `palette.js` | Go to (Ctrl/⌘+K). |
| `theme.js` | Applies the picked appearance (light, dark or the system's) before the page is drawn. |
| `model.js` | Pure logic: money in cents, categories by rule, balances, transfers, net worth, CSV parsing and import mapping. No DOM, no I/O. |
| `model.test.mjs` | The spec for `model.js`. |
| `store.js` | Loads the signed-in user's data and saves changes: compares with the last saved copy and sends only added, changed or removed rows. |
| `cloud.js` | Supabase over plain `fetch`: sign-in (email link or Google) and table access. No SDK. |
| `market.js` | Exchange rates (Frankfurter), symbol search and US prices (Twelve Data), non-US prices (Alpha Vantage). |
| `drive.js` | Backups to Google Drive (optional, with a Google OAuth client ID in `config.js`). |
| `schema.sql` | Database tables and row-level security. |
| `config.js` | Your Supabase project URL and anon key. |
| `finance.css` | The tool's styles, on the shared tokens (see `STYLEGUIDE.md`). |

The modules are plain ES modules, loaded by `app.js` (no build step). Each exports its top-level declarations and imports what it uses from the others; they only reach each other's code when called, so the cycles between them are safe. A module can read another's variables (`state`, `view`, `txPage`…) but not assign them, so each such variable has a setter next to it (`setView`, `setTxPage`, `setEditingTxId`…). A new file needs adding to `SHELL` in `sw.js`.

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

`schema.sql` only creates what's missing, so running the whole file again is safe and keeps your data. Do this when a new feature needs a table or a column (scheduled transactions added `schedules`; splits and dividends added `transactions.splits` and `transactions.holding_id`; marking subscriptions added `schedules.subscription`; several categories per schedule added `schedules.category_ids`; account settings added a dozen `accounts` columns); until then the app loads normally, says the database needs updating, and doesn't save.

## Pages

Each section in the header (Overview, Accounts, Search, Scheduled, Insights, IOUs, Settings) is its own page with its own address, e.g. `/tools/finance/?page=search`, `?page=settings&section=backup` or `?account=<id>&tab=insights`; `/tools/finance/` opens the Overview and `?account=` the last account opened. `?page=search&q=rent` opens Search already looking for "rent". Going to another section loads that page with fresh data, so switching sections also picks up changes made on another device.

Not every page loads every transaction. Account totals (balances, counts, what's coming in the next 30 days) are worked out by the database (`account_summaries` in `schema.sql`), and a change you make shows in them at once; they're checked against the database again after each save. An account page asks the database for the 100 transactions it shows, with their running balance and filters applied (`account_transactions`), and the suggestions when adding transactions come from `description_index`. Search asks the database for one page of results with their In and Out totals (`search_transactions`), and Insights for the period's sums per day and per category (`insight_totals`, the same rules as `insightTotals` in `model.js`); the app groups those into weeks or months and parent categories. Net worth (and an investment account's Insights tab) asks for each account's running total at the end of each week or month (`balances_at`); investments are then valued from their holdings in the app. No page loads every transaction up front: the IOUs page fetches just the ones its entries are linked to, and the Settings pages that work on all of them (categories, rules, backup, imports, link transfers, export) load them when opened. A backup always has every transaction, wherever it's downloaded from. Anything waiting to be saved is sent first, and leaving with something typed but not saved asks first. Moving between accounts, account tabs and settings pages stays instant, and the address follows, so reloading or bookmarking keeps you there.

## Appearance

Settings → **Display** → Appearance picks light, dark, or the same as your device (the default), saved in this browser. `theme.js` applies it in the page's `<head>`, before anything is drawn, by setting `data-theme` on `<html>`; every dark style in `finance.css` answers to that as well as to the system setting.

## Overview

The first page. It shows net worth, what you've spent and earned this month against last month up to the same day, everything coming up in the next two weeks across accounts (scheduled dates, with **Enter** and **Skip** for the ones due, and transactions added with a later date), this month's spending by category against the same days last month, and each credit card with what's owed and how much of its limit is left. Above it all, a **Heads up** card lists what needs doing, most pressing first: schedules left overdue (with **Enter** and **Skip**), checking accounts heading below their low-balance alert, credit cards at 80% or more of their limit, card payments due in the next 5 days (with **Pay now**), a daily Google Drive backup that didn't go through (with **Back up now**), subscriptions that seem to have stopped while their schedule still expects them (with **Stop the schedule**, undoable), and payments that look recurring but have no schedule (with **Review them**). An account's page shows its own low-balance, limit and card-payment alerts.

## Go to (Ctrl/⌘+K)

**Go to…** in the header, or Ctrl+K (⌘K on a Mac) anywhere, opens a box to jump to any account, page or settings page, or to start something: add transactions or an account, schedule a transaction, hide amounts. Type to narrow the list (names starting with what you type come first); ↓/↑ move, Enter goes, Esc closes. Whatever you type can also be searched for in your transactions.

## Adding transactions from the keyboard

**Add transactions** opens a grid of rows. Typing a description suggests earlier ones (names starting with it first, then words starting with it, then ones containing it; within that, the account's own, the most used and the most recent). ↓/↑ move through them; Enter or Tab take one, filling in its category and whether it was an expense, income or refund (not the amount, which is rarely the same), then jump to the amount. A suggestion is pre-selected only when it starts with exactly what you typed, so a new description is never swapped for an old one by accident. Enter in any field goes to the next row, and there's always an empty row at the end; Ctrl+Enter (⌘+Enter on a Mac) saves them all.

A row can be a transfer: pick **⇄ Transfer** as its type and the category cell becomes the account the money goes to (the row's account is where it leaves from). Past transfers are suggested too, filling in both accounts. Between currencies the received amount is converted at that day's rate. The single-transaction form suggests descriptions the same way, and so does the inline edit form, where a suggestion fills in the description and, if the transaction has none, its categories.

**Editing a transfer** (in its edit form, or one cell at a time in the list) changes both sides: the same date, description and memo, and the same amount, or, between accounts in different currencies, the other side converted at the rate of the transfer's date. The edit form then shows the other side's amount in its own field, with that day's rate under it: it follows the amount you type until you type in it yourself (the exact amount from a statement, say), and when the saved amounts don't match the day's rate, **Use that day's rate** puts it right. The ⇄ chip of a transfer opens its other side: that account's list on the transfer's date, with it highlighted.

## Search, filters, selecting and undo

Click a transaction's date, amount or description (or Tab to it and press Enter) to change just that, in place: Enter or clicking away saves, Esc cancels, and Undo puts it back. A transfer's other side follows.

Each account's transactions have a filter bar: text (description, memo, or an amount such as `12.99`), categories (a parent includes its children; "Uncategorized" too), types, dates and amount range. **Search** in the header does the same across every account, archived ones included, with totals in and out, and can narrow to some accounts. Categories, types and accounts each open a list of checkboxes: tick several and a transaction matching any of them shows (the categories have a search box, and so do the accounts when there are many; ↓/↑ move, Esc closes). This needs the `schema.sql` from when several could be picked (`account_transactions` and `search_transactions` take `p_categories` and `p_types` lists); with an older one the app asks for it to be run again. Rows have checkboxes (and one for the whole page); with any selected, a bar sets, adds or removes categories, or deletes them. Deletes and bulk changes show a message with **Undo** (also Ctrl/⌘+Z while it shows): account, transaction, holding, lot, IOU entry, schedule and category deletes.

**Rules from your transactions:** Settings → Import → **Category rules** looks at how you've already categorized things and offers the rules that would do it for you: a description seen at least three times that goes in the same category at least 9 times in 10 (`rulesFromHistory` in `model.js`). Descriptions that differ only in numbers (card or reference numbers) are taken together, and the rule then looks for the words they all share ("contains Green Grocer"); otherwise it matches the whole description. A rule is only offered if it's right about at least 9 in 10 of all the categorized transactions it would match, and not if your rules already do the same. Tick the ones you want: they go to the top of the rules, and can also categorize the uncategorized transactions they match. Undo takes them back.

When you categorize a transaction by hand and no rule would already do that, the app offers "Always put … in …?". The rule matches the whole description, goes to the top of the list (the first match wins), and can fill in the other uncategorized transactions with that description at the same time.

## On a phone

On small screens (up to 52rem wide):

- **Tab bar** along the bottom: Overview, Accounts, Search, Insights, and **More** (Scheduled, IOUs, Settings). The header keeps the logo, the save status and your avatar; **Go to…** and **Hide amounts** are in the avatar's menu.
- **Accounts** is a page of its own: net worth, then the accounts by type; picking one opens it, with **‹ Accounts** above it to go back. Settings keeps its pages behind a **Settings menu** button.
- Transactions stack as cards, and a round **+** button above the tab bar opens quick entry for the account on screen (or the main account).
- Dialogs fill the screen, with their title bar and buttons (Save, Add…) pinned while the form scrolls between them.
- On touch screens, fields use 16px text so iOS doesn't zoom in when one is tapped, and small controls (a chip's ×, row actions, small links, checkboxes) get a 44px tap area.
- As an installed app, everything stays clear of the notch and the home indicator (`viewport-fit=cover` and the safe-area insets), and **pulling down** from the top of a page reloads it, saving anything pending first. The tool installs as an app (manifest and icons in this folder; `sw.js` keeps the app's own files so it opens instantly, while data always comes from the database). The app's "Add transactions" shortcut opens `?add`.

## Splitting a transaction

A transaction can be split across categories, like a supermarket receipt that's part food and part household. In the edit form (or the single-transaction form), **Split across categories** replaces the categories with parts: each a category and an amount. The parts must add up to the transaction's amount; the form says how much is left to put in a part. In the list a split shows each part's category with its amount. Insights count each part under its own category, filters find the transaction under any of them, and changing the amount in place keeps each part's share. Setting or removing categories on selected transactions undoes a split; adding a category leaves split ones alone.

## Categories

Two levels, like Buxfer: a category is top-level or sits under one, and is shown as "Parent / Child". A transaction can have several categories (chips you add and remove in the table, the edit form, either add form, and each row of the quick grid). The box after the chips searches as you type: every word must appear in the category's name or its parent's, accents ignored, so `food gro` finds "Food / Groceries" and a parent's name lists its children. ↓/↑ move, Enter (or Tab, or a click) adds the highlighted one, and the box stays ready for another; Backspace in the empty box removes the last chip, Esc closes the list. In the quick grid, leaving a row with none shows what the rules would pick ("Auto: …"). The bulk bar's Set category and Add category search the same way (`searchCategories` in `model.js`). Rules add one category when a transaction has none. Settings → Categories lists the tree with how many transactions use each one; deleting a category removes it from those transactions (they stay), deletes rules that set it, and moves its subcategories to the top level. Imports read several categories separated by commas, each possibly a path; Buxfer's `tags.csv` builds the whole tree.

## Account settings

**Edit** on an account has the settings every account can have, and a section for its type.

- **Any account:** a colour (a dot by its name), the bank, the last four digits of its card or account number (a CSV import's Account column like "VISA ****1234" then finds it), when it was opened and closed (net worth counts it until its closing date, archived or not), and **Leave out of totals** (it's still listed, but not in net worth or its group's total).
- **Checking:** **Warn below** an amount: the account and the Overview warn when what's scheduled, added ahead or due on cards in the next 30 days takes the balance below it, with the date and the lowest point. **Main account** (one at most, starred in the side panel): the default for quick entry away from an account page, and for paying new cards.
- **Savings:** the interest rate (a year, before tax), how often it's paid, and the tax withheld from it (a percent): the account shows about what each payment should be after the tax (and before it, for reference), and **Schedule it** adds an income schedule for that amount.
- **Investments:** the kind (brokerage, pension, retirement savings, crypto, other). Net worth then shows what's **Within reach**: without pensions and retirement savings.

## Credit cards

A credit card account can have a credit limit. It then shows what's left to spend, the limit less what's owed, with how much of the limit is used. Its Insights tab is about spending only: no income, net or savings.

With a **statement day**, the card shows its latest statement: what was owed on that day (`balances_at`), less payments into the card since. With a **payment due day** and **Paid from** (the account it's paid from), what's left to pay is an upcoming payment on both accounts (and in the 30-day forecasts, and in the Overview's Coming up), with **Pay**: a transfer of that amount from the Paid from account, today. Five days before it's due, or once it's overdue, it's also an alert on the Overview.

## Charts over time

Hovering a chart (or moving through it with the keyboard) shows a small box by the point, column or slice with its numbers; the line above the chart says the same for screen readers, and "Show as a table" has them all. Balances, net worth, investment values and holding prices are drawn as one line on one scale: the left axis gives the amount, the right axis the same gridlines as the change since the start of the period, and the line is green above where it started and red below (that level is marked). An account's Insights tab starts with its balance over the period; an investment's value has what was put in as a dashed line.

## Insights

**Insights** in the header covers all accounts (archived ones included); each account also has an Insights tab. Pick a period (this or last week, month or year, the last 30 or 90 days, the last 12 months, all time, or a custom range). It shows income, spending, net and the share of income saved, a chart of income against spending by day, week, month or year (with a table view), and spending and income per top-level category, each opening onto its subcategories.

What counts: transfers between your accounts and opening balances don't. A transaction counts after its IOU entries, so a loan or its repayment counts as nothing and a shared bill counts only your share. A refund (a transaction of kind "refund", marked ↩) is money back on an expense: it lowers spending and never counts as income. It lowers spending in its first category that is a spending one; categories that take in more than goes out across all your history (a salary, say) are skipped, as a refund tagged with one only says where the money came from. A refund with no spending category lowers spending on its own line, "Refunds with no expense category". A category can show negative spending when more came back than was spent in the period. Amounts are in EUR at each transaction's own rate. A transaction with several categories counts under its first one, so the categories add up to the total; a split one counts each part under that part's category. Dividends are income, under their category or, without one, on a "Dividends" line.

## Holdings and their buys and sells

A holding can have lots: its buys and sells, each with a date, units, price and fees. With lots, its units come from them, and the holdings table shows what it cost (and the average price) and the gain. Open a holding's **Lots** to see them, add a buy or sell, or delete one.

An investment account's cards show its **Value** (the holdings at today's prices), **Invested** and **Gain**. When every holding has lots, both come from the holdings, as in the holdings table: Invested is what their lots cost and Gain each one's value less that, added up in the account's currency at today's rates, whatever the transfers in came to after conversion. Without lots for every holding, Invested is the money put in (the account's transactions) and Gain the value less that. Each holding is shown in the currency it's priced in, with its value in the account's currency under it when they differ.

Settings → **Import** → **Holdings** reads an FT.com portfolio transactions export (`Date,Name,Symbol,Type,Quantity,Price,…`, symbols like `VWCE:FRA:EUR`). Pick the investment account it belongs to; holdings are matched by ticker or created, the preview compares the units with what the holdings have now, and importing the same file again adds nothing. Dividend rows are skipped. Importing from Buxfer leaves the units of holdings with lots alone.

Import → Holdings also reads a fund's movements list, as pension funds export it ("ListagemMovimentos.xls": tab-separated text with Data, Fundo, Operação, Nº UPs and Valor UP). Subscriptions become buys, redemptions sells; the fund becomes a holding priced by hand at its latest unit value.

Each holding has a **Chart** button: its price over time (weekly closes once its price history is loaded, plus the price of each buy and sell), and the gain or loss on the units held at each point (value less what they cost, sells at average cost), shaded green above zero and red below. Arrow keys step through the points; a table has them all.

## Dividends

**Dividend** is a transaction type (with expense, income, refund and transfer) in the single-transaction and edit forms. A dividend can name the holding that paid it (**From holding**), wherever the money landed; the list then says "Dividend from VWCE". Dividends count as income in Insights, and in the investment account's return and its holdings' returns. Filters have a Dividends type.

## Insights for investment accounts

An investment account's Insights tab shows its value against the money invested over the period (same presets), the gain, the change in value, its annual return, the dividends in the period, and each holding's units, value, cost, gain, dividends, return and share today. "Invested" is the cost of the units held when every holding has buys and sells, otherwise the money moved into the account. Past values follow the same rules as net worth below.

**Annual return** is money-weighted (XIRR, `xirr` in `model.js`): the yearly rate that makes the money paid in, the money back (sells, dividends) and today's value balance out, so money added late counts for less time. It covers everything from the first buy (or the first transaction), not just the period. With buys and sells for every holding it uses those; otherwise the money moved in and out of the account. Under a year it shows the plain return instead, since a yearly rate would stretch a few weeks' move into a misleading number.

**Allocation today:** a donut of the account's holdings at today's prices, by holding or by currency, with each one's value and share. The Net worth tab has the same for every holding across your investment accounts.

**Price history:** an investment account's Insights has **Load price history**: weekly closing prices per holding (Alpha Vantage for non-US exchanges, Twelve Data for US ones; one lookup each), kept in `holdings.price_history` and refreshed weekly after that. With it, past values use each week's close instead of the last trade price.

**Insights comparisons:** income and spending are compared with the period of the same length just before (this year against last year), and the **Spending on a category** card shows one category (with its children) over the period against the previous one.

## Net worth

Insights → **Net worth** (or click the net-worth card in the side panel). It shows net worth and the investments part over the chosen period (shared with the Income and spending tab), the change over the period, debts, and today's split by account type. Closed (archived) accounts count until their last transaction, then as nothing. Investment accounts are at market value today; on earlier dates they use the daily `snapshots` the app records (once a day, when you open it). Before the first snapshot, holdings with buys and sells are valued as the units held then times the latest trade price by then. An account whose holdings have no buys and sells is estimated: what had been put in by then, plus today's gain growing evenly from its first transaction, so the line climbs to today's value instead of jumping on the last day. The note under the chart says when that's the case.

## Exchange rates

Each transaction keeps the EUR rate of its own date. Today's rate per currency is saved in your settings row (`settings.fx`) and fetched at most once a day, on the first visit; until then the saved one is used on every device.

## IOUs

Money you lent or borrowed, per person. Each entry is positive when they owe you more and negative when they owe you less (or you owe them). An entry has a type, like Buxfer's: Loan, Settlement, Paid for friend or Shared bill. Adding one can also move the money in an EUR account, as a transaction linked to the entry; that transaction shows its type and person ("Loan · Name") instead of categories, except a shared bill, which keeps its categories. Deleting the transaction deletes its IOU entries. Buxfer's IOU column ("Name: 9.000,00; Other: 2,50") is imported: money out of your account means they owe you, money in means they owe you less.

## Scheduled transactions

A schedule repeats every N days, weeks, months or years, and can have several categories, like a transaction (the transactions it enters get them all). Monthly and yearly ones keep their day of the month (the 31st falls back to the month's last day and returns to the 31st). Nothing is added by itself: when a date is due it shows greyed out under "Upcoming", at the top of the account's transactions, with **Enter** (adds the transaction with that date) and **Skip**. Each account with schedules also shows a 30-day forecast. Create them under **Scheduled**, with **Schedule…** on an account, with **Repeat** in the single-transaction form, or by importing Buxfer's `reminders.csv`.

**Looks recurring:** the Scheduled page lists payments that came round regularly over the last 13 months and have no schedule yet: the same account, description and direction at least three times, evenly spaced by a week, two weeks, a month, a quarter or a year (a few days' drift allowed), the last one recent, and about the same amount each time (all but one within 30%). **Schedule…** opens the schedule form filled in from them; **Not recurring** stops suggesting it (kept in `settings.hidden_suggestions`). The database groups the transactions (`recurring_candidates`); the app decides which look regular (`suggestSchedules` in `model.js`).

**Subscriptions:** Scheduled → **Subscriptions** (`?page=scheduled&tab=subscriptions`) finds them in the last three years of payments: money going out at a steady rhythm (weekly, every two weeks, monthly, quarterly or yearly) for the same price each time (three charges, or two a year apart for a yearly plan), give or take 5% for charges in another currency, or with one price change (`findSubscriptions` in `model.js`). It shows what they cost a month and a year in EUR (yearly ones spread over twelve months), each one's price and rhythm, any price change ("↑ from €9.99 in Mar 2026"), when it was last charged and when it's next due, and whether it has a schedule (**Schedule…** adds one). Ones whose next charge is well overdue are listed apart under **Looks cancelled**, to confirm you did cancel them. A schedule can be marked too: tick **This is a subscription** in its form (expenses only; `schedules.subscription`). A marked one is always listed, with the schedule's price, rhythm and next date, even before any charge is seen; if it's also found in your payments, it keeps the last charge and any price change from there. The Scheduled list shows a Subscription chip on it. Rent or a loan repayment can look like a subscription: **Not a subscription** hides a found one for good (in `settings.hidden_suggestions`, with a link to show them again) and unmarks a marked schedule. The Overview shows the monthly total.

Transactions you add with a date after today don't count in the balance or net worth yet. They also wait greyed out under "Upcoming" (where you can edit or delete them), with the balance they would leave, and are part of the 30-day forecast; on their date they join the list like any other.

## Backups

Supabase's free plan keeps no backups, so the app makes them. **Settings → Backup and restore** has one card for them: when the last one was made, Google Drive (below) with the backups in it, and how often. **Download backup** (next to **Back up to Google Drive now**, or on its own without Drive) saves one `.zip`: `backup.json` (everything, ids and links included, for an exact restore) plus the same data as readable CSV files. API keys aren't in it. A banner reminds you when there's been no backup for a week (or 2 weeks, a month, or never, in the same card); with Drive backing up every day it only shows if that stops working, with "Remind me tomorrow". **Restore** reads a backup `.zip` (or its `backup.json`), shows what's in it next to what's there now, and after you type RESTORE replaces everything.

**Backups to Google Drive.** Once connected (Settings → Backup and restore: once in each browser, or once for all of them when you sign in with Google), Fin makes a backup by itself every day, the first time it opens that day: the same `.zip`, in a **Fin backups** folder in your Drive, keeping the latest 10, so the last 10 days (older ones go to Drive's bin, which empties after 30 days). The page lists them. Fin asks Google only for the files it creates (the `drive.file` permission), so it can't see anything else in your Drive. Google's permission lasts about an hour and is renewed without asking; when Google does need you to confirm, the backup reminder has a **Back up to Google Drive** button. (Fin runs in your browser, so backups happen when you open it.) `drive.js` does this.

To set it up once:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (say "Fin").
2. **APIs & Services → Library:** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:** user type External; app name Fin; your email as support and developer contact. Under **Data access**, add the scope `.../auth/drive.file`. Under **Audience**, leave it in Testing and add your Google account as a test user (only test users can connect, which is what you want).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:** type Web application; under **Authorized JavaScript origins** add `https://ivogomes.com` and `http://localhost:4000`. No redirect URIs are needed.
5. Copy the client ID (`….apps.googleusercontent.com`) into `GOOGLE_CLIENT_ID` in `config.js`. It's meant to be public, like the Supabase anon key: Google only accepts it from those origins.
6. In Fin: Settings → Backup and restore → **Connect Google Drive and back up now**.

**Signing in with Google.** With the client ID set, the sign-in screen also shows **Sign in with Google**, above the email link. Turn it on in Supabase: **Authentication → Sign In / Providers → Google**, enable it, and paste the same client ID (and a client secret from that Google client, if the form asks for one). Nothing more is needed in Google Cloud: the button runs from the same JavaScript origins, needs no redirect URI, and asks only for your name and email (basic scopes). Google's signed ID token is exchanged for a Supabase session (`signInWithGoogle` in `cloud.js`, with a nonce so a token can't be reused elsewhere), and Supabase links it to the account with the same email, so you get the same data either way. Your Google name and photo show in the header, on a button at the end that opens a menu with your email, your account's settings and **Sign out** (with the email link, it shows your initials instead; so does a photo that doesn't load). The photo is loaded from Google. Drive is a separate permission, but it goes with the Google account rather than the browser: once that account has allowed it (one click on **Use Google Drive and back up now**, or the reminder's button), every browser where you sign in with Google uses it without asking, and backs up by itself when one is due. Disconnecting in a browser stops that there. The Backup page shows which Google account the backups go to, and says so if it isn't the one you signed in with.

While the app is in Testing, Google may ask you to confirm again from time to time; that's the reminder's button.

**A copy on a Synology NAS:** in DSM, install **Cloud Sync**, add a Google Drive connection with your account, and sync the **Fin backups** folder to a folder on the NAS with the direction set to **Download remote changes only**. If it offers to keep local files when they're removed from Drive, turn that on, so the NAS keeps every backup even after Drive's copy rotates. Hyper Backup can then include that folder in the NAS's own backups.

`.github/workflows/finance-keepalive.yml` pings the Supabase project every 3 days so the free plan doesn't pause it for inactivity. It uses the public URL and key from `config.js` and reads no data. GitHub turns scheduled workflows off after 60 days without commits to the repo; re-enable it from the Actions tab if that happens.

## Import and export

Every import is on one page, Settings → **Import**, with the kind picked at the top: Transactions (CSV), From Buxfer, Holdings, or Category rules (`?page=settings&section=import&kind=csv|buxfer|holdings|rules`).

Import → **Transactions (CSV)** reads any CSV with a date, a description and an amount. Columns are matched by name (English and Portuguese) and can be changed; you choose the date order and decimal separator, and see a preview before anything is saved. Account and category names that don't exist yet are created. Rows already in your data (same account, date, amount and description) are skipped, so importing the same file twice is safe. A Type column with "expense" or "income" sets the sign of unsigned amounts.

Import → **From Buxfer** takes Buxfer's export files together (accounts, transactions, investments, reminders). Accounts keep their type and currency; accounts only in the transactions file are Buxfer's archived ones and come in archived. Transfer rows sharing an ID are linked. Investment accounts are valued by their holdings, as in Buxfer. Before importing, a table compares every account with its Buxfer balance; where the transactions don't add up (history before the export), an "Opening balance" transaction makes up the difference. Running it again adds nothing new. In reminders, the STOP DATE column is ignored: Buxfer fills it with dates that aren't end dates.

Settings → **Export (CSV)** downloads transactions, accounts, holdings and category rules. The transactions file imports back unchanged.

**Cleaning up after imports.** Settings → **Link transfers** turns pairs of transactions (same date and description, opposite amounts, two accounts) into transfers. Settings → **Duplicates** finds transactions that look entered twice, as after importing a file again: same account, amount and description (case, accents and numbers in it ignored, since card and reference numbers differ between exports), at most 3 days apart (`findDuplicates` in `model.js`). Each group lists its copies to pick the one to keep, the one with categories, a memo, a split, an IOU or a transfer suggested first; **Delete the other copy** deletes the rest of that group, the button at the top the extra copies of every group, both with Undo. **Not duplicates** hides a group (remembered with the other turned-down suggestions) until another copy turns up.

## Market data

- **Exchange rates:** Frankfurter (ECB reference rates), no key. Each transaction keeps the rate of its own date.
- **Search and US prices:** Twelve Data, free key. Its free plan doesn't include Xetra and most other non-US exchanges.
- **Non-US prices:** Alpha Vantage, free key, 25 lookups a day. Xetra, London and Toronto suffixes are documented; Frankfurt, Paris and Amsterdam are unconfirmed.
- **Funds (by ISIN):** EODHD, free key (about 20 lookups a day). Type the fund's ISIN (e.g. LU0109981661) when adding a holding. EODHD doesn't let web pages read its answers, so the database fetches them (`fund_data` in `schema.sql`, using Postgres's `http` extension) with your key, which only that function reads.
- **By hand:** any holding without a live price can have its price typed in. Something no provider lists (a pension fund, say) can be added with **Not listed? Add it by hand** under the holdings: a name, currency and price per unit, which you update from the holdings list.

API keys are saved in your settings row in the database, so they follow you between devices.
