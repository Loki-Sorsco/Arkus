CREATE TABLE IF NOT EXISTS "orders" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER REFERENCES users(id),
  "amount" NUMERIC(10,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT orders_amount_check CHECK (amount > 0)
);
CREATE INDEX idx_orders_user ON orders (user_id);
