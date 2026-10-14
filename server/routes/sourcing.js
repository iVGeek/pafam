'use strict';

const express = require('express');
const router = express.Router();
const { sourceLowest } = require('../services/sourcing');

// Business Q1: lowest executable landed cost for an exact SKU + quantity,
// delivered to our destination. Accepts a product id or a barcode (gtin).
router.get('/sourcing/lowest', (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : null;
  const gtin = req.query.gtin || null;
  if (!productId && !gtin) return res.status(400).json({ error: 'productId or gtin required' });

  const result = sourceLowest({
    productId,
    gtin,
    quantity: Number(req.query.quantity) || 1,
    destination: req.query.destination || req.query.dest || undefined,
    baseCurrency: req.query.base || undefined,
  });

  if (!result.found) return res.status(404).json({ error: 'product not found', query: { productId, gtin } });
  res.json(result);
});

module.exports = router;
