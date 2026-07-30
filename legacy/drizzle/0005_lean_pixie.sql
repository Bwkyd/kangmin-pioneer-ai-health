CREATE TABLE `symptom_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symptom_date` text NOT NULL,
	`sneezing` integer NOT NULL,
	`rhinorrhea` integer NOT NULL,
	`congestion` integer NOT NULL,
	`itching` integer NOT NULL,
	`total_score` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symptom_records_user_date_idx` ON `symptom_records` (`user_id`,`symptom_date`);