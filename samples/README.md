# Sample statements

Three files in the shapes the CSV importer is built for — Vietnamese bank, VEEM
and payroll. They exist so the column mapping can be checked **before** AHN's
real exports arrive, and so a real export can be compared against a known-good
layout when something maps oddly.

They are not real money. Nothing imports them automatically.

**AHN's payroll comes from QuickBooks, not from a file.** Where it appears
depends on how the company books it — run
`QBO_INVENTORY=1 npx vitest run tests/qbo-inventory.integration.test.ts`
against a connected company to see which entities and accounts actually hold it.

| File | Shape | What it exercises |
|---|---|---|
| `vn-bank-statement.csv` | `Ngày giao dịch`, `Nội dung`, `Ghi Nợ`, `Ghi Có` | Day-first dates, dot thousand separators (`412.500.000`), separate debit/credit columns, Vietnamese headers with diacritics, VND (zero minor digits) |
| `veem-payments.csv` | `Date`, `Recipient`, `Amount` | One unsigned amount column where every row is money **out** — the "force outflow" option |
| `payroll-export.csv` | `Pay Date`, `Employee`, `Total Cost` | US dates, quoted thousands (`"6,762.50"`), several rows per pay run. **AHN runs payroll through QuickBooks, so this file is not needed** — it stays as a template in case a bureau export ever has to be brought in by hand. |

## Using them

`/import` → pick the matching preset → choose the file → check the preview.

The preview is the safety step. A VN statement read with the wrong decimal
separator turns ₫412,500,000 into ₫412.50 — a 1,000,000× error that produces a
perfectly clean-looking import. Confirm the largest amount looks right before
writing anything.

Re-importing the same file is safe: rows carry a stable key derived from their
content, so nothing double-counts.
