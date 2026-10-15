'use strict';

// Regenerates the two demo supplier price lists with a realistic *perfume*
// catalogue (the platform trades fragrance, not spirits).
//
//   node scripts/generate-samples.js
//
// Alcodis  -> samples/alcodis-supplier-1.xls   (spreadsheet, per-bottle cost, some per-case)
// Igan     -> samples/igan-supplier-2.xlsx      (spreadsheet, PVP retail, "Und. Caja" pack column)
//
// The layout, sheet names, preamble and column headers are byte-compatible with
// what src/importers/profiles.js expects, so the importer recognises both files
// exactly as before. GTINs are synthesised with valid GS1 check digits and a
// deterministic body so re-running produces the same catalogue.
//
// A deliberate, realistic slice of rows carries data-quality defects (blank or
// invalid barcodes, duplicates, missing prices) and edge cases (per-case prices,
// past expiry dates) so the exceptions queue and the section-6 pack gate have
// something truthful to work with.

const path = require('path');
const XLSX = require('xlsx');

const OUT_DIR = path.join(__dirname, '..', 'samples');

// ---------------------------------------------------------------------------
// Perfume houses. [brand, gender, tier, [[line, [concentrations]]...]]
// Concentrations: EDP | EDT | EDC | Parfum
// ---------------------------------------------------------------------------
const HOUSES = [
  ['Chanel', 'MUJER', 'luxury', [
    ['N°5', ['EDP', 'EDT', 'Parfum']],
    ['Coco Mademoiselle', ['EDP', 'EDT', 'Parfum']],
    ['Chance Eau Tendre', ['EDP', 'EDT']],
    ['Chance Eau Fraiche', ['EDT', 'EDC']],
    ['Gabrielle', ['EDP', 'Parfum']],
    ['Allure Sensuelle', ['EDP', 'EDT']],
  ]],
  ['Chanel', 'HOMBRE', 'luxury', [
    ['Bleu de Chanel', ['EDP', 'EDT', 'Parfum']],
    ['Allure Homme Sport', ['EDT', 'EDC']],
    ['Égoïste', ['EDT']],
    ['Allure Homme Édition Blanche', ['EDP']],
    ['Pour Monsieur', ['EDT']],
  ]],
  ['Dior', 'MUJER', 'luxury', [
    ['J\'adore', ['EDP', 'Parfum', 'EDT']],
    ['Miss Dior', ['EDP', 'EDT', 'Parfum']],
    ['Hypnotic Poison', ['EDP', 'EDT']],
    ['Poison Girl', ['EDP', 'EDT']],
    ['Joy', ['EDP', 'Parfum']],
    ['Diorissimo', ['EDT']],
  ]],
  ['Dior', 'HOMBRE', 'luxury', [
    ['Sauvage', ['EDP', 'EDT', 'Parfum']],
    ['Homme', ['EDP', 'EDT']],
    ['Fahrenheit', ['EDT', 'Parfum']],
    ['Eau Sauvage', ['EDT', 'Parfum']],
    ['Higher', ['EDT']],
  ]],
  ['Lancôme', 'MUJER', 'premium', [
    ['La Vie Est Belle', ['EDP', 'Parfum']],
    ['Idôle', ['EDP', 'Parfum']],
    ['Trésor', ['EDP', 'EDT']],
    ['Miracle', ['EDP', 'EDT']],
    ['Hypnôse', ['EDP']],
    ['Ô de Lancôme', ['EDT']],
  ]],
  ['Yves Saint Laurent', 'MUJER', 'premium', [
    ['Black Opium', ['EDP', 'Parfum']],
    ['Libre', ['EDP', 'Parfum']],
    ['Mon Paris', ['EDP', 'EDT']],
    ['Opium', ['EDP', 'EDT']],
    ['Paris', ['EDP', 'EDT']],
    ['Elle', ['EDP']],
  ]],
  ['Yves Saint Laurent', 'HOMBRE', 'premium', [
    ['Y', ['EDP', 'EDT', 'Parfum']],
    ['La Nuit de L\'Homme', ['EDT', 'EDP']],
    ['L\'Homme', ['EDT', 'EDP']],
    ['Kouros', ['EDT']],
    ['Opium Pour Homme', ['EDP', 'EDT']],
  ]],
  ['Guerlain', 'MUJER', 'luxury', [
    ['Mon Guerlain', ['EDP', 'Parfum']],
    ['Shalimar', ['EDP', 'EDT', 'Parfum']],
    ['La Petite Robe Noire', ['EDP', 'EDT']],
    ['Idylle', ['EDP', 'EDT']],
    ['Insolence', ['EDP', 'EDT']],
    ['Champs-Élysées', ['EDP']],
  ]],
  ['Guerlain', 'HOMBRE', 'luxury', [
    ['L\'Homme Idéal', ['EDP', 'EDT']],
    ['Vetiver', ['EDT', 'Parfum']],
    ['Habit Rouge', ['EDT', 'EDP']],
    ['Homme', ['EDP']],
  ]],
  ['Carolina Herrera', 'MUJER', 'premium', [
    ['Good Girl', ['EDP', 'Parfum']],
    ['212 VIP Rose', ['EDP', 'EDT']],
    ['212 Sexy', ['EDP', 'EDT']],
    ['CH', ['EDP', 'EDT']],
    ['Good Girl Blush', ['EDP']],
    ['Violeta', ['EDP']],
  ]],
  ['Carolina Herrera', 'HOMBRE', 'premium', [
    ['212 VIP Men', ['EDT', 'EDP']],
    ['212 Men', ['EDT', 'EDC']],
    ['Bad Boy', ['EDP', 'EDT']],
    ['CH Men', ['EDT', 'EDP']],
  ]],
  ['Paco Rabanne', 'MUJER', 'premium', [
    ['Lady Million', ['EDP', 'Parfum']],
    ['Olympéa', ['EDP', 'Parfum']],
    ['Black XS', ['EDP', 'EDT']],
    ['Invictus Aqua', ['EDT']],
    ['Fame', ['EDP']],
  ]],
  ['Paco Rabanne', 'HOMBRE', 'premium', [
    ['1 Million', ['EDT', 'EDP', 'Parfum']],
    ['Invictus', ['EDT', 'EDP']],
    ['Phantom', ['EDP', 'EDT']],
    ['Pure XS', ['EDT', 'EDP']],
    ['Ultraviolet', ['EDT']],
  ]],
  ['Hugo Boss', 'HOMBRE', 'mass', [
    ['Bottled', ['EDT', 'EDP', 'Parfum']],
    ['Bottled Infinite', ['EDP', 'EDT']],
    ['Bottled Night', ['EDT', 'EDP']],
    ['Hugo', ['EDT']],
    ['The Scent', ['EDT', 'EDP']],
    ['Boss Bottled Marine', ['EDT']],
  ]],
  ['Hugo Boss', 'MUJER', 'mass', [
    ['Ma Vie', ['EDP', 'EDT']],
    ['Jour Pour Femme', ['EDP']],
    ['Boss Woman', ['EDP']],
    ['The Scent for Her', ['EDP', 'EDT']],
  ]],
  ['Versace', 'MUJER', 'premium', [
    ['Bright Crystal', ['EDP', 'EDT']],
    ['Eros Pour Femme', ['EDP', 'EDT']],
    ['Yellow Diamond', ['EDP', 'EDT']],
    ['Dylan Purple', ['EDP']],
    ['Versace Pour Femme', ['EDP']],
  ]],
  ['Versace', 'HOMBRE', 'premium', [
    ['Eros', ['EDT', 'EDP', 'Parfum']],
    ['Dylan Blue', ['EDT', 'EDP']],
    ['Versace Pour Homme', ['EDT', 'EDC']],
    ['Eros Flame', ['EDP', 'EDT']],
    ['Man Eau Fraiche', ['EDT']],
  ]],
  ['Giorgio Armani', 'MUJER', 'premium', [
    ['Si', ['EDP', 'Parfum']],
    ['Si Passione', ['EDP', 'EDT']],
    ['Acqua di Gioia', ['EDT', 'EDP']],
    ['My Way', ['EDP', 'Parfum']],
    ['Code Donna', ['EDP', 'EDT']],
  ]],
  ['Giorgio Armani', 'HOMBRE', 'premium', [
    ['Acqua di Gio', ['EDT', 'EDP', 'Parfum']],
    ['Acqua di Gio Profumo', ['EDP']],
    ['Code', ['EDT', 'EDP']],
    ['Code Profumo', ['EDP']],
    ['Stronger With You', ['EDT', 'EDP']],
  ]],
  ['Tom Ford', 'UNISEX', 'niche', [
    ['Oud Wood', ['EDP', 'Parfum']],
    ['Tobacco Vanille', ['EDP']],
    ['Tuscan Leather', ['EDP']],
    ['Lost Cherry', ['EDP']],
    ['Black Orchid', ['EDP', 'Parfum']],
    ['Noir Extreme', ['EDP']],
    ['Ombré Leather', ['EDP']],
    ['Neroli Portofino', ['EDP']],
  ]],
  ['Creed', 'HOMBRE', 'niche', [
    ['Aventus', ['EDP', 'Parfum']],
    ['Green Irish Tweed', ['EDP']],
    ['Silver Mountain Water', ['EDP']],
    ['Royal Oud', ['EDP']],
    ['Viking', ['EDP']],
    ['Millesime Imperial', ['EDP']],
  ]],
  ['Jean Paul Gaultier', 'HOMBRE', 'premium', [
    ['Le Male', ['EDT', 'Parfum']],
    ['Ultra Male', ['EDT', 'EDP']],
    ['Scandal Pour Homme', ['EDT', 'EDP']],
    ['Le Beau', ['EDT', 'EDP']],
  ]],
  ['Jean Paul Gaultier', 'MUJER', 'premium', [
    ['Classique', ['EDT', 'EDP']],
    ['Scandal', ['EDP', 'Parfum']],
    ['La Belle', ['EDP', 'Parfum']],
    ['Divine', ['EDP']],
  ]],
  ['Mugler', 'MUJER', 'premium', [
    ['Angel', ['EDP', 'Parfum']],
    ['Alien', ['EDP', 'Parfum']],
    ['Alien Goddess', ['EDP', 'EDT']],
    ['Angel Muse', ['EDP']],
    ['Aura', ['EDP']],
  ]],
  ['Mugler', 'HOMBRE', 'premium', [
    ['A*Men', ['EDT', 'Parfum']],
    ['Alien Man', ['EDT', 'EDP']],
  ]],
  ['Marc Jacobs', 'MUJER', 'premium', [
    ['Daisy', ['EDT', 'EDP']],
    ['Daisy Love', ['EDP', 'EDT']],
    ['Perfect', ['EDP', 'EDT']],
    ['Decadence', ['EDP']],
    ['Dot', ['EDP', 'EDT']],
  ]],
  ['Dolce & Gabbana', 'MUJER', 'premium', [
    ['Light Blue', ['EDT', 'EDP']],
    ['The Only One', ['EDP', 'Parfum']],
    ['Dolce', ['EDP', 'EDT']],
    ['Pour Femme', ['EDP', 'EDT']],
    ['Q', ['EDP']],
  ]],
  ['Dolce & Gabbana', 'HOMBRE', 'premium', [
    ['K', ['EDP', 'EDT']],
    ['Light Blue Pour Homme', ['EDT', 'EDP']],
    ['The One', ['EDT', 'EDP']],
    ['Pour Homme', ['EDT', 'EDC']],
    ['Intenso', ['EDP']],
  ]],
  ['Givenchy', 'MUJER', 'premium', [
    ['L\'Interdit', ['EDP', 'Parfum']],
    ['Very Irrésistible', ['EDP', 'EDT']],
    ['Dahlia Noir', ['EDP', 'EDT']],
    ['Ange ou Démon', ['EDP']],
  ]],
  ['Givenchy', 'HOMBRE', 'premium', [
    ['Gentleman', ['EDP', 'EDT']],
    ['Pi', ['EDT', 'EDP']],
    ['Xeryus Rouge', ['EDT']],
    ['Pour Homme', ['EDT']],
  ]],
  ['Prada', 'MUJER', 'premium', [
    ['Candy', ['EDP', 'Parfum']],
    ['Paradoxe', ['EDP', 'Parfum']],
    ['Infusion d\'Iris', ['EDP', 'EDT']],
    ['Candy Kiss', ['EDP']],
    ['Prada Tendre', ['EDP']],
  ]],
  ['Prada', 'HOMBRE', 'premium', [
    ['Luna Rossa', ['EDT', 'EDP']],
    ['Luna Rossa Carbon', ['EDP', 'EDT']],
    ['Luna Rossa Ocean', ['EDP', 'EDT']],
    ['L\'Homme', ['EDT', 'EDP']],
  ]],
  ['Gucci', 'MUJER', 'premium', [
    ['Guilty', ['EDP', 'EDT']],
    ['Bloom', ['EDP', 'Parfum']],
    ['Bamboo', ['EDP', 'EDT']],
    ['Flora Gorgeous Gardenia', ['EDP']],
    ['Rush', ['EDT', 'EDP']],
  ]],
  ['Gucci', 'HOMBRE', 'premium', [
    ['Guilty Pour Homme', ['EDT', 'EDP']],
    ['Guilty Black', ['EDT']],
    ['Made to Measure', ['EDP', 'EDT']],
    ['by Gucci Pour Homme', ['EDT']],
  ]],
  ['Burberry', 'MUJER', 'premium', [
    ['Her', ['EDP', 'Parfum']],
    ['My Burberry', ['EDP', 'EDT']],
    ['Brit for Her', ['EDT', 'EDP']],
    ['London for Women', ['EDP', 'EDT']],
    ['Body', ['EDP']],
  ]],
  ['Burberry', 'HOMBRE', 'premium', [
    ['Mr Burberry', ['EDT', 'EDP']],
    ['Hero', ['EDP', 'EDT']],
    ['Brit for Him', ['EDT', 'EDP']],
    ['London for Men', ['EDT', 'EDP']],
    ['Touch for Men', ['EDT']],
  ]],
  ['Montblanc', 'HOMBRE', 'mass', [
    ['Explorer', ['EDP', 'EDT']],
    ['Legend', ['EDT', 'EDP']],
    ['Legend Spirit', ['EDT']],
    ['Starwalker', ['EDT']],
    ['Emblem', ['EDT', 'EDP']],
  ]],
  ['Montblanc', 'MUJER', 'mass', [
    ['Signature', ['EDP', 'EDT']],
    ['Femme Individuelle', ['EDP']],
    ['Presence', ['EDT']],
  ]],
  ['Azzaro', 'HOMBRE', 'mass', [
    ['Wanted', ['EDT', 'EDP']],
    ['Chrome', ['EDT', 'EDC']],
    ['Chrome Aqua', ['EDT']],
    ['The Most Wanted', ['EDP']],
    ['Azzaro Pour Homme', ['EDT']],
  ]],
  ['Azzaro', 'MUJER', 'mass', [
    ['Azzaro Pour Elle', ['EDP', 'EDT']],
    ['Wanted Girl', ['EDP']],
  ]],
  ['Mercedes-Benz', 'HOMBRE', 'mass', [
    ['The Move', ['EDT', 'EDP']],
    ['Club', ['EDT', 'EDP']],
    ['Select', ['EDT']],
    ['Mercedes-Benz for Men', ['EDT', 'EDP']],
  ]],
  ['Bentley', 'HOMBRE', 'mass', [
    ['Bentley for Men', ['EDT', 'EDP']],
    ['Bentley Intense', ['EDP', 'EDT']],
    ['Bentley Azure', ['EDT']],
    ['Bentley Infinite', ['EDP']],
  ]],
  ['Valentino', 'MUJER', 'premium', [
    ['Born in Roma Donna', ['EDP', 'Parfum']],
    ['Voce Viva', ['EDP', 'EDT']],
    ['Valentina', ['EDP', 'EDT']],
    ['Donna', ['EDP']],
  ]],
  ['Valentino', 'HOMBRE', 'premium', [
    ['Born in Roma Uomo', ['EDP', 'EDT']],
    ['Uomo Intense', ['EDP']],
    ['Born in Roma Coral Fantasy', ['EDP']],
    ['Uomo', ['EDT']],
  ]],
  ['Hermès', 'UNISEX', 'luxury', [
    ['Terre d\'Hermès', ['EDP', 'Parfum', 'EDT']],
    ['Twilly d\'Hermès', ['EDP', 'EDT']],
    ['Un Jardin sur le Nil', ['EDT']],
    ['H24', ['EDP', 'EDT']],
  ]],
  ['Jo Malone London', 'UNISEX', 'niche', [
    ['Lime Basil & Mandarin', ['EDC', 'EDP']],
    ['Wood Sage & Sea Salt', ['EDC', 'EDP']],
    ['Peony & Blush Suede', ['EDC', 'EDP']],
    ['English Pear & Freesia', ['EDC', 'EDP']],
  ]],
  ['Le Labo', 'UNISEX', 'niche', [
    ['Santal 33', ['EDP', 'Parfum']],
    ['Rose 31', ['EDP']],
    ['Another 13', ['EDP']],
    ['Bergamote 22', ['EDP']],
  ]],
  ['Byredo', 'UNISEX', 'niche', [
    ['Gypsy Water', ['EDP', 'Parfum']],
    ['Bal d\'Afrique', ['EDP']],
    ['Blanche', ['EDP']],
    ['Mojave Ghost', ['EDP', 'Parfum']],
  ]],
  ['Maison Francis Kurkdjian', 'UNISEX', 'niche', [
    ['Baccarat Rouge 540', ['EDP', 'Parfum']],
    ['Aqua Universalis', ['EDP', 'EDC']],
    ['Oud Satin Mood', ['EDP']],
    ['Amyris', ['EDP']],
  ]],
  ['Parfums de Marly', 'UNISEX', 'niche', [
    ['Layton', ['EDP', 'Parfum']],
    ['Herod', ['EDP']],
    ['Pegasus', ['EDP']],
    ['Delina', ['EDP', 'Parfum']],
    ['Carlisle', ['EDP']],
  ]],
  ['Xerjoff', 'UNISEX', 'niche', [
    ['Naxos', ['EDP']],
    ['Erba Pura', ['EDP', 'Parfum']],
    ['Alexandria II', ['EDP']],
    ['Torino 22', ['EDP']],
  ]],
  ['Amouage', 'UNISEX', 'niche', [
    ['Interlude Man', ['EDP']],
    ['Reflection Man', ['EDP']],
    ['Epic Woman', ['EDP']],
    ['Jubilation XXV', ['EDP']],
  ]],
  ['Nishane', 'UNISEX', 'niche', [
    ['Hacivat', ['EDP', 'Parfum']],
    ['Ani', ['EDP']],
    ['Fan Your Flames', ['EDP']],
    ['Wulong Cha', ['EDP']],
  ]],
  ['Initio', 'UNISEX', 'niche', [
    ['Oud for Greatness', ['EDP', 'Parfum']],
    ['Side Effect', ['EDP']],
    ['Rehab', ['EDP']],
    ['Psychedelic Love', ['EDP']],
  ]],
  ['Louis Vuitton', 'UNISEX', 'luxury', [
    ['Ombre Nomade', ['EDP', 'Parfum']],
    ['Imagination', ['EDP']],
    ['Attrape-Rêves', ['EDP']],
    ['L\'Immensité', ['EDP']],
    ['Météore', ['EDP']],
  ]],
  ['Estée Lauder', 'MUJER', 'mass', [
    ['Pleasures', ['EDP', 'EDT']],
    ['Beautiful', ['EDP', 'EDT']],
    ['Knowing', ['EDP']],
    ['Modern Muse', ['EDP', 'EDT']],
  ]],
  ['Clinique', 'UNISEX', 'mass', [
    ['Happy', ['EDP', 'EDT']],
    ['Aromatics Elixir', ['EDP']],
    ['Happy for Men', ['EDC', 'EDT']],
  ]],
  ['Narciso Rodriguez', 'MUJER', 'premium', [
    ['For Her', ['EDP', 'EDT']],
    ['Narciso', ['EDP']],
    ['Pure Musc', ['EDP', 'Parfum']],
    ['Rouge', ['EDP']],
  ]],
  ['Viktor&Rolf', 'MUJER', 'premium', [
    ['Flowerbomb', ['EDP', 'Parfum']],
    ['Bonbon', ['EDP', 'EDT']],
    ['Flowerbomb Ruby Orchid', ['EDP']],
  ]],
  ['Ralph Lauren', 'HOMBRE', 'mass', [
    ['Polo Blue', ['EDT', 'EDP']],
    ['Polo Red', ['EDP', 'EDT']],
    ['Polo Black', ['EDT']],
    ['Ralph\'s Club', ['EDP', 'EDT']],
  ]],
  ['Ralph Lauren', 'MUJER', 'mass', [
    ['Ralph', ['EDT', 'EDP']],
    ['Romance', ['EDP', 'EDT']],
    ['Polo Woman', ['EDP']],
  ]],
  ['Calvin Klein', 'UNISEX', 'mass', [
    ['CK One', ['EDT', 'EDC']],
    ['CK Be', ['EDT']],
    ['Eternity', ['EDP', 'EDT']],
    ['Escape', ['EDP', 'EDT']],
    ['Euphoria', ['EDP', 'EDT']],
  ]],
  ['Davidoff', 'HOMBRE', 'mass', [
    ['Cool Water', ['EDT', 'EDC']],
    ['Cool Water Intense', ['EDP', 'EDT']],
    ['Champion', ['EDT']],
    ['Zino', ['EDT']],
  ]],
  ['Davidoff', 'MUJER', 'mass', [
    ['Cool Water Woman', ['EDT', 'EDC']],
    ['Echo', ['EDT', 'EDP']],
  ]],
  ['Issey Miyake', 'UNISEX', 'mass', [
    ['L\'Eau d\'Issey', ['EDT', 'EDP']],
    ['L\'Eau d\'Issey Pour Homme', ['EDT', 'EDP']],
    ['A Drop d\'Issey', ['EDP']],
  ]],
  ['Kenzo', 'UNISEX', 'mass', [
    ['Flower by Kenzo', ['EDP', 'EDT']],
    ['World', ['EDT', 'EDP']],
    ['Kenzo Homme', ['EDT', 'EDP']],
    ['L\'Eau par Kenzo', ['EDT', 'EDC']],
  ]],
  ['Bvlgari', 'MUJER', 'premium', [
    ['Omnia Crystalline', ['EDT', 'EDP']],
    ['Goldea', ['EDP', 'Parfum']],
    ['Rose Goldea', ['EDP']],
  ]],
  ['Bvlgari', 'HOMBRE', 'premium', [
    ['Man in Black', ['EDP', 'EDT']],
    ['Aqua Pour Homme', ['EDT', 'EDC']],
    ['Bvlgari Man', ['EDP', 'EDT']],
  ]],
  ['Elizabeth Arden', 'MUJER', 'mass', [
    ['Green Tea', ['EDC', 'EDT']],
    ['Red Door', ['EDP', 'EDT']],
    ['Sunflowers', ['EDT', 'EDP']],
    ['5th Avenue', ['EDP', 'EDT']],
  ]],
  ['Chloé', 'MUJER', 'premium', [
    ['Chloé', ['EDP', 'Parfum']],
    ['Nomade', ['EDP', 'Parfum']],
    ['Love Story', ['EDP', 'EDT']],
    ['Roses de Chloé', ['EDP', 'EDT']],
  ]],
  ['Salvatore Ferragamo', 'MUJER', 'premium', [
    ['Signorina', ['EDP', 'EDT']],
    ['Amo Ferragamo', ['EDP', 'Parfum']],
    ['Incanto', ['EDP', 'EDT']],
  ]],
  ['Salvatore Ferragamo', 'HOMBRE', 'premium', [
    ['Uomo', ['EDP', 'EDT']],
    ['F by Ferragamo', ['EDT', 'EDP']],
    ['Acqua Essenziale', ['EDT']],
  ]],
];

