-- CreateTable
CREATE TABLE "buildq_organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL DEFAULT 'Construction',
    "country" TEXT NOT NULL DEFAULT 'Nigeria',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_users" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "phone" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT NOT NULL DEFAULT '',
    "photoUrl" TEXT NOT NULL DEFAULT '',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "resetTokenHash" TEXT,
    "resetExpiresAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_team_invitations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'qs',
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_team_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_subscriptions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "plan" TEXT,
    "trialStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_payments" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "amountNaira" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channel" TEXT NOT NULL DEFAULT 'paystack',
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_projects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'Residential',
    "status" TEXT NOT NULL DEFAULT 'Tender',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "budget" BIGINT NOT NULL DEFAULT 0,
    "spent" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "cover" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'qs',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_documents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "ext" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'Drawing',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "mime" TEXT NOT NULL DEFAULT '',
    "storageKey" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL DEFAULT '',
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'Analyzing',
    "pageCount" INTEGER,
    "detectedScale" TEXT,

    CONSTRAINT "buildq_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_analysis_jobs" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_analysis_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_detected_elements" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "count" INTEGER,
    "length" DOUBLE PRECISION,
    "area" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    "unit" TEXT,
    "confidence" DOUBLE PRECISION,
    "geometry" JSONB,

    CONSTRAINT "buildq_detected_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_measurements" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#1CA5F6',
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_boq_revisions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "generatedFrom" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'engine',
    "standard" TEXT NOT NULL DEFAULT 'NIQS',
    "region" TEXT NOT NULL DEFAULT 'Lagos',
    "notes" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_boq_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_boq_items" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rate" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "sources" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_boq_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_variations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "revisionFrom" INTEGER,
    "revisionTo" INTEGER,
    "impactNaira" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "raisedById" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "buildq_variations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_rates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Materials',
    "unit" TEXT NOT NULL,
    "rateNaira" INTEGER NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'Lagos',
    "source" TEXT NOT NULL DEFAULT 'Demo seed',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_rate_history" (
    "id" TEXT NOT NULL,
    "rateId" TEXT NOT NULL,
    "rateNaira" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_rate_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_cost_lines" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "item" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" INTEGER NOT NULL DEFAULT 0,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section" TEXT NOT NULL DEFAULT '',
    "sourceFile" TEXT NOT NULL DEFAULT '',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewsCount" INTEGER NOT NULL DEFAULT 0,
    "years" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "unlockPrice" INTEGER NOT NULL DEFAULT 1000,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerOrgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending review',
    "listingFeePaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_vendor_products" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "priceNaira" INTEGER NOT NULL,

    CONSTRAINT "buildq_vendor_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_vendor_unlocks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "paymentId" TEXT,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_vendor_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_saved_prices" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" INTEGER NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_saved_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_reports" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'cost-summary',
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "storageKey" TEXT NOT NULL DEFAULT '',
    "storageUrl" TEXT NOT NULL DEFAULT '',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'info',
    "link" TEXT NOT NULL DEFAULT '',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_activity_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'info',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_assistant_threads" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_assistant_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_assistant_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buildq_assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildq_regions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "materialFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "labourFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "equipmentFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "benchmarkNaira" BIGINT,
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildq_regions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "buildq_users_email_key" ON "buildq_users"("email");

-- CreateIndex
CREATE INDEX "buildq_users_orgId_idx" ON "buildq_users"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_team_invitations_tokenHash_key" ON "buildq_team_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "buildq_team_invitations_orgId_idx" ON "buildq_team_invitations"("orgId");

-- CreateIndex
CREATE INDEX "buildq_team_invitations_email_idx" ON "buildq_team_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_subscriptions_orgId_key" ON "buildq_subscriptions"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_payments_reference_key" ON "buildq_payments"("reference");

-- CreateIndex
CREATE INDEX "buildq_payments_orgId_idx" ON "buildq_payments"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_projects_code_key" ON "buildq_projects"("code");

