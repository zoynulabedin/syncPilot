-- Which rows a finished import deletes no longer depends on comparing a time
-- from the database's clock with one from a worker's. Each page takes the next
-- value of this sequence, and a new import takes one when it is created.
CREATE SEQUENCE "CatalogSnapshot_generation_seq" AS INTEGER;

-- Imports already recorded stay at 0, and so do existing rows. An import still
-- running when this is deployed then counts every row as current and deletes
-- nothing; the next import removes what the store no longer has.
ALTER TABLE "CatalogSnapshot" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CatalogSnapshot" ALTER COLUMN "generation" SET DEFAULT nextval('"CatalogSnapshot_generation_seq"');
ALTER SEQUENCE "CatalogSnapshot_generation_seq" OWNED BY "CatalogSnapshot"."generation";

ALTER TABLE "ProductSnapshot" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VariantSnapshot" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LocationSnapshot" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventorySnapshot" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