const CONC_LABEL = {
  EDP: 'Eau de Parfum',
  EDT: 'Eau de Toilette',
  EDC: 'Eau de Cologne',
  Parfum: 'Parfum',
};

// Sizes (ml) offered per concentration.
const SIZES = {
  Parfum: [15, 30, 50, 75],
  EDP: [30, 50, 75, 100, 150],
  EDT: [50, 75, 100, 150],
  EDC: [100, 150, 200],
};

const TIER_BASE = { luxury: 118, niche: 178, premium: 86, mass: 54 };
const CONC_FACTOR = { Parfum: 1.58, EDP: 1.0, EDT: 0.82, EDC: 0.68 };

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------
function rt(n) { return Math.round(n * 100) / 100; }

function checkDigit(body) {
  let sum = 0;
  const rev = body.split('').reverse();
  for (let i = 0; i < rev.length; i++) sum += i % 2 === 0 ? Number(rev[i]) * 3 : Number(rev[i]);
  return (10 - (sum % 10)) % 10;
}

// 12-digit body -> 13-digit EAN with a valid check digit.
function ean13(body12) {
  const body = String(body12).padStart(12, '0').slice(-12);
  return body + checkDigit(body);
}

function bottleEan(seq) { return ean13('84' + String(seq).padStart(10, '0')); }
function caseEan(seq) { return ean13('87' + String(seq).padStart(10, '0')); }

