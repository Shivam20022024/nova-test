-- ============================================================================
-- NovaTest AI — Database Testing demo dataset  (PostgreSQL)
-- Small e-commerce schema. Data is internally consistent EXCEPT for two
-- deliberately planted data-quality problems the demo suite is meant to catch:
--   #1  one customer row has a NULL email
--   #2  one product row has a negative price (bad import)
-- ============================================================================

CREATE TABLE customers (
    id           SERIAL PRIMARY KEY,
    full_name    TEXT          NOT NULL,
    email        TEXT,                       -- nullable on purpose (planted bug #1)
    country      TEXT          NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id           SERIAL PRIMARY KEY,
    sku          TEXT          NOT NULL UNIQUE,
    name         TEXT          NOT NULL,
    category     TEXT          NOT NULL,
    price        NUMERIC(10,2) NOT NULL,
    in_stock     INTEGER       NOT NULL DEFAULT 0,
    attributes   JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER       NOT NULL REFERENCES customers(id),
    status       TEXT          NOT NULL,   -- PENDING | PAID | SHIPPED | DELIVERED | CANCELLED
    total_cents  BIGINT        NOT NULL,
    placed_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER       NOT NULL REFERENCES orders(id),
    product_id   INTEGER       NOT NULL REFERENCES products(id),
    quantity     INTEGER       NOT NULL,
    unit_cents   BIGINT        NOT NULL
);

CREATE TABLE payments (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER       NOT NULL REFERENCES orders(id),
    provider     TEXT          NOT NULL,
    amount_cents BIGINT        NOT NULL,
    captured_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Customers ───────────────────────────────────────────────────────────────
INSERT INTO customers (full_name, email, country, created_at) VALUES
 ('Ava Thompson',      'ava.thompson@example.com',    'US', '2026-01-04 10:12:00+00'),
 ('Liam Patel',        'liam.patel@example.com',      'GB', '2026-01-09 14:40:00+00'),
 ('Sofia Rossi',       'sofia.rossi@example.com',     'IT', '2026-02-01 08:05:00+00'),
 ('Noah Kim',          'noah.kim@example.com',        'KR', '2026-02-14 19:22:00+00'),
 ('Emma Garcia',       'emma.garcia@example.com',     'ES', '2026-02-20 11:01:00+00'),
 ('Oliver Brown',      'oliver.brown@example.com',    'CA', '2026-03-02 16:45:00+00'),
 ('Mia Nkosi',         'mia.nkosi@example.com',       'ZA', '2026-03-11 09:30:00+00'),
 ('Lucas Muller',      'lucas.mueller@example.com',   'DE', '2026-03-18 13:18:00+00'),
 ('Charlotte Dubois',  'charlotte.dubois@example.com','FR', '2026-03-25 07:55:00+00'),
 ('Ravi Chandra',       NULL,                         'IN', '2026-03-28 22:10:00+00');  -- planted bug #1

-- ── Products ────────────────────────────────────────────────────────────────
INSERT INTO products (sku, name, category, price, in_stock, attributes) VALUES
 ('SKU-APRL-001', 'Merino Wool Sweater',    'Apparel',     89.00,  42, '{"color":"charcoal","sizes":["S","M","L","XL"]}'),
 ('SKU-APRL-002', 'Rain Shell Jacket',      'Apparel',    149.00,  18, '{"color":"navy","waterproof":true}'),
 ('SKU-FOOT-001', 'Trail Running Shoe',     'Footwear',   129.00,  63, '{"color":"orange"}'),
 ('SKU-FOOT-002', 'Everyday Sneaker',       'Footwear',    75.00, 120, '{"color":"white"}'),
 ('SKU-ACCS-001', 'Leather Belt',           'Accessories', 45.00, 200, '{"color":"brown"}'),
 ('SKU-ACCS-002', 'Wool Beanie',            'Accessories', 24.00, 340, '{"color":"forest"}'),
 ('SKU-HOME-001', 'Ceramic Pour-Over Set',  'Home',        58.00,  27, '{"material":"stoneware"}'),
 ('SKU-HOME-002', 'Linen Throw Blanket',    'Home',        95.00,  15, '{"color":"oatmeal"}'),
 ('SKU-TECH-001', 'USB-C Travel Charger',   'Tech',        39.00,  88, '{"wattage":65}'),
 ('SKU-TECH-002', 'Braided USB-C Cable 2m', 'Tech',        -5.00, 500, '{"length_m":2}');       -- planted bug #2

-- ── Orders  (total_cents == sum of its order_items) ─────────────────────────
INSERT INTO orders (customer_id, status, total_cents, placed_at) VALUES
 (1, 'DELIVERED', 20300, '2026-02-10 12:00:00+00'),   -- 1
 (2, 'DELIVERED', 14900, '2026-02-12 09:30:00+00'),   -- 2
 (3, 'SHIPPED',   16800, '2026-03-01 15:20:00+00'),   -- 3
 (4, 'PAID',      12000, '2026-03-05 18:00:00+00'),   -- 4
 (5, 'PAID',       9500, '2026-03-06 10:10:00+00'),   -- 5
 (6, 'PENDING',    7500, '2026-03-15 11:45:00+00'),   -- 6  (no payment)
 (7, 'CANCELLED',  4800, '2026-03-16 14:05:00+00'),   -- 7  (no payment)
 (1, 'DELIVERED',  8200, '2026-03-20 08:20:00+00'),   -- 8
 (8, 'SHIPPED',   15300, '2026-03-22 17:30:00+00'),   -- 9
 (9, 'PAID',      12900, '2026-03-26 20:15:00+00');   -- 10

INSERT INTO order_items (order_id, product_id, quantity, unit_cents) VALUES
 (1, 1, 1, 8900), (1, 6, 1, 2400), (1, 9, 1, 9000),
 (2, 2, 1, 14900),
 (3, 3, 1, 12900), (3, 9, 1, 3900),
 (4, 4, 1, 7500), (4, 5, 1, 4500),
 (5, 7, 1, 9500),
 (6, 4, 1, 7500),
 (7, 5, 1, 4800),
 (8, 7, 1, 5800), (8, 6, 1, 2400),
 (9, 3, 1, 12900), (9, 6, 1, 2400),
 (10, 3, 1, 12900);

-- ── Payments  (every non-PENDING / non-CANCELLED order, amount == order total) ─
INSERT INTO payments (order_id, provider, amount_cents, captured_at) VALUES
 (1,  'stripe', 20300, '2026-02-10 12:00:05+00'),
 (2,  'paypal', 14900, '2026-02-12 09:30:07+00'),
 (3,  'stripe', 16800, '2026-03-01 15:20:04+00'),
 (4,  'stripe', 12000, '2026-03-05 18:00:03+00'),
 (5,  'adyen',   9500, '2026-03-06 10:10:09+00'),
 (8,  'stripe',  8200, '2026-03-20 08:20:02+00'),
 (9,  'paypal', 15300, '2026-03-22 17:30:06+00'),
 (10, 'stripe', 12900, '2026-03-26 20:15:08+00');

CREATE INDEX ON orders (customer_id);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON order_items (product_id);
CREATE INDEX ON payments (order_id);
ANALYZE;