-- CreateIndex
CREATE INDEX "buildq_projects_orgId_idx" ON "buildq_projects"("orgId");

-- CreateIndex
CREATE INDEX "buildq_project_members_userId_idx" ON "buildq_project_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_project_members_projectId_userId_key" ON "buildq_project_members"("projectId", "userId");

-- CreateIndex
CREATE INDEX "buildq_documents_projectId_kind_idx" ON "buildq_documents"("projectId", "kind");

-- CreateIndex
CREATE INDEX "buildq_documents_orgId_idx" ON "buildq_documents"("orgId");

-- CreateIndex
CREATE INDEX "buildq_analysis_jobs_documentId_idx" ON "buildq_analysis_jobs"("documentId");

-- CreateIndex
CREATE INDEX "buildq_analysis_jobs_status_idx" ON "buildq_analysis_jobs"("status");

-- CreateIndex
CREATE INDEX "buildq_detected_elements_documentId_idx" ON "buildq_detected_elements"("documentId");

-- CreateIndex
CREATE INDEX "buildq_measurements_projectId_idx" ON "buildq_measurements"("projectId");

-- CreateIndex
CREATE INDEX "buildq_measurements_documentId_idx" ON "buildq_measurements"("documentId");

-- CreateIndex
CREATE INDEX "buildq_boq_revisions_projectId_idx" ON "buildq_boq_revisions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_boq_revisions_projectId_version_key" ON "buildq_boq_revisions"("projectId", "version");

-- CreateIndex
CREATE INDEX "buildq_boq_items_revisionId_sortOrder_idx" ON "buildq_boq_items"("revisionId", "sortOrder");

-- CreateIndex
CREATE INDEX "buildq_boq_items_projectId_idx" ON "buildq_boq_items"("projectId");

-- CreateIndex
CREATE INDEX "buildq_variations_projectId_idx" ON "buildq_variations"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_variations_projectId_code_key" ON "buildq_variations"("projectId", "code");

-- CreateIndex
CREATE INDEX "buildq_rates_region_category_idx" ON "buildq_rates"("region", "category");

-- CreateIndex
CREATE INDEX "buildq_rates_orgId_idx" ON "buildq_rates"("orgId");

-- CreateIndex
CREATE INDEX "buildq_rate_history_rateId_recordedAt_idx" ON "buildq_rate_history"("rateId", "recordedAt");

-- CreateIndex
CREATE INDEX "buildq_cost_lines_orgId_idx" ON "buildq_cost_lines"("orgId");

-- CreateIndex
CREATE INDEX "buildq_cost_lines_projectId_idx" ON "buildq_cost_lines"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_vendors_name_key" ON "buildq_vendors"("name");

-- CreateIndex
CREATE INDEX "buildq_vendors_category_idx" ON "buildq_vendors"("category");

-- CreateIndex
CREATE INDEX "buildq_vendor_products_vendorId_idx" ON "buildq_vendor_products"("vendorId");

-- CreateIndex
CREATE INDEX "buildq_vendor_unlocks_orgId_idx" ON "buildq_vendor_unlocks"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_vendor_unlocks_orgId_vendorId_key" ON "buildq_vendor_unlocks"("orgId", "vendorId");

-- CreateIndex
CREATE INDEX "buildq_saved_prices_orgId_idx" ON "buildq_saved_prices"("orgId");

-- CreateIndex
CREATE INDEX "buildq_reports_orgId_idx" ON "buildq_reports"("orgId");

-- CreateIndex
CREATE INDEX "buildq_notifications_orgId_idx" ON "buildq_notifications"("orgId");

-- CreateIndex
CREATE INDEX "buildq_notifications_userId_idx" ON "buildq_notifications"("userId");

-- CreateIndex
CREATE INDEX "buildq_activity_events_orgId_createdAt_idx" ON "buildq_activity_events"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "buildq_activity_events_projectId_idx" ON "buildq_activity_events"("projectId");

