CREATE TABLE `instance` (
	`id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
	`project_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
	`supervisor_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
	`confirmed` boolean NOT NULL DEFAULT false,
	`create_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `instance_project_id_key` UNIQUE INDEX(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
	`metadata` varbinary(2048),
	`create_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`update_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`delete_time` timestamp(3),
	`resource_tier` enum('MINIMUM','STANDARD','PERFORMANCE') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'MINIMUM',
	`owner_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
	`template_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
	`supervisor_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
	`workspace` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
);
--> statement-breakpoint
CREATE TABLE `supervisor` (
	`id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
	`public_key` varbinary(128) NOT NULL,
	`metadata` varbinary(2048),
	`create_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`update_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`delete_time` timestamp(3),
	`capacity` int NOT NULL DEFAULT 8,
	`remaining_capacity` int NOT NULL DEFAULT 8,
	`owner_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
	CONSTRAINT `supervisor_public_key_key` UNIQUE INDEX(`public_key`)
);
--> statement-breakpoint
CREATE TABLE `template` (
	`id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
	`metadata` varbinary(2048),
	`status` enum('DRAFT','PUBLISHED','ARCHIVED') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'DRAFT',
	`create_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`update_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`delete_time` timestamp(3),
	`source_template_id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
	`public_key` varbinary(128) NOT NULL,
	`metadata` varbinary(2048),
	`create_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`update_time` timestamp(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`delete_time` timestamp(3),
	`disabled` boolean NOT NULL DEFAULT false,
	CONSTRAINT `user_public_key_key` UNIQUE INDEX(`public_key`)
);
--> statement-breakpoint
CREATE INDEX `instance_supervisor_id_idx` ON `instance` (`supervisor_id`);--> statement-breakpoint
ALTER TABLE `instance` ADD CONSTRAINT `instance_project_id_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `instance` ADD CONSTRAINT `instance_supervisor_id_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `project` ADD CONSTRAINT `project_owner_id_user_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `project` ADD CONSTRAINT `project_template_id_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `template`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `project` ADD CONSTRAINT `project_supervisor_id_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `supervisor` ADD CONSTRAINT `supervisor_owner_id_user_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `template` ADD CONSTRAINT `template_source_template_id_template_id_fkey` FOREIGN KEY (`source_template_id`) REFERENCES `template`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;