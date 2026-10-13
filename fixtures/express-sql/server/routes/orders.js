// @ts-nocheck — fixture for scripts/test-extractors.ts; imports are intentionally unresolvable
const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

router.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id");
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(rows[0]);
});

router.post("/", requireAuth, async (req, res) => {
  const { email, amount } = req.body;
  await pool.query("INSERT INTO orders (email, amount) VALUES ($1, $2)", [email, amount]);
  res.status(201).json({ ok: true });
});

module.exports = router;
