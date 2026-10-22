-- Listings were saved with the placeholder poster name "You", which then showed
-- on the public listing page and in the admin panel. Replace it with the
-- owner's real name and avatar. New listings store the real name directly.

UPDATE "Property" AS p
SET "agentName" = u."name", "agentAvatar" = u."avatarUrl"
FROM "User" AS u
WHERE p."ownerId" = u."id" AND p."agentName" = 'You';
