-- BuildQ: record how each BOQ quantity was arrived at.
--
-- The engine already distinguished a figure it READ off a drawing from one it
-- DERIVED, but it threw that distinction away before storing the bill. The
-- consequence was reported from real use: work the drawings did not detail —
-- a roof carcass, most visibly — was dropped instead of assumed, and a bill
-- with a missing line still reads as finished.
--
-- `basis` is one of: read | counted | derived | assumed | manual.
-- `assumption` carries the rule behind an `assumed` quantity, so it can be
-- checked rather than taken on trust.
--
-- Both are nullable and additive: existing rows keep their meaning, and a bill
-- generated before this migration simply reports no basis.

ALTER TABLE "buildq_boq_items" ADD COLUMN "basis" TEXT;
ALTER TABLE "buildq_boq_items" ADD COLUMN "assumption" TEXT;
