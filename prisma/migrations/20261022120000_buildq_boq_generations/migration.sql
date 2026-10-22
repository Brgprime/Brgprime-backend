-- BuildQ: run BOQ generation in the background.
--
-- Generation is one long model call, and the request used to wait for it. The
-- app is served through a Netlify proxy that gives up after ~26 seconds, so a
-- bill that took longer surfaced as "Request failed (504)" even though the
-- server carried on and often finished. Each run is now a row the client polls.

-- CreateTable
CREATE TABLE "buildq_boq_generations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "revisionId" TEXT,
    "generated" INTEGER,
    "result" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "buildq_boq_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "buildq_boq_generations_projectId_idx" ON "buildq_boq_generations"("projectId");

-- AddForeignKey
ALTER TABLE "buildq_boq_generations" ADD CONSTRAINT "buildq_boq_generations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
