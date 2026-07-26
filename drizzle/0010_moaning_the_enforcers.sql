ALTER TABLE `content_items` ADD `clinical_candidate_kind` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `clinical_change_diff` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_items` ADD `clinical_review_status` text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_items` ADD `clinical_reviewer` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `clinical_reviewed_at` text;--> statement-breakpoint
UPDATE `content_items`
SET `clinical_review_status` = 'approved',
    `clinical_reviewer` = (SELECT `approver` FROM `clinical_approvals` WHERE `clinical_approvals`.`content_id` = `content_items`.`id` AND `clinical_approvals`.`content_version` = `content_items`.`version`),
    `clinical_reviewed_at` = (SELECT `approved_at` FROM `clinical_approvals` WHERE `clinical_approvals`.`content_id` = `content_items`.`id` AND `clinical_approvals`.`content_version` = `content_items`.`version`)
WHERE EXISTS (SELECT 1 FROM `clinical_approvals` WHERE `clinical_approvals`.`content_id` = `content_items`.`id` AND `clinical_approvals`.`content_version` = `content_items`.`version`);
