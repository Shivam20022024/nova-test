# Database Testing — demo script (copy / paste)

Demo DB: a Dockerised Postgres (`novatest-demo-db`) holding a small e‑commerce
dataset. The data is internally consistent **except for two planted problems**,
so the suite finishes **8 green / 2 red** — the two reds are real data bugs the
tool catches.

Start it (once):

```bash
docker start novatest-demo-db 2>/dev/null || docker run -d --name novatest-demo-db \
  -e POSTGRES_PASSWORD=demopass -e POSTGRES_DB=shopdemo -e POSTGRES_USER=demo \
  -p 55432:5432 \
  -v "$(pwd)/backend-node/scripts/demo-db/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro" \
  postgres:16-alpine
```

---

## 1 · Create the connection

> Already created in the **TestingDemo** project as **"Shop Demo — Postgres (no SSL)"**
> and a run is already sitting in Executions. To recreate from scratch:

**DB Testing → Connections → New Connection**

| Field | Value |
|---|---|
| Name | `Shop Demo — Postgres` |
| Engine | `postgres` |
| Host | `127.0.0.1` |
| Port | `55432` |
| Database | `shopdemo` |
| Username | `demo` |
| Password | `demopass` |
| Use SSL | **UNCHECK THIS** — it's on by default; the demo DB has no SSL |

Save, then click **Test connection** → "Connection verified."
(The connection form has no edit — if you save it with SSL on, delete the card
and make a new one.)

---

## 2 · Build the test

**DB Testing** page:

- **Test name:** `Shop DB — data integrity & release checks`
- **Connection:** `Shop Demo — Postgres`
- **Release / Sprint:** pick any (create one on the Releases page first if empty)

Add the steps below. Each step = paste the **SQL**, set **Assert / Operator / Expected**.
Every check is written so it returns rows **only when something is wrong**, so
they all read the same way: `rowCount equals 0`.

### Step 1 — Customer table is populated  ✅
```sql
SELECT id FROM customers
```
Assert `rowCount` · Operator `greaterThan` · Expected `9`

### Step 2 — Product SKUs are unique  ✅
```sql
SELECT sku, count(*) FROM products GROUP BY sku HAVING count(*) > 1
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 3 — `orders` table has the expected schema  ✅
```sql
SELECT * FROM orders LIMIT 1
```
Assert `schemaColumns` · Operator `equals` · Expected `id,customer_id,status,total_cents,placed_at`

### Step 4 — No order item points at a missing order  ✅
```sql
SELECT oi.id FROM order_items oi
LEFT JOIN orders o ON o.id = oi.order_id
WHERE o.id IS NULL
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 5 — No order item points at a missing product  ✅
```sql
SELECT oi.id FROM order_items oi
LEFT JOIN products p ON p.id = oi.product_id
WHERE p.id IS NULL
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 6 — Every order status is a known value  ✅
```sql
SELECT id, status FROM orders
WHERE status NOT IN ('PENDING','PAID','SHIPPED','DELIVERED','CANCELLED')
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 7 — Every paid/shipped/delivered order has a payment  ✅
```sql
SELECT o.id FROM orders o
LEFT JOIN payments p ON p.order_id = o.id
WHERE o.status IN ('PAID','SHIPPED','DELIVERED') AND p.id IS NULL
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 8 — Payment amount matches the order total  ✅
```sql
SELECT o.id, o.total_cents, p.amount_cents
FROM orders o JOIN payments p ON p.order_id = o.id
WHERE p.amount_cents <> o.total_cents
```
Assert `rowCount` · Operator `equals` · Expected `0`

### Step 9 — Every customer has an email address  ❌ (planted bug #1)
```sql
SELECT id, full_name, country FROM customers WHERE email IS NULL
```
Assert `rowCount` · Operator `equals` · Expected `0`
→ **FAILS**: 1 row — *Ravi Chandra (IN)* was created with no email.

### Step 10 — No product is priced at or below zero  ❌ (planted bug #2)
```sql
SELECT sku, name, price FROM products WHERE price <= 0
```
Assert `rowCount` · Operator `equals` · Expected `0`
→ **FAILS**: 1 row — *SKU-TECH-002 "Braided USB-C Cable 2m"* imported at `-5.00`.

---

## 3 · Run it

Click **Run test**. Result: **FAILED** overall — 8 steps PASSED, steps 9 & 10 FAILED,
each with the offending row in the step detail. Open **Executions** to show the
saved run; open a failed run to show step logs / the "Create Jira bug" action.

### Talking points
- "Same connection, ten checks — populated tables, unique keys, schema shape,
  referential integrity, valid enums, payment reconciliation."
- "Two of them fail — and they're real: a customer with no email, and a product
  that got imported with a negative price. That's the kind of thing that reaches
  production and breaks a checkout total or a 'contact customer' job."
- "Every query runs inside a transaction that's rolled back by default, so
  pointing this at a real database is safe."

---

## Optional — one-prompt version

Instead of the 10 steps, the **Generate from a prompt** box also works:

```
Against this e-commerce database, generate checks that verify: the customers
table has rows; product SKUs are unique; order_items has no rows whose order_id
or product_id is missing from the parent table; every orders.status is one of
PENDING/PAID/SHIPPED/DELIVERED/CANCELLED; every order with status PAID, SHIPPED
or DELIVERED has a matching row in payments; each payment amount_cents equals its
order's total_cents; no customers row has a NULL email; no products row has price
<= 0.
```

(The manual steps above are the reliable path for a live demo — the generator
may phrase queries differently run to run.)