function priceFor(tier, conc, sizeMl) {
  const raw = TIER_BASE[tier] * CONC_FACTOR[conc] * Math.pow(sizeMl / 100, 0.62);
  const rounded = Math.max(9.95, Math.round(raw) - 0.05);
  return Math.round(rounded * 100) / 100;
}

// ---------------------------------------------------------------------------
// Build the master SKU list
// ---------------------------------------------------------------------------
function buildSkus() {
  const skus = [];
  let seq = 1;
  for (const [brand, gender, tier, lines] of HOUSES) {
    for (const [line, concs] of lines) {
      for (const conc of concs) {
        for (const sizeMl of SIZES[conc]) {
          skus.push({
            idx: seq,
            brand,
            gender,
            tier,
            line,
            conc,
            sizeMl,
            bottleEan: bottleEan(seq),
            caseEan: seq % 4 === 0 ? null : caseEan(seq), // not every line has a box barcode
            pvp: priceFor(tier, conc, sizeMl),
          });
          seq++;
        }
      }
    }
  }
  return skus;
}

// Description seen by the shipper, e.g. "CHANEL N°5 EAU DE PARFUM 100 ML".
function iganDescription(sku) {
  return `${sku.brand.toUpperCase()} ${sku.line.toUpperCase()} ${sku.conc} VAP. ${sku.sizeMl}ML`;
}