-- CreateIndex
CREATE INDEX "buildq_assistant_threads_orgId_idx" ON "buildq_assistant_threads"("orgId");

-- CreateIndex
CREATE INDEX "buildq_assistant_threads_userId_idx" ON "buildq_assistant_threads"("userId");

-- CreateIndex
CREATE INDEX "buildq_assistant_messages_threadId_createdAt_idx" ON "buildq_assistant_messages"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "buildq_regions_name_key" ON "buildq_regions"("name");

-- AddForeignKey
ALTER TABLE "buildq_users" ADD CONSTRAINT "buildq_users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_team_invitations" ADD CONSTRAINT "buildq_team_invitations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_subscriptions" ADD CONSTRAINT "buildq_subscriptions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_payments" ADD CONSTRAINT "buildq_payments_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_projects" ADD CONSTRAINT "buildq_projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_project_members" ADD CONSTRAINT "buildq_project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_project_members" ADD CONSTRAINT "buildq_project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "buildq_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_documents" ADD CONSTRAINT "buildq_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_documents" ADD CONSTRAINT "buildq_documents_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_documents" ADD CONSTRAINT "buildq_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_analysis_jobs" ADD CONSTRAINT "buildq_analysis_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "buildq_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_detected_elements" ADD CONSTRAINT "buildq_detected_elements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "buildq_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_measurements" ADD CONSTRAINT "buildq_measurements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "buildq_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_measurements" ADD CONSTRAINT "buildq_measurements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_measurements" ADD CONSTRAINT "buildq_measurements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_boq_revisions" ADD CONSTRAINT "buildq_boq_revisions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_boq_revisions" ADD CONSTRAINT "buildq_boq_revisions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_boq_items" ADD CONSTRAINT "buildq_boq_items_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "buildq_boq_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_boq_items" ADD CONSTRAINT "buildq_boq_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_variations" ADD CONSTRAINT "buildq_variations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_variations" ADD CONSTRAINT "buildq_variations_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_variations" ADD CONSTRAINT "buildq_variations_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_rates" ADD CONSTRAINT "buildq_rates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_rate_history" ADD CONSTRAINT "buildq_rate_history_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "buildq_rates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_cost_lines" ADD CONSTRAINT "buildq_cost_lines_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_cost_lines" ADD CONSTRAINT "buildq_cost_lines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_vendors" ADD CONSTRAINT "buildq_vendors_ownerOrgId_fkey" FOREIGN KEY ("ownerOrgId") REFERENCES "buildq_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_vendor_products" ADD CONSTRAINT "buildq_vendor_products_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "buildq_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_vendor_unlocks" ADD CONSTRAINT "buildq_vendor_unlocks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_vendor_unlocks" ADD CONSTRAINT "buildq_vendor_unlocks_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "buildq_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_vendor_unlocks" ADD CONSTRAINT "buildq_vendor_unlocks_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "buildq_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_saved_prices" ADD CONSTRAINT "buildq_saved_prices_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_saved_prices" ADD CONSTRAINT "buildq_saved_prices_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "buildq_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_reports" ADD CONSTRAINT "buildq_reports_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_reports" ADD CONSTRAINT "buildq_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_notifications" ADD CONSTRAINT "buildq_notifications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_notifications" ADD CONSTRAINT "buildq_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "buildq_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_activity_events" ADD CONSTRAINT "buildq_activity_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_activity_events" ADD CONSTRAINT "buildq_activity_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_activity_events" ADD CONSTRAINT "buildq_activity_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_assistant_threads" ADD CONSTRAINT "buildq_assistant_threads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "buildq_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_assistant_threads" ADD CONSTRAINT "buildq_assistant_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "buildq_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_assistant_threads" ADD CONSTRAINT "buildq_assistant_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "buildq_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildq_assistant_messages" ADD CONSTRAINT "buildq_assistant_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "buildq_assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

