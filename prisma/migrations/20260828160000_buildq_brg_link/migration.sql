-- AlterTable
ALTER TABLE "buildq_users" ADD COLUMN     "brgUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "buildq_users_brgUserId_key" ON "buildq_users"("brgUserId");

