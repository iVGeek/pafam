'use strict';

// Standard supplier template (derived from brief section 5) and the canonical
// normalized offer record the importer produces. Vendor adapters map their
// messy source columns onto these field keys.

const FIELD_GROUPS = {
  'Source and dates': [
    'supplierId', 'supplierName', 'offerId', 'listDate', 'validUntil',
    'lastStockConfirmation', 'sourceFileId', 'sourceRow',
  ],
  'Product identity': [
    'gtinSource', 'internalSku', 'brand', 'fragranceName', 'concentration',
    'sizeMl', 'genderCategory', 'setContents', 'category', 'description',
  ],
  'Packaging and condition': [
    'packType', 'hasCap', 'hasBox', 'sealedStatus', 'damageStatus',
    'lotReference', 'manufactureDate', 'capType', 'refillable',
  ],
  'Price and quantity': [
    'currency', 'price', 'priceBasis', 'unitsPerCase', 'availableQuantity',
    'quantityUnit', 'moq', 'orderMultiple', 'tierMin', 'tierMax', 'rrp',
  ],
  'Logistics and terms': [
    'stockCountry', 'stockWarehouse', 'countryOfOrigin', 'incoterm',
    'incotermPlace', 'readyDate', 'leadTimeDays', 'paymentTerms', 'freightInclusions',
  ],
  'Eligibility and evidence': [
    'permittedDestination', 'permittedChannels', 'usSuitabilityStatus',
    'authenticityDocuments', 'stockOwnerId', 'uniqueLotRef', 'stockConfidence',
    'expiryDate', 'notes',
  ],
};

// Case barcode captured separately (never merged into the bottle barcode).
const CASE_GTIN_FIELD = 'caseGtinSource';

function emptyOffer() {
  const o = {};
  for (const group of Object.values(FIELD_GROUPS)) {
    for (const f of group) o[f] = null;
  }
  o[CASE_GTIN_FIELD] = null;
  return o;
}

module.exports = { FIELD_GROUPS, CASE_GTIN_FIELD, emptyOffer };
