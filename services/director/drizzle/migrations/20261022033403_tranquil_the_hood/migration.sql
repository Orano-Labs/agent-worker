RENAME TABLE `instance` TO `deployment`;--> statement-breakpoint
ALTER TABLE `deployment` DROP FOREIGN KEY `instance_project_id_project_id_fkey`;--> statement-breakpoint
ALTER TABLE `deployment` DROP FOREIGN KEY `instance_supervisor_id_supervisor_id_fkey`;--> statement-breakpoint
ALTER TABLE `deployment` RENAME INDEX `instance_project_id_key` TO `deployment_project_id_key`;--> statement-breakpoint
ALTER TABLE `deployment` RENAME INDEX `instance_supervisor_id_idx` TO `deployment_supervisor_id_idx`;--> statement-breakpoint
ALTER TABLE `deployment` ADD CONSTRAINT `deployment_project_id_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `deployment` ADD CONSTRAINT `deployment_supervisor_id_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
