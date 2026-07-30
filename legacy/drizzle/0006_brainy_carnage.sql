CREATE TABLE `clinical_approvals` (
	`content_id` text PRIMARY KEY NOT NULL,
	`content_version` integer NOT NULL,
	`approver` text NOT NULL,
	`approved_at` text NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE cascade
);