// Alcodis style: "Chanel N°5 Eau de Parfum Vaporizador 100 ml", sometimes with
// an explicit unit pack ("6 UDS") which the importer reads as a case pack.
function alcodisDescription(sku, withPack) {
  const base = `${sku.brand} ${sku.line} ${CONC_LABEL[sku.conc]} Vaporizador ${sku.sizeMl} ml`;
  return withPack ? `${base} ${withPack} UDS` : base;
}

// Deterministic pseudo-random in [0,1) from an integer.
function noise(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Alcodis rows
// ---------------------------------------------------------------------------
function alcodisRows(skus) {
  const header = ['EAN (Bt', 'DUN (Box)', 'Nº', 'Categoría', 'Descripción', 'Volumen', '% Alc.', 'ROSCA/IRRELLENABLE', 'Precio', 'TU PEDIDO', 'Foto y Ficha'];
  const preamble = [
    [null, null, null, 'LISTADO DE PRECIOS'],
    [null, null, null, 'Condiciones:'],
    [null, null, null, '*Sujeto a disponibilidad'],
    [null, null, null, '*Esta oferta reemplaza a las anteriores'],
    [],
    [],
  ];
  const rows = preamble.concat([header]);

  skus.forEach((sku, i) => {
    const rowNo = i + 1;
    // Data-quality defects injected on a fixed cadence.
    const blankBarcode = rowNo % 41 === 0;
    const invalidBarcode = !blankBarcode && rowNo % 53 === 0;
    const missingPrice = rowNo % 89 === 0;

    // ~13% of lines are quoted per case, with a pack size in the description.
    const perCase = rowNo % 8 === 0;
    const packUnits = perCase ? (rowNo % 2 === 0 ? 6 : 12) : null;

    const costRatio = 0.4 + ((i * 7) % 21) / 100; // 0.40 .. 0.60
    let precio = rt(sku.pvp * costRatio);
    if (perCase) precio = rt(precio * packUnits); // quote the whole case
    if (missingPrice) precio = null;

    let ean = sku.bottleEan;
    if (blankBarcode) ean = null;
    else if (invalidBarcode) ean = sku.bottleEan.slice(0, 12) + String((Number(sku.bottleEan.slice(-1)) + 1) % 10);

    const dun = sku.caseEan;
    const alc = rowNo % 7 === 0 ? null : '80,00';

    rows.push([
      ean,
      dun,
      '2.' + (1000 + sku.idx),
      `PERFUME ${sku.gender}`,
      alcodisDescription(sku, packUnits),
      0.001 * sku.sizeMl,
      alc,
      rowNo % 5 === 0 ? 'RECARGABLE' : 'SPRAY',
      precio,
      null,
      'Ver detalles',
    ]);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Igan rows
// ---------------------------------------------------------------------------
function iganRows(skus) {
  const header = [null, 'SUBCATEGORY', 'Artículo Descripción', 'Código', 'Link image', 'CodigoEAN', 'Vol. Ltr.', 'Und. Caja', 'Caja Pallet', '% Vol.', 'Caducidad ', 'Observ.', 'Stock Pallet', 'PVP'];
  const preamble = [];
  for (let i = 0; i < 28; i++) preamble.push([]);
  preamble[1] = ['DISCLAIMER: PRICES OF THIS LLIST ARE EXW LLEIDA, TRANSPORT NOT INCLUDED'];
  const rows = preamble.concat([header]);

  const SUBCAT = { EDP: 'EAU DE PARFUM', EDT: 'EAU DE TOILETTE', EDC: 'EAU DE COLOGNE', Parfum: 'EXTRAIT DE PARFUM' };
  const today = new Date('2026-10-15T00:00:00Z');
  const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

  skus.forEach((sku, i) => {
    const rowNo = i + 1;
    const blankBarcode = rowNo % 47 === 0;
    const missingPrice = rowNo % 97 === 0;

    const undCaja = rowNo % 3 === 0 ? 12 : 6;
    const cajaPallet = undCaja === 12 ? 48 : 72;
    let pvp = sku.pvp;
    if (missingPrice) pvp = null;
    else if (rowNo % 11 === 0) pvp = rt(pvp * 1.03); // this vendor prices a touch higher

    // A few lots expire in the past (expired-stock flag) and a few have no date.
    let expiry;
    if (rowNo % 29 === 0) expiry = fmt(new Date('2024-01-01T00:00:00Z'));
    else if (rowNo % 6 === 0) expiry = null;
    else { const d = new Date(today.getTime() + (30 + (rowNo % 300)) * 864e5); expiry = fmt(d); }

    let ean = sku.bottleEan;
    if (blankBarcode) ean = null;

    rows.push([
      '',
      SUBCAT[sku.conc],
      iganDescription(sku),
      2000000 + sku.idx,
      'image',
      ean,
      0.001 * sku.sizeMl,
      undCaja,
      String(cajaPallet),
      rowNo % 9 === 0 ? null : 80,
      expiry,
      '(en blanco)',
      Math.round((1 + noise(sku.idx) * 4) * 100) / 100,
      pvp,
    ]);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Write workbooks
// ---------------------------------------------------------------------------
function writeWorkbook(rows, outPath, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, outPath, { bookType: outPath.endsWith('.xls') ? 'biff8' : 'xlsx' });
}

function main() {
  const skus = buildSkus();
  const ALCODIS_COUNT = 1400;
  const IGAN_OFFSET = 700;
  const IGAN_COUNT = 1300;

  const alcodisSkus = skus.slice(0, ALCODIS_COUNT);
  const iganSkus = skus.slice(IGAN_OFFSET, IGAN_OFFSET + IGAN_COUNT);

  writeWorkbook(alcodisRows(alcodisSkus), path.join(OUT_DIR, 'alcodis-supplier-1.xls'), 'Tarifas Alcodis');
  writeWorkbook(iganRows(iganSkus), path.join(OUT_DIR, 'igan-supplier-2.xlsx'), 'Igan-Tarifa');

  const shared = Math.max(0, Math.min(ALCODIS_COUNT, IGAN_OFFSET + IGAN_COUNT) - IGAN_OFFSET);
  console.log(`master SKUs: ${skus.length}`);
  console.log(`Alcodis rows: ${alcodisSkus.length}  (bottle EANs ${alcodisSkus[0].bottleEan}..${alcodisSkus[alcodisSkus.length - 1].bottleEan})`);
  console.log(`Igan rows:    ${iganSkus.length}`);
  console.log(`shared products (both lists): ${shared}`);
  console.log(`unique products: ${new Set(skus.slice(0, ALCODIS_COUNT).concat(iganSkus).map((s) => s.bottleEan)).size}`);
}

main();

module.exports = { buildSkus, alcodisRows, iganRows };
