// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
const express = require("express");
const passport = require("passport");
const ordersRouter = require("./routes/orders");
const app = express();
app.use(express.json());
app.use(passport.initialize());
app.use("/api/orders", ordersRouter);
app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(3000);
