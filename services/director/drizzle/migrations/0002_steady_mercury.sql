ALTER TABLE `supervisors` MODIFY COLUMN `status` enum('active','suspended','inactive') NOT NULL DEFAULT 'suspended';--> statement-breakpoint
ALTER TABLE `supervisors` ADD `delete_timestamp` timestamp;