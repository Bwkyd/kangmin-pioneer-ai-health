CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`position` integer NOT NULL,
	`chunk_text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_chunks_source_position_idx` ON `knowledge_chunks` (`knowledge_id`,`source_version`,`position`);--> statement-breakpoint
CREATE INDEX `knowledge_chunks_source_version_idx` ON `knowledge_chunks` (`knowledge_id`,`source_version`);