-- Shipped by wiki-formant. The tables prisma/wiki.prisma declares, as
-- `prisma migrate diff` writes them, for a migration that moves an existing
-- wiki's rows in: create these, INSERT ... SELECT the old rows, retarget any
-- foreign keys, drop the old tables, then build search_tsv with fts-ddl.



-- CreateTable
CREATE TABLE "WikiPage" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "siteId" TEXT NOT NULL DEFAULT '',
    "tagPath" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "authorId" TEXT,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WikiRevision" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "version" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "message" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WikiPage_siteId_tagPath_updatedAt_idx" ON "WikiPage"("siteId", "tagPath", "updatedAt");

-- CreateIndex
CREATE INDEX "WikiPage_siteId_updatedAt_idx" ON "WikiPage"("siteId", "updatedAt");

-- CreateIndex

-- CreateIndex
CREATE UNIQUE INDEX "WikiPage_siteId_tagPath_slug_key" ON "WikiPage"("siteId", "tagPath", "slug");

-- CreateIndex
CREATE INDEX "WikiRevision_pageId_createdAt_idx" ON "WikiRevision"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "WikiRevision_authorId_createdAt_idx" ON "WikiRevision"("authorId", "createdAt");

-- AddForeignKey
ALTER TABLE "WikiRevision" ADD CONSTRAINT "WikiRevision_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- STRUCTURE S7: the Data API gets nothing. Prisma connects as postgres, which
-- bypasses RLS; with no policies, anon and authenticated read nothing.
ALTER TABLE "WikiPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WikiRevision" ENABLE ROW LEVEL SECURITY;

-- The full-text column and its index: `npx fts-ddl '"WikiPage"'` after the
-- rows are in, never a plain tsvector column (it would stay empty).
