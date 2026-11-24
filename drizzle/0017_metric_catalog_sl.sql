-- 0017_metric_catalog_sl.sql — THE CATALOGUE LEARNS SLOVENE.
--
-- WHY. The product's locales are `en` and `sl`, the pilot market is Slovenia,
-- and until now `metric_catalog` carried Russian (`title`, the workbook's
-- wording) and English (`title_en`, `disclosure_title_en`, О-20) only. A
-- Slovenian user read every disclosure heading in English. The landing page's
-- B1–B11 panel was built from the standard's own Slovene names (29.08.2026)
-- and so ran ahead of the product it advertised.
--
-- WHAT. Two nullable columns, additive; and the eleven Basic + nine
-- Comprehensive DISCLOSURE headings filled from the official Slovene text of
-- Commission Recommendation (EU) 2025/1710 (EUR-Lex, CELEX:32025H1710, SL),
-- verbatim. The per-datapoint `title_sl` stays NULL here: 141 datapoint titles
-- are a translation deliverable that arrives in a data migration of its own,
-- reviewed by the methodologist, not typed into a schema change. A NULL
-- `title_sl` falls back to `title_en` in every reader.
--
-- `metric_catalog` is seeded by 0004's generated block and by `seed.ts`
-- (DO UPDATE on the workbook columns); neither names these columns, so a
-- re-seed leaves them alone.

ALTER TABLE metric_catalog
  ADD COLUMN IF NOT EXISTS disclosure_title_sl text;
ALTER TABLE metric_catalog
  ADD COLUMN IF NOT EXISTS title_sl text;

UPDATE metric_catalog SET disclosure_title_sl = v.title
FROM (VALUES
  ('B1',  'Podlaga za pripravo'),
  ('B2',  'Prakse, politike in prihodnje pobude za prehod na bolj trajnostno gospodarstvo'),
  ('B3',  'Energija in emisije toplogrednih plinov'),
  ('B4',  'Onesnaževanje zraka, vode in tal'),
  ('B5',  'Biotska raznovrstnost'),
  ('B6',  'Voda'),
  ('B7',  'Raba virov, krožno gospodarstvo in ravnanje z odpadki'),
  ('B8',  'Delovna sila – splošne značilnosti'),
  ('B9',  'Delovna sila – zdravje in varnost'),
  ('B10', 'Delovna sila – plačilo, kolektivna pogajanja in usposabljanje'),
  ('B11', 'Obsodbe in denarne kazni zaradi korupcije in podkupovanja'),
  ('C1',  'Strategija: poslovni model in pobude, povezane s trajnostnostjo'),
  ('C2',  'Opis praks, politik in prihodnjih pobud za prehod na bolj trajnostno gospodarstvo'),
  ('C3',  'Cilji zmanjšanja emisij TGP in podnebni prehod'),
  ('C4',  'Podnebna tveganja'),
  ('C5',  'Dodatne (splošne) značilnosti delovne sile'),
  ('C6',  'Dodatne informacije o lastni delovni sili – politike in postopki na področju človekovih pravic'),
  ('C7',  'Resni incidenti v zvezi s človekovimi pravicami'),
  ('C8',  'Prihodki iz nekaterih dejavnosti in izključitev iz referenčnih vrednosti EU'),
  ('C9',  'Razmerje pri zastopanosti spolov v organu upravljanja')
) AS v(code, title)
WHERE metric_catalog.disclosure_code = v.code
  AND metric_catalog.disclosure_title_sl IS NULL;
